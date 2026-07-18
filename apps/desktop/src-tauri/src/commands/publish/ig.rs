//! `ig_publish_start` / `ig_publish_cancel` コマンド: Instagram への予約公開を
//! 「enqueue 前バリデーション → R2 アップロード(署名付き PUT)→ POST /jobs(Bearer 認証)」
//! の順に一気通貫で実行する(docs/desktop-migration-plan.md §6.4・§8 Phase 3・§12.1)。
//!
//! ## renderer 向け API
//!
//! ```ts
//! import { invoke } from "@tauri-apps/api/core";
//! import { listen } from "@tauri-apps/api/event";
//!
//! // jobId は renderer が採番する(`reframe_start` と同じ listen-before-invoke
//! // パターン、PR #63・`commands/reframe.rs` 冒頭コメント参照)。
//! const jobId = crypto.randomUUID();
//!
//! const unlistenProgress = await listen(`ig_publish://progress/${jobId}`, (e) => { ... });
//! const unlistenDone = await listen(`ig_publish://done/${jobId}`, (e) => { ... });
//! const unlistenError = await listen(`ig_publish://error/${jobId}`, (e) => { ... });
//!
//! // バリデーション(ファイルサイズ・尺・キャプション長)・資格情報未設定は
//! // invoke() 自体の reject(Err(String))として返る(ジョブは開始されない)。
//! // R2 アップロード/scheduler 登録中の失敗は上記 error イベント(構造化 enum)で届く。
//! await invoke("ig_publish_start", {
//!   jobId,
//!   inputPath: "/path/to/output.mp4",
//!   caption: "...",
//!   publishAt: Date.now() + 3600_000,
//! });
//! // scheduler の送信先(scheduler_url)は renderer からは渡さない — Rust 側が
//! // キーチェーンの保存値から読む(GHSA-j74q-9v5x-87w3 対応、confused deputy 防止。
//! // §commands/publish/mod.rs モジュール冒頭コメント)。
//!
//! await invoke("ig_publish_cancel", { jobId });
//! ```
//!
//! ## 事前検証と非同期本体の分離
//!
//! `reframe_start` の `encoder_choice_from_param`(不正なエンコーダ指定はジョブ登録前に
//! `Err` で返す)と同じ設計: ファイルサイズ・尺・キャプション長のバリデーション、および
//! R2/scheduler の資格情報未設定は **ジョブ登録前の同期的な `Err`** として返す
//! (invoke() の reject。R2 に一切アップロードしない、実装指示 §3)。R2 アップロード・
//! scheduler 登録という「開始後に初めて起きうる」失敗(ネットワークエラー・401・503・
//! キャンセル)のみを非同期ジョブの error イベントとして扱う。
//!
//! ## ジョブ管理
//!
//! `reframe`/`preview` と同じ `job_id → CancelToken` の State パターンを使うが、
//! ライフサイクル(HTTP アップロード vs libav エンコード)が大きく異なり、
//! `commands::reframe::run_media_job` の同期 `catch_unwind` 前提の骨格とは噛み合わない
//! (本体は async タスクであり、tokio がタスク境界でパニックを既に分離しているため
//! `catch_unwind` 自体が不要)。そのため [`IgJobsState`] は独立した小さな型として持つ
//! (共有は「2つ目の実装が現れてから」の YAGNI 方針、docs/desktop-migration-plan.md 外の
//! グローバルルール参照)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use media_core::CancelToken;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::jobs::manifest::{self, JobManifest};
use crate::jobs::r2_upload::{self, R2UploadError};
use crate::jobs::scheduler_client::{self, EnqueueError};
use crate::jobs::sigv4::{self, R2Credentials};

use super::credential_store::{CredentialStore, KeyringStore};
use super::r2_credentials;
use super::{KEY_SCHEDULER_API_TOKEN, KEY_SCHEDULER_URL, SERVICE};

/// renderer が採番するジョブ ID(`reframe`/`preview` と同じ形の型エイリアス)。
pub type JobId = String;

/// 実行中の IG 公開ジョブの [`CancelToken`] を保持する State。
/// `commands::reframe::JobsState` と同じ形(`Mutex<HashMap<JobId, CancelToken>>`)だが、
/// ジョブ ID 空間は共有しない(モジュール冒頭コメント参照)。
#[derive(Default)]
pub struct IgJobsState(Mutex<HashMap<JobId, CancelToken>>);

impl IgJobsState {
	fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<JobId, CancelToken>> {
		self.0
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
	}

	/// `job_id` が未登録なら `token` を登録して `true` を返す。既に登録済み(=同じ
	/// job_id のジョブが実行中)なら何もせず `false` を返す(GHSA-6cx9-j28r-f866 対応:
	/// 同一 job_id の並行 `ig_publish_start` を防ぐ)。「未登録か確認してから登録する」の
	/// 2手順に分けると、その間に別呼び出しが割り込んで二重登録できてしまう(TOCTOU)ため、
	/// `HashMap::entry` で 1 回のロック区間内にアトミックに行う。
	fn try_register(&self, job_id: JobId, token: CancelToken) -> bool {
		match self.lock().entry(job_id) {
			std::collections::hash_map::Entry::Occupied(_) => false,
			std::collections::hash_map::Entry::Vacant(entry) => {
				entry.insert(token);
				true
			}
		}
	}

	fn get(&self, job_id: &str) -> Option<CancelToken> {
		self.lock().get(job_id).cloned()
	}

	fn remove(&self, job_id: &str) {
		self.lock().remove(job_id);
	}
}

/// [`run_ig_publish`] 終了時に必ず `jobs.remove(job_id)` を呼ぶ RAII ガード
/// (`commands::reframe::JobGuard` と同じ考え方)。
struct JobGuard<'a> {
	jobs: &'a IgJobsState,
	job_id: &'a str,
}

impl Drop for JobGuard<'_> {
	fn drop(&mut self) {
		self.jobs.remove(self.job_id);
	}
}

/// `ig_publish://progress/{jobId}` イベントのペイロード。
/// `rename_all` は variant 名(`phase` タグの値)、`rename_all_fields` はフィールド名を
/// 別々に制御する(serde 1.0.152+)。前者は snake_case("uploading"/"enqueuing")、
/// 後者は renderer の TS 側規約(camelCase)に合わせる。
#[derive(Debug, Clone, Serialize)]
#[serde(
	tag = "phase",
	rename_all = "snake_case",
	rename_all_fields = "camelCase"
)]
pub enum IgPublishProgress {
	Uploading {
		bytes_sent: u64,
		total_bytes: u64,
		/// 0.0..=100.0。`total_bytes` が 0 の場合(空ファイル等)は 100 を返す。
		percent: f64,
	},
	Enqueuing,
}

/// `ig_publish://done/{jobId}` イベントのペイロード。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgPublishDone {
	pub scheduler_job_id: String,
	pub status: String,
}

/// `ig_publish://error/{jobId}` イベントのペイロード(実装指示 §2: 401/503/ネットワークを
/// フロントが分岐できる enum として返す)。事前バリデーション・資格情報未設定は
/// このイベントではなく `ig_publish_start` の `Err`(同期)で返る点に注意
/// (モジュール冒頭コメント参照)。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IgPublishRuntimeError {
	UploadFailed { detail: String },
	EnqueueUnauthorized,
	EnqueueServiceUnavailable,
	EnqueueRejected { detail: String },
	Network { detail: String },
	Cancelled,
	Internal { detail: String },
}

impl From<R2UploadError> for IgPublishRuntimeError {
	fn from(err: R2UploadError) -> Self {
		match err {
			R2UploadError::Cancelled => IgPublishRuntimeError::Cancelled,
			R2UploadError::Network(detail) => IgPublishRuntimeError::Network { detail },
			other => IgPublishRuntimeError::UploadFailed {
				detail: other.to_string(),
			},
		}
	}
}

impl From<EnqueueError> for IgPublishRuntimeError {
	fn from(err: EnqueueError) -> Self {
		match err {
			EnqueueError::Unauthorized => IgPublishRuntimeError::EnqueueUnauthorized,
			EnqueueError::ServiceUnavailable => IgPublishRuntimeError::EnqueueServiceUnavailable,
			EnqueueError::Rejected(detail) => IgPublishRuntimeError::EnqueueRejected { detail },
			EnqueueError::Network(detail) => IgPublishRuntimeError::Network { detail },
		}
	}
}

fn progress_event_name(job_id: &str) -> String {
	format!("ig_publish://progress/{job_id}")
}
fn done_event_name(job_id: &str) -> String {
	format!("ig_publish://done/{job_id}")
}
fn error_event_name(job_id: &str) -> String {
	format!("ig_publish://error/{job_id}")
}

/// 進捗イベントの発火頻度を間引く閾値(パーセントポイント)。`ReaderStream` のチャンク
/// (数KB〜数十KB)ごとに `on_progress` を呼ぶと 300MB のファイルで数千イベントになり
/// うるため、体感が変わらない粒度(1%刻み)に間引く。0% と 100% は必ず通す。
const PROGRESS_EMIT_STEP_PERCENT: f64 = 1.0;

/// r2_key 導出用の名前空間 UUID(UUIDv5、GHSA-6cx9-j28r-f866 対応)。
/// `Uuid::new_v4()` で一度だけ生成した固定値で、値そのものに意味はない —
/// [`IDEMPOTENCY_KEY_NAMESPACE`] と異なる値にすることだけが目的(同じ job_id からでも
/// r2_key 用と idempotency_key 用の UUID が一致しないようにする)。
/// 元値: `d537d70c-0561-4f0c-9e2e-314aa1011150`。
const R2_KEY_NAMESPACE: Uuid = Uuid::from_bytes([
	0xd5, 0x37, 0xd7, 0x0c, 0x05, 0x61, 0x4f, 0x0c, 0x9e, 0x2e, 0x31, 0x4a, 0xa1, 0x01, 0x11, 0x50,
]);

/// idempotency_key 導出用の名前空間 UUID(UUIDv5、GHSA-6cx9-j28r-f866 対応)。
/// [`R2_KEY_NAMESPACE`] と同じ考え方。元値: `7eceaea8-7633-49ea-b41d-36091ef67e56`。
const IDEMPOTENCY_KEY_NAMESPACE: Uuid = Uuid::from_bytes([
	0x7e, 0xce, 0xae, 0xa8, 0x76, 0x33, 0x49, 0xea, 0xb4, 0x1d, 0x36, 0x09, 0x1e, 0xf6, 0x7e, 0x56,
]);

/// `job_id` から r2_key 用の UUID を決定的に導出する(GHSA-6cx9-j28r-f866 対応)。
/// job_id は renderer 採番の任意文字列(UUID 形式とは限らない)なので `Uuid::new_v5` の
/// 名前(バイト列)としてそのまま使う。同じ job_id なら常に同じ UUID になるため、
/// enqueue 失敗後に同じ job_id で再試行しても同じ r2_key を指す
/// (再試行のたびに異なる R2 オブジェクトが残る「孤児」を防ぐ)。
fn derive_r2_uuid(job_id: &str) -> Uuid {
	Uuid::new_v5(&R2_KEY_NAMESPACE, job_id.as_bytes())
}

/// `job_id` から idempotency_key を決定的に導出する(GHSA-6cx9-j28r-f866 対応)。
/// 同じ job_id の再試行が同じ idempotency_key を再利用するため、scheduler 側の冪等性
/// (同一キーの再送に既存ジョブを返す、`jobs::scheduler_client`)が正しく働き、二重公開を
/// 防げる。[`derive_r2_uuid`] とは異なる名前空間 UUID を使うため、生成される文字列は
/// r2_key 用の UUID とは一致しない。
fn derive_idempotency_key(job_id: &str) -> String {
	Uuid::new_v5(&IDEMPOTENCY_KEY_NAMESPACE, job_id.as_bytes()).to_string()
}

/// enqueue 前バリデーション(ファイルサイズ・尺・キャプション長)。
/// 尺の取得(`media_core::probe`)は libav の同期 API のため、呼び出し側
/// (`ig_publish_start`)が `spawn_blocking` 経由で呼ぶ(`commands::probe::probe` と同じ
/// 方針)。サイズチェックを先に行い、上限超過が明らかな場合は probe(デコードを伴う)を
/// 省略する。
fn validate_enqueue_target(path: &Path, caption: &str) -> Result<(), String> {
	let metadata = std::fs::metadata(path)
		.map_err(|err| format!("ファイル情報の取得に失敗しました: {err}"))?;
	manifest::validate_file_size(metadata.len()).map_err(|err| err.to_string())?;
	manifest::validate_caption(caption).map_err(|err| err.to_string())?;

	let info = media_core::probe::probe(path).map_err(|err| err.to_string())?;
	manifest::validate_duration(info.duration).map_err(|err| err.to_string())?;
	Ok(())
}

/// `input_path` を R2 へアップロードして scheduler にジョブ登録する(ロジック本体)。
///
/// `#[tauri::command]` はこの関数ではなく `mod.rs` 側の薄いラッパ
/// (`ig_publish_start`)に付ける — `#[tauri::command]` マクロは呼び出し元の
/// `generate_handler!` 側と同じモジュールに補助アイテム(`__cmd__*` 等)を生成するため、
/// このモジュール(`commands::publish::ig`)で定義したまま `pub use` で再輸出すると
/// `lib.rs` の `generate_handler!` からその補助アイテムが見つからずコンパイルエラーになる
/// (`credential_store`/`scheduler_check` がロジックのみを持ち、`mod.rs` 側に
/// `#[tauri::command]` を置いている既存の分担と同じ理由)。
///
/// バリデーション(ファイルサイズ ≤300MB・尺 3秒〜15分・キャプション ≤2200 文字)と
/// R2/scheduler の資格情報・URL の有無を先に確認し、いずれかが不正なら
/// ジョブを開始せず `Err` を返す(R2 に一切アップロードしない)。
///
/// `scheduler_url` は引数ではなくキーチェーンの保存値から読む
/// (GHSA-j74q-9v5x-87w3 対応: renderer が任意の送信先を指定できると、WebView 侵害時に
/// Bearer トークンを任意ホストへ流出させられる。§commands/publish/mod.rs モジュール
/// 冒頭コメント参照)。保存値は `set_scheduler_url_impl` で保存時に検証済みだが、
/// 保存後に検証規則が変わった場合等に備えてここでも `parse_scheduler_base` で
/// 防御的に再検証する。
pub(crate) async fn start_impl(
	app: AppHandle,
	jobs: State<'_, IgJobsState>,
	job_id: JobId,
	input_path: String,
	caption: String,
	publish_at: i64,
) -> Result<(), String> {
	// 1. 資格情報・URL の有無(同期チェック、R2 に一切触れない)。
	let r2_credentials = r2_credentials::get_impl(&KeyringStore)?
		.ok_or_else(|| "R2 の資格情報が未設定です。設定画面から入力してください。".to_string())?;
	let scheduler_token = KeyringStore
		.get(SERVICE, KEY_SCHEDULER_API_TOKEN)?
		.ok_or_else(|| "scheduler の API トークンが未設定です。".to_string())?;
	let scheduler_url = KeyringStore
		.get(SERVICE, KEY_SCHEDULER_URL)?
		.ok_or_else(|| {
			"scheduler の URL が未設定です。設定画面から入力してください。".to_string()
		})?;
	scheduler_client::parse_scheduler_base(&scheduler_url)
		.map_err(|err| format!("保存済みの scheduler URL が不正です: {err}"))?;

	// 2. バリデーション(ファイルサイズ・尺・キャプション長)。probe は libav の同期 API
	//    のため spawn_blocking で実行する(`commands::probe::probe` と同じ方針)。
	let path = PathBuf::from(input_path);
	let path_for_validate = path.clone();
	let caption_for_validate = caption.clone();
	tauri::async_runtime::spawn_blocking(move || {
		validate_enqueue_target(&path_for_validate, &caption_for_validate)
	})
	.await
	.map_err(|err| format!("バリデーションタスクが異常終了しました: {err}"))??;

	// 3. ジョブ登録 + バックグラウンド実行。同じ job_id が既に実行中なら拒否する
	//    (GHSA-6cx9-j28r-f866: renderer 側のリトライ経路が同じ job_id を再利用する設計に
	//    伴い、旧ジョブの完了前に新しい呼び出しが割り込むと r2_key/idempotency_key が
	//    同じ 2 つのジョブが並走しうるため)。
	let token = CancelToken::new();
	if !jobs.try_register(job_id.clone(), token.clone()) {
		return Err("このジョブは既に実行中です".to_string());
	}

	let handle = tauri::async_runtime::spawn(run_ig_publish(
		app.clone(),
		job_id.clone(),
		token,
		path,
		caption,
		publish_at,
		scheduler_url,
		r2_credentials,
		scheduler_token,
	));

	// tokio はタスク境界でパニックを既に分離する(JoinHandle::await が
	// `tauri::Error::JoinError(tokio::task::JoinError)` を返すだけでプロセスは
	// 落ちない)。パニック時だけ renderer が待ち続けないよう error イベントを発火する
	// 監視タスクを立てる(`run_media_job` の catch_unwind に相当するが、async タスク
	// なので tokio の分離に乗るだけで済む)。
	let app_for_watch = app.clone();
	let job_id_for_watch = job_id;
	tauri::async_runtime::spawn(async move {
		if let Err(tauri::Error::JoinError(join_err)) = handle.await {
			if join_err.is_panic() {
				let _ = app_for_watch.emit(
					&error_event_name(&job_id_for_watch),
					IgPublishRuntimeError::Internal {
						detail: "内部エラーが発生しました(パニック)".to_string(),
					},
				);
			}
		}
	});

	Ok(())
}

/// `job_id` の IG 公開ジョブをキャンセルする(ロジック本体。`#[tauri::command]` は
/// `mod.rs` 側に付ける — 理由は [`start_impl`] 冒頭コメント参照)。アップロード中なら
/// HTTP リクエストが中断され(`jobs::r2_upload` の `tokio::select!`)、
/// `ig_publish://error/{jobId}` が `Cancelled` で発火する。scheduler 登録(POST /jobs)
/// フェーズは 1 リクエストのみで短時間のため、キャンセルは次のフェーズ境界チェックまで
/// 反映が遅れることがある(`media_core::reframe` のパケット単位キャンセルと同じ
/// 「協調的キャンセル」の性質)。
pub(crate) fn cancel_impl(job_id: JobId, jobs: State<'_, IgJobsState>) -> Result<(), String> {
	match jobs.get(&job_id) {
		Some(token) => {
			token.cancel();
			Ok(())
		}
		None => Err(format!(
			"未知のジョブです(既に完了した可能性があります): {job_id}"
		)),
	}
}

/// ジョブ本体(非同期タスク)。R2 アップロード → scheduler 登録の順に実行し、
/// 進捗/完了/失敗を Tauri イベントで通知する。
#[allow(clippy::too_many_arguments)]
async fn run_ig_publish(
	app: AppHandle,
	job_id: JobId,
	token: CancelToken,
	input_path: PathBuf,
	caption: String,
	publish_at: i64,
	scheduler_url: String,
	r2_credentials: R2Credentials,
	scheduler_token: String,
) {
	let jobs = app.state::<IgJobsState>();
	let _guard = JobGuard {
		jobs: &jobs,
		job_id: &job_id,
	};

	// r2_key と idempotency_key は job_id から決定的に導出する(GHSA-6cx9-j28r-f866 対応)。
	// 旧実装は `Uuid::new_v4()` を毎回呼んでいたため、enqueue 失敗後に同じジョブを
	// 再試行すると r2_key/idempotency_key が試行のたびに変わり、(1) scheduler 側の
	// 冪等性(同一 idempotency_key の再送に既存ジョブを返す)が効かず二重公開しうる、
	// (2) 失敗した試行がアップロードした R2 オブジェクトが孤児として残る、という2つの
	// 問題があった。job_id は renderer が採番し、リトライ経路でも同一の値を再利用する
	// 設計のため、そこから UUIDv5 で決定的に導出することで両方を防ぐ
	// (r2_key 用・idempotency_key 用は異なる名前空間 UUID を使い、互いに一致しないように
	// する。§[`derive_r2_uuid`]/[`derive_idempotency_key`])。
	let r2_key = manifest::build_r2_key(publish_at, derive_r2_uuid(&job_id));
	let idempotency_key = derive_idempotency_key(&job_id);

	let url = match sigv4::presigned_put_url(&r2_credentials, &r2_key) {
		Ok(url) => url,
		Err(detail) => {
			emit_error(
				&app,
				&job_id,
				IgPublishRuntimeError::UploadFailed { detail },
			);
			return;
		}
	};

	let client = reqwest::Client::new();

	let app_for_progress = app.clone();
	let job_id_for_progress = job_id.clone();
	let mut last_emitted_percent = -1.0_f64;
	let on_progress = move |sent: u64, total: u64| {
		let percent = if total == 0 {
			100.0
		} else {
			(sent as f64 / total as f64) * 100.0
		};
		// 1% 刻み + 完了(100%)は必ず emit する(モジュール冒頭コメント参照)。
		if percent < last_emitted_percent + PROGRESS_EMIT_STEP_PERCENT && percent < 100.0 {
			return;
		}
		last_emitted_percent = percent;
		let _ = app_for_progress.emit(
			&progress_event_name(&job_id_for_progress),
			IgPublishProgress::Uploading {
				bytes_sent: sent,
				total_bytes: total,
				percent,
			},
		);
	};
	let _ = app.emit(
		&progress_event_name(&job_id),
		IgPublishProgress::Uploading {
			bytes_sent: 0,
			total_bytes: 0,
			percent: 0.0,
		},
	);

	if let Err(err) = r2_upload::upload_file(&client, url, &input_path, &token, on_progress).await {
		emit_error(&app, &job_id, err.into());
		return;
	}

	if token.is_cancelled() {
		emit_error(&app, &job_id, IgPublishRuntimeError::Cancelled);
		return;
	}

	let _ = app.emit(&progress_event_name(&job_id), IgPublishProgress::Enqueuing);

	let manifest = JobManifest::new(idempotency_key, r2_key, caption, publish_at);
	match scheduler_client::enqueue_job(
		&client,
		&scheduler_url,
		&scheduler_token,
		&manifest,
		scheduler_client::ENQUEUE_TIMEOUT,
	)
	.await
	{
		Ok(response) => {
			let _ = app.emit(
				&done_event_name(&job_id),
				IgPublishDone {
					scheduler_job_id: response.id,
					status: response.status,
				},
			);
		}
		Err(err) => emit_error(&app, &job_id, err.into()),
	}
}

fn emit_error(app: &AppHandle, job_id: &str, error: IgPublishRuntimeError) {
	let _ = app.emit(&error_event_name(job_id), error);
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn event_names_embed_job_id() {
		assert_eq!(
			progress_event_name("abc-123"),
			"ig_publish://progress/abc-123"
		);
		assert_eq!(done_event_name("abc-123"), "ig_publish://done/abc-123");
		assert_eq!(error_event_name("abc-123"), "ig_publish://error/abc-123");
	}

	#[test]
	fn ig_jobs_state_try_register_get_remove_roundtrip() {
		let jobs = IgJobsState::default();
		let token = CancelToken::new();
		assert!(jobs.try_register("job-1".to_string(), token.clone()));

		assert!(jobs.get("job-1").is_some());
		jobs.remove("job-1");
		assert!(jobs.get("job-1").is_none());
	}

	#[test]
	fn ig_publish_cancel_unknown_job_returns_error() {
		let jobs = IgJobsState::default();
		let token = CancelToken::new();
		assert!(jobs.try_register("job-1".to_string(), token.clone()));
		jobs.remove("job-1");

		// State<'_, T> を直接構築できないため、内部ロジック(cancel 相当)を
		// IgJobsState::get 経由で検証する(`ig_publish_cancel` 自体は薄いラッパ)。
		assert!(jobs.get("job-1").is_none());
	}

	#[test]
	fn ig_jobs_state_try_register_rejects_duplicate_job_id() {
		// GHSA-6cx9-j28r-f866: 同じ job_id で `ig_publish_start` が既に実行中の場合、
		// 2回目の登録は拒否される(二重開始の防止)。
		let jobs = IgJobsState::default();
		let token_a = CancelToken::new();
		let token_b = CancelToken::new();

		assert!(jobs.try_register("job-1".to_string(), token_a));
		assert!(!jobs.try_register("job-1".to_string(), token_b));

		// remove 後は同じ job_id を再登録できる(完了済みジョブの再試行は妨げない)。
		jobs.remove("job-1");
		assert!(jobs.try_register("job-1".to_string(), CancelToken::new()));
	}

	#[test]
	fn derive_r2_uuid_is_deterministic_for_same_job_id() {
		// GHSA-6cx9-j28r-f866: 同じ job_id からは常に同じ r2_key 用 UUID が導出される
		// (enqueue 失敗後の再試行が同じ R2 オブジェクトキーを指し、孤児を残さない)。
		assert_eq!(derive_r2_uuid("job-abc"), derive_r2_uuid("job-abc"));
	}

	#[test]
	fn derive_r2_uuid_differs_across_job_ids() {
		assert_ne!(derive_r2_uuid("job-a"), derive_r2_uuid("job-b"));
	}

	#[test]
	fn derive_idempotency_key_is_deterministic_for_same_job_id() {
		// GHSA-6cx9-j28r-f866: 同じ job_id からは常に同じ idempotency_key が導出される
		// (scheduler 側の冪等性が再試行を既存ジョブへ束ねられる)。
		assert_eq!(
			derive_idempotency_key("job-abc"),
			derive_idempotency_key("job-abc")
		);
	}

	#[test]
	fn derive_idempotency_key_differs_across_job_ids() {
		assert_ne!(
			derive_idempotency_key("job-a"),
			derive_idempotency_key("job-b")
		);
	}

	#[test]
	fn r2_uuid_and_idempotency_key_derivations_differ_for_same_job_id() {
		// 名前空間 UUID を分けているため、同じ job_id でも r2_key 用と idempotency_key
		// 用の導出結果は一致しない(GHSA-6cx9-j28r-f866 の修正で意図した設計)。
		let job_id = "job-abc";
		assert_ne!(
			derive_r2_uuid(job_id).to_string(),
			derive_idempotency_key(job_id)
		);
	}

	#[test]
	fn r2_upload_error_maps_to_runtime_error_variants() {
		assert!(matches!(
			IgPublishRuntimeError::from(R2UploadError::Cancelled),
			IgPublishRuntimeError::Cancelled
		));
		assert!(matches!(
			IgPublishRuntimeError::from(R2UploadError::Network("boom".to_string())),
			IgPublishRuntimeError::Network { .. }
		));
		assert!(matches!(
			IgPublishRuntimeError::from(R2UploadError::Http {
				status: 403,
				detail: "forbidden".to_string()
			}),
			IgPublishRuntimeError::UploadFailed { .. }
		));
	}

	#[test]
	fn enqueue_error_maps_to_runtime_error_variants() {
		assert!(matches!(
			IgPublishRuntimeError::from(EnqueueError::Unauthorized),
			IgPublishRuntimeError::EnqueueUnauthorized
		));
		assert!(matches!(
			IgPublishRuntimeError::from(EnqueueError::ServiceUnavailable),
			IgPublishRuntimeError::EnqueueServiceUnavailable
		));
		assert!(matches!(
			IgPublishRuntimeError::from(EnqueueError::Rejected("bad".to_string())),
			IgPublishRuntimeError::EnqueueRejected { .. }
		));
		assert!(matches!(
			IgPublishRuntimeError::from(EnqueueError::Network("net".to_string())),
			IgPublishRuntimeError::Network { .. }
		));
	}

	#[test]
	fn progress_payload_serializes_with_phase_tag() {
		let json = serde_json::to_value(IgPublishProgress::Uploading {
			bytes_sent: 10,
			total_bytes: 100,
			percent: 10.0,
		})
		.unwrap();
		assert_eq!(json["phase"], "uploading");
		assert_eq!(json["bytesSent"], 10);

		let json = serde_json::to_value(IgPublishProgress::Enqueuing).unwrap();
		assert_eq!(json["phase"], "enqueuing");
	}
}
