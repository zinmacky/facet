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
//!
//! // 予約公開の最終成否の追跡(アーキテクチャレビュー指摘対応)。`ig_publish_start` の
//! // done イベントは scheduler が「受理した」ことしか意味せず、実際の IG 側公開成否
//! // (published/failed)はここでは分からない。呼び出し側は done イベントの
//! // `schedulerJobId` を保持しておき、`ig_job_status` でポーリング/手動確認する。
//! const outcome = await invoke("ig_job_status", { schedulerJobId: done.schedulerJobId });
//! // outcome.outcome: "found" | "not_found" | "unauthorized" | "service_unavailable" | "network"
//! // "found" の場合のみ outcome.status: "pending" | "creating" | "processing" |
//! // "publishing" | "published" | "failed" が読める(JobRecord のフィールドが
//! // フラットに乗る。§IgJobStatusOutcome 冒頭コメント)。
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
//! `catch_unwind` 自体が不要)。そのため [`IgJobsState`] は `reframe`/`preview` とは
//! 別のジョブ ID 空間を持つ専用の型として存在する。
//!
//! `HashMap<JobId, CancelToken>` の登録/取得/削除そのものの実装は
//! [`crate::commands::job_state`] に集約されている。当初(本コメント旧版)は
//! 「共有は2つ目の実装が現れてから」の YAGNI 方針で `IgJobsState` を独立した型として
//! 持っていたが、YouTube 公開(`commands::publish::youtube`)が3つ目の実質同一実装として
//! 追加されたことに加え、GHSA-6cx9-j28r-f866 対応の `try_register`(TOCTOU 安全な
//! 二重登録拒否)が本ファイルにしか入らず reframe/preview・YouTube に伝播しなかった
//! という実害が生じたため、共通部分を `job_state` へ統一した(詳細は同モジュール冒頭
//! コメント「統一した経緯」参照)。[`IgJobsState`] 自体はジョブ ID 空間を分離するための
//! 薄い newtype として残る。

use std::path::{Path, PathBuf};

use media_core::CancelToken;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::commands::job_state;
use crate::jobs::manifest::{self, JobRecord};
use crate::jobs::r2_upload::{self, R2UploadError};
use crate::jobs::scheduler_client::{self, EnqueueError};
use crate::jobs::sigv4::{self, R2Credentials};

use super::credential_store::{CredentialStore, KeyringStore};
use super::r2_credentials;
use super::{KEY_SCHEDULER_API_TOKEN, KEY_SCHEDULER_URL, SERVICE};

/// renderer が採番するジョブ ID(`reframe`/`preview` と同じ形の型エイリアス)。
pub type JobId = job_state::JobId;

/// 実行中の IG 公開ジョブの [`CancelToken`] を保持する State。
///
/// 共通実装は [`job_state::JobsState`] に集約されており、本 struct はジョブ ID 空間を
/// `reframe`/`preview`・`youtube` と分離するための薄い newtype(`Deref` で
/// `try_register`/`get`/`cancel`/`remove` をそのまま委譲する。モジュール冒頭コメント
/// 「ジョブ管理」参照)。
#[derive(Default)]
pub struct IgJobsState(job_state::JobsState);

impl std::ops::Deref for IgJobsState {
	type Target = job_state::JobsState;

	fn deref(&self) -> &Self::Target {
		&self.0
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
			EnqueueError::Cancelled => IgPublishRuntimeError::Cancelled,
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

/// enqueue 前バリデーション(ファイルサイズ・尺・キャプション長・公開時刻)。
/// 尺の取得(`media_core::probe`)は libav の同期 API のため、呼び出し側
/// (`ig_publish_start`)が `spawn_blocking` 経由で呼ぶ(`commands::probe::probe` と同じ
/// 方針)。サイズチェックを先に行い、上限超過が明らかな場合は probe(デコードを伴う)を
/// 省略する。
///
/// `publish_at` の検証(`manifest::validate_publish_at`)は contract
/// `jobManifest.publishAt` の下限(`manifest::MIN_PUBLISH_AT_MS`、秒/ms 単位
/// 取り違えガード)と同じ基準で行う。scheduler 側の 400 応答
/// (`EnqueueError::Rejected`)に委ねず、ここで事前に弾いて通常のエラーとして返す。
fn validate_enqueue_target(path: &Path, caption: &str, publish_at: i64) -> Result<(), String> {
	manifest::validate_publish_at(publish_at).map_err(|err| err.to_string())?;

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
		validate_enqueue_target(&path_for_validate, &caption_for_validate, publish_at)
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
/// `mod.rs` 側に付ける — 理由は [`start_impl`] 冒頭コメント参照)。アップロード中
/// (`jobs::r2_upload::upload_file`)・scheduler 登録中(`jobs::scheduler_client::enqueue_job`)
/// のどちらも `tokio::select!` で `CancelToken` とレースしているため、HTTP リクエストが
/// 中断され `ig_publish://error/{jobId}` が速やかに `Cancelled` で発火する
/// (GHSA-q37v-7xpp-x229 残作業対応。旧実装は enqueue フェーズを素の `await` で待っており、
/// `ENQUEUE_TIMEOUT`(30秒)いっぱいまでキャンセルが反映されなかった)。
///
/// **注意:** enqueue リクエストが scheduler に届いた「後」にキャンセルされた場合、
/// scheduler 側には既にジョブが登録されている可能性がある(半端な状態)。
/// `idempotency_key` は job_id から決定的に導出される([`derive_idempotency_key`])ため、
/// 同じ job_id での再試行は scheduler 側の冪等性により同一ジョブへ束ねられ、二重公開は
/// しない(詳細は `jobs::scheduler_client::enqueue_job` のドキュメントコメント参照)。
pub(crate) fn cancel_impl(job_id: JobId, jobs: State<'_, IgJobsState>) -> Result<(), String> {
	jobs.cancel(&job_id)
}

/// [`job_status_impl`] の結果。`commands::publish::scheduler_check::ConnectionCheckResult`
/// と同じ設計判断: 呼び出し側(`usePublishExtras.tsx`)が分岐を必要とする結果は
/// `Result::Ok` 側のタグ付き enum とし、`Result::Err(String)` は「呼び出し自体が
/// 想定外に失敗した」場合(キーチェーン読み出し失敗・scheduler 未設定等)のみに使う。
///
/// レビュー指摘対応: 当初は `FetchJobError` を `.to_string()` で一律 `Err(String)` に
/// 潰していたが、それだと呼び出し側が「404(NotFound、恒久的に回復しない)」と
/// 「401/503/ネットワーク瞬断(一過性・再試行で回復しうる)」を区別できず、404 の場合も
/// ポーリング対象から外さず永久に再試行し続けてしまう(desktop が IG 予約投稿の
/// 最終成否を追跡しない問題の修正が別の形で再発する)。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum IgJobStatusOutcome {
	/// 取得成功。`JobRecord` のフィールドはタグ(`outcome`)と並べてフラットに
	/// シリアライズされる(internally-tagged enum の newtype variant の挙動。
	/// `JobRecord` は "outcome" というフィールドを持たないためタグと衝突しない)。
	/// `Box` は他 variant(ユニット/`{ detail: String }`)とのサイズ差を抑えるため
	/// (clippy::large_enum_variant)。`Box<T>` のシリアライズは `T` に委譲されるため
	/// JSON 表現には影響しない。
	Found(Box<JobRecord>),
	/// 指定された `scheduler_job_id` のジョブが見つからない(404)。`ig_publish_start` の
	/// done イベント(= enqueue 受理成功)の後にこれが起きるのは、ジョブが scheduler 側で
	/// 削除された等の実質的に回復不能な事象のため、呼び出し側はポーリング対象から外し
	/// 終端エラーとして扱うべき(他の一過性エラーとは区別する)。
	NotFound,
	/// Bearer トークンが scheduler 側と一致しない(401)。トークン再設定で回復しうるため
	/// `NotFound` とは区別し、呼び出し側はポーリング対象から外さない。
	Unauthorized,
	/// scheduler 側で `SCHEDULER_API_TOKEN` が未設定(503, fail-closed)。
	ServiceUnavailable,
	/// 接続不可・タイムアウト・応答解析失敗・想定外のステータスコード等の一過性エラー。
	Network { detail: String },
}

impl From<scheduler_client::FetchJobError> for IgJobStatusOutcome {
	fn from(err: scheduler_client::FetchJobError) -> Self {
		use scheduler_client::FetchJobError;
		match err {
			FetchJobError::Unauthorized => IgJobStatusOutcome::Unauthorized,
			FetchJobError::ServiceUnavailable => IgJobStatusOutcome::ServiceUnavailable,
			FetchJobError::NotFound => IgJobStatusOutcome::NotFound,
			FetchJobError::Network(detail) => IgJobStatusOutcome::Network { detail },
		}
	}
}

/// `scheduler_job_id`(`IgPublishDone.scheduler_job_id`。scheduler が発行したジョブ ID)の
/// 現在の状態を scheduler から取得する(ロジック本体。`#[tauri::command]` は `mod.rs` 側に
/// 付ける — 理由は [`start_impl`] 冒頭コメント参照)。
///
/// desktop が IG 予約投稿の最終成否を追跡しない問題(アーキテクチャレビュー指摘)への
/// 対応で追加した。`ig_publish_start` の done イベントは「scheduler がジョブ登録を
/// 受理した」ことまでしか保証せず、その後の IG 側公開(published/failed)は本コマンドで
/// 別途確認する必要がある(§本モジュール冒頭コメント renderer 向け API)。
///
/// `start_impl` と同様、scheduler の URL・トークンはここでキーチェーンの保存値からのみ
/// 読む(renderer から受け取らない。GHSA-j74q-9v5x-87w3 対応)。`Result::Err(String)` は
/// キーチェーン未設定等の想定外ケースのみ(§[`IgJobStatusOutcome`] 冒頭コメント)。
pub(crate) async fn job_status_impl(
	scheduler_job_id: String,
) -> Result<IgJobStatusOutcome, String> {
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

	let client = reqwest::Client::new();
	let outcome = match scheduler_client::fetch_job(
		&client,
		&scheduler_url,
		&scheduler_token,
		&scheduler_job_id,
		scheduler_client::FETCH_JOB_TIMEOUT,
	)
	.await
	{
		Ok(record) => IgJobStatusOutcome::Found(Box::new(record)),
		Err(err) => err.into(),
	};
	Ok(outcome)
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
	let _guard = job_state::JobGuard::new(&jobs, &job_id);

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

	let manifest = manifest::new_job_manifest(idempotency_key, r2_key, caption, publish_at);
	match scheduler_client::enqueue_job(
		&client,
		&scheduler_url,
		&scheduler_token,
		&manifest,
		scheduler_client::ENQUEUE_TIMEOUT,
		&token,
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
		// `cancel_impl` は `jobs.cancel(&job_id)`(`job_state::JobsState::cancel`)への
		// 薄いラッパのため、`State<'_, T>` を構築せずここで直接検証できる。
		let jobs = IgJobsState::default();
		let token = CancelToken::new();
		assert!(jobs.try_register("job-1".to_string(), token.clone()));
		jobs.remove("job-1");

		assert!(jobs.cancel("job-1").is_err());
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

	// ---- 契約スキーマとの整合性検証(Issue #93 パート B) --------------------------------
	//
	// `IgPublishProgress`/`IgPublishDone`/`IgPublishRuntimeError` は Rust→renderer 専用の
	// Tauri イベントペイロードで、対応する TS 側の手書き型は無い(`igPublish.ts` は
	// `@facet/contract` の `z.infer` から型を導出する形にした、パート B-2)。
	//
	// **typify によるコード生成は見送る**(パート B-3 の指示通り)。理由:
	// `IgPublishProgress`/`IgPublishRuntimeError` は internally-tagged enum
	// (`#[serde(tag = "phase"/"kind")]`)だが、`generate-schema.mjs` が出力する素の
	// JSON Schema は discriminated union を `anyOf`(各分岐が `const` フィールドを持つ
	// ただの oneOf 相当)としてしか表現できない(OpenAPI の `discriminator` 拡張が無い
	// ため)。typify はこの形から「これは `tag` フィールドで判別する enum だ」と
	// 自動認識できず、`subtype0`/`subtype1`... のような無意味な分岐名を持つ enum を
	// 生成してしまい、Rust 側の internally-tagged 表現(`{"phase":"uploading",...}` の
	// フラットな JSON)を再現できない。typify にこの構造を正しく生成させるには
	// スキーマ側に手を入れる(zod 側で構造を変える、または生成後にパッチする)必要が
	// あり、Rust→renderer 専用のイベント(scheduler との HTTP 境界のような複数言語間の
	// 真の共有契約ではない)にそこまでのコストを払う価値は薄いと判断した。
	// 代わりに #112 の流儀(`jobs/manifest.rs` のスキーマ整合テスト)を踏襲し、
	// 生成コードを介さず `serde_json` のみで直接 JSON Schema と突き合わせる
	// (新規依存を増やさない)。
	//
	// 検証範囲: タグ名(`phase`/`kind`)・各 variant のタグ値・フィールド名・型が
	// `packages/contract/schema/ig-publish-events.json` と一致すること。

	use std::collections::BTreeSet;

	/// `packages/contract/schema/ig-publish-events.json` の内容そのもの。ワークスペース外
	/// のファイルを参照するため、`include_str!` のパスは `CARGO_MANIFEST_DIR` ではなく
	/// 本ソースファイルからの相対パスになる点に注意(`jobs/manifest.rs` と同じ流儀)。
	const IG_PUBLISH_EVENTS_SCHEMA_JSON: &str =
		include_str!("../../../../../../packages/contract/schema/ig-publish-events.json");

	fn contract_schema() -> serde_json::Value {
		serde_json::from_str(IG_PUBLISH_EVENTS_SCHEMA_JSON)
			.expect("packages/contract/schema/ig-publish-events.json must be valid JSON")
	}

	fn schema_def<'a>(schema: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
		schema
			.get("$defs")
			.and_then(|defs| defs.get(name))
			.unwrap_or_else(|| panic!("契約スキーマに $defs.{name} が見つかりません"))
	}

	fn json_type_name(value: &serde_json::Value) -> &'static str {
		match value {
			serde_json::Value::Null => "null",
			serde_json::Value::Bool(_) => "boolean",
			serde_json::Value::Number(n) => {
				if n.is_i64() || n.is_u64() {
					"integer"
				} else {
					"number"
				}
			}
			serde_json::Value::String(_) => "string",
			serde_json::Value::Array(_) => "array",
			serde_json::Value::Object(_) => "object",
		}
	}

	/// 単一オブジェクトスキーマ(`properties`/`required`)に対して `actual` を照合する
	/// (`jobs::manifest` の同名ロジックの簡易版。本契約で使う `const`/`type` のみ対応)。
	fn assert_object_matches_schema(
		object_schema: &serde_json::Value,
		actual: &serde_json::Value,
		path: &str,
	) {
		let properties = object_schema["properties"]
			.as_object()
			.unwrap_or_else(|| panic!("{path}: properties が object ではない"));
		let required: BTreeSet<&str> = object_schema["required"]
			.as_array()
			.unwrap_or_else(|| panic!("{path}: required が array ではない"))
			.iter()
			.map(|v| v.as_str().unwrap())
			.collect();
		let actual_obj = actual
			.as_object()
			.unwrap_or_else(|| panic!("{path}: シリアライズ結果が object ではない"));

		let actual_keys: BTreeSet<&str> = actual_obj.keys().map(String::as_str).collect();
		let schema_keys: BTreeSet<&str> = properties.keys().map(String::as_str).collect();
		assert_eq!(
			actual_keys, schema_keys,
			"{path}: キー集合が契約スキーマと不一致"
		);
		for key in &required {
			assert!(
				actual_obj.contains_key(*key),
				"{path}.{key} は契約上 required だが出力に無い"
			);
		}

		for (key, field_schema) in properties {
			let value = &actual_obj[key];
			if let Some(const_value) = field_schema.get("const") {
				assert_eq!(value, const_value, "{path}.{key}: const と不一致");
				continue;
			}
			let type_field = field_schema
				.get("type")
				.unwrap_or_else(|| panic!("{path}.{key}: const/type のいずれも無い"));
			let allowed_types: Vec<&str> = match type_field {
				serde_json::Value::String(s) => vec![s.as_str()],
				serde_json::Value::Array(arr) => arr.iter().map(|v| v.as_str().unwrap()).collect(),
				_ => panic!("{path}.{key}: type フィールドの形式が不正: {type_field:?}"),
			};
			let actual_type = json_type_name(value);
			assert!(
				allowed_types.contains(&actual_type),
				"{path}.{key}: 型不一致(schema={allowed_types:?}, actual={actual_type}, value={value:?})"
			);
		}
	}

	/// タグ付き union(`anyOf`、各分岐が `tag_field` に `const` を持つ)に対して、`actual` の
	/// タグ値から該当 variant を選び出して照合する。Rust 側の internally-tagged enum
	/// (`#[serde(tag = "...")]`)の表現と対になる。
	fn assert_tagged_union_matches(
		union_schema: &serde_json::Value,
		tag_field: &str,
		actual: &serde_json::Value,
		path: &str,
	) {
		let variants = union_schema["anyOf"]
			.as_array()
			.unwrap_or_else(|| panic!("{path}: anyOf が array ではない(タグ付き union ではない?)"));
		let actual_tag = actual
			.get(tag_field)
			.and_then(|v| v.as_str())
			.unwrap_or_else(|| panic!("{path}: タグフィールド {tag_field} が無い"));
		let matching = variants
			.iter()
			.find(|variant| variant["properties"][tag_field]["const"].as_str() == Some(actual_tag))
			.unwrap_or_else(|| {
				panic!("{path}: タグ値 {actual_tag:?} に一致する variant が契約に無い")
			});
		assert_object_matches_schema(matching, actual, &format!("{path}({actual_tag})"));
	}

	#[test]
	fn ig_publish_progress_variant_count_matches_contract() {
		let schema = contract_schema();
		let def = schema_def(&schema, "igPublishProgress");
		let anyof = def["anyOf"].as_array().unwrap();
		// Rust 側 `IgPublishProgress` の variant 数(Uploading, Enqueuing)と一致すること
		// (契約側だけに無関係な分岐が増える/Rust 側だけ増えて契約に無いケースを検知)。
		assert_eq!(anyof.len(), 2);
	}

	#[test]
	fn ig_publish_progress_uploading_conforms_to_contract_schema() {
		let actual = serde_json::to_value(IgPublishProgress::Uploading {
			bytes_sent: 10,
			total_bytes: 100,
			percent: 10.0,
		})
		.unwrap();
		assert_tagged_union_matches(
			schema_def(&contract_schema(), "igPublishProgress"),
			"phase",
			&actual,
			"igPublishProgress",
		);
	}

	#[test]
	fn ig_publish_progress_enqueuing_conforms_to_contract_schema() {
		let actual = serde_json::to_value(IgPublishProgress::Enqueuing).unwrap();
		assert_tagged_union_matches(
			schema_def(&contract_schema(), "igPublishProgress"),
			"phase",
			&actual,
			"igPublishProgress",
		);
	}

	#[test]
	fn ig_publish_done_conforms_to_contract_schema() {
		let actual = serde_json::to_value(IgPublishDone {
			scheduler_job_id: "job-1".to_string(),
			status: "pending".to_string(),
		})
		.unwrap();
		assert_object_matches_schema(
			schema_def(&contract_schema(), "igPublishDone"),
			&actual,
			"igPublishDone",
		);
	}

	#[test]
	fn ig_publish_runtime_error_variant_count_matches_contract() {
		let schema = contract_schema();
		let def = schema_def(&schema, "igPublishRuntimeError");
		let anyof = def["anyOf"].as_array().unwrap();
		// Rust 側 `IgPublishRuntimeError` の variant 数(7つ)と一致すること。
		assert_eq!(anyof.len(), 7);
	}

	#[test]
	fn ig_publish_runtime_error_all_variants_conform_to_contract_schema() {
		let variants = [
			IgPublishRuntimeError::UploadFailed {
				detail: "d".to_string(),
			},
			IgPublishRuntimeError::EnqueueUnauthorized,
			IgPublishRuntimeError::EnqueueServiceUnavailable,
			IgPublishRuntimeError::EnqueueRejected {
				detail: "d".to_string(),
			},
			IgPublishRuntimeError::Network {
				detail: "d".to_string(),
			},
			IgPublishRuntimeError::Cancelled,
			IgPublishRuntimeError::Internal {
				detail: "d".to_string(),
			},
		];
		let schema = contract_schema();
		let def = schema_def(&schema, "igPublishRuntimeError");
		for variant in variants {
			let actual = serde_json::to_value(&variant).unwrap();
			assert_tagged_union_matches(def, "kind", &actual, "igPublishRuntimeError");
		}
	}
}
