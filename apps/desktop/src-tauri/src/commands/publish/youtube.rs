//! `youtube_publish_start` / `youtube_publish_cancel` コマンド: YouTube への動画
//! アップロード + `publishAt` 予約公開(docs/desktop-migration-plan.md §6.5・§8 Phase 3・
//! §12.2)。旧 studio 実装(削除済み)の `apps/studio/server/src/services/youtube.ts` の
//! `uploadWithSchedule` を
//! Rust へ移植する(§6.5・§11-4 で確定済みの案 A: `google-youtube3` + `yup-oauth2`)。
//!
//! ## 旧 TS 実装との対応
//!
//! - `privacyStatus` は `publishAt` 指定時は常に `"private"` に固定する(YouTube 側の
//!   要件。旧実装のコメントと同じ)。`publishAt` 未指定時は呼び出し側が渡した
//!   `privacy_status`(既定 `"private"`)をそのまま使う。
//! - `selfDeclaredMadeForKids: false` を常に送る(旧実装と同じ固定値)。
//! - `videos.insert(part=["snippet","status"], ...)` + resumable upload
//!   (`google-youtube3` の `upload_resumable` に委ねる。手書きしない、§6.5)。
//!
//! ## §12.2 の制約(未監査 OAuth クライアントの private ロック)
//!
//! `publishAt` 付きアップロードは、監査済みでない Google Cloud プロジェクトでは
//! private 固定のまま自動公開されない(API はこれをエラーとしては返さない —
//! 単に指定時刻を過ぎても private のままになるだけで、呼び出し側からは検知できない)。
//! そのためこれは実行時エラーではなく、設定 UI 側の**常時表示の警告文言**として
//! ユーザーに伝える(`features/publish-settings/PublishSettingsSection.tsx` 参照。
//! 旧 TS 実装はコード上のコメントのみだったが、実装指示 §2 の「エラー/警告として
//! ユーザーに見える形にする」に応え、UI 文言に格上げした)。
//!
//! ## ジョブ管理・進捗・キャンセル
//!
//! `commands::publish::ig` と同じ形(`job_id → CancelToken` の State、RAII
//! `JobGuard`)を踏襲する。進捗・キャンセルは `google_youtube3::common::Delegate` の
//! `cancel_chunk_upload`(resumable upload がチャンク境界ごとに呼ぶ)をフックして実装する
//! (`ProgressDelegate` 参照)。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use google_youtube3::api::{Video, VideoSnippet, VideoStatus};
use google_youtube3::common::{ContentRange, Delegate};
use google_youtube3::YouTube;
use media_core::CancelToken;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::credential_store::KeyringStore;
use super::youtube_oauth::{self, YOUTUBE_UPLOAD_SCOPE};

/// renderer が採番するジョブ ID(`ig`/`reframe`/`preview` と同じ形の型エイリアス)。
pub type JobId = String;

/// 実行中の YouTube 公開ジョブの [`CancelToken`] を保持する State。
/// `IgJobsState` とは別のジョブ ID 空間(§`commands::publish::ig` 冒頭コメントと同じ理由:
/// IG と YouTube はライフサイクルが異なる独立した実装のため共有しない、YAGNI)。
#[derive(Default)]
pub struct YoutubeJobsState(Mutex<HashMap<JobId, CancelToken>>);

impl YoutubeJobsState {
	fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<JobId, CancelToken>> {
		self.0
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
	}

	fn register(&self, job_id: JobId, token: CancelToken) {
		self.lock().insert(job_id, token);
	}

	fn get(&self, job_id: &str) -> Option<CancelToken> {
		self.lock().get(job_id).cloned()
	}

	fn remove(&self, job_id: &str) {
		self.lock().remove(job_id);
	}
}

/// [`run_youtube_publish`] 終了時に必ず `jobs.remove(job_id)` を呼ぶ RAII ガード
/// (`commands::publish::ig::JobGuard` と同じ考え方)。
struct JobGuard<'a> {
	jobs: &'a YoutubeJobsState,
	job_id: &'a str,
}

impl Drop for JobGuard<'_> {
	fn drop(&mut self) {
		self.jobs.remove(self.job_id);
	}
}

/// `youtube_publish://progress/{jobId}` イベントのペイロード。
#[derive(Debug, Clone, Serialize)]
#[serde(
	tag = "phase",
	rename_all = "snake_case",
	rename_all_fields = "camelCase"
)]
pub enum YoutubePublishProgress {
	Uploading {
		bytes_sent: u64,
		total_bytes: u64,
		/// 0.0..=100.0。
		percent: f64,
	},
}

/// `youtube_publish://done/{jobId}` イベントのペイロード。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubePublishDone {
	pub video_id: String,
	/// `"scheduled"`(publishAt 指定)または実際の `privacyStatus`。
	pub status: String,
}

/// `youtube_publish://error/{jobId}` イベントのペイロード(実装指示 §2: 未認可/quota/
/// ネットワーク/API エラーを分岐できる enum として返す)。事前バリデーション
/// (OAuth 未接続等)はこのイベントではなく `youtube_publish_start` の `Err`(同期)で返る。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum YoutubePublishRuntimeError {
	/// トークンが無効・失効・未認可(401 相当。`MissingToken`/`MissingAPIKey` も含む)。
	NotAuthorized,
	/// 403(quota 超過 or 権限不足。YouTube API はいずれも 403 を返すため、本文の
	/// JSON パースはせず区別しない — 詳細はメッセージに残す)。
	QuotaOrForbidden {
		detail: String,
	},
	Network {
		detail: String,
	},
	/// 上記以外の API エラー(不正なリクエスト・想定外のレスポンス等)。
	Api {
		detail: String,
	},
	Cancelled,
	Internal {
		detail: String,
	},
}

fn progress_event_name(job_id: &str) -> String {
	format!("youtube_publish://progress/{job_id}")
}
fn done_event_name(job_id: &str) -> String {
	format!("youtube_publish://done/{job_id}")
}
fn error_event_name(job_id: &str) -> String {
	format!("youtube_publish://error/{job_id}")
}

/// 進捗イベントの発火頻度を間引く閾値(パーセントポイント)。`ig.rs` と同じ理由。
const PROGRESS_EMIT_STEP_PERCENT: f64 = 1.0;

/// `input_path` を YouTube へアップロードする(ロジック本体)。`#[tauri::command]` は
/// `mod.rs` 側の薄いラッパに置く(`ig::start_impl` 冒頭コメントと同じ理由:
/// `#[tauri::command]` マクロの補助アイテムは `generate_handler!` と同じモジュールに
/// 生成される必要があるため)。
///
/// OAuth クライアント・トークンの有無を先に確認し、いずれかが未設定ならジョブを
/// 開始せず `Err` を返す(アップロード開始前に判明できる失敗は同期エラーとして返す、
/// `ig::start_impl` と同じ方針)。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn start_impl(
	app: AppHandle,
	jobs: State<'_, YoutubeJobsState>,
	job_id: JobId,
	input_path: String,
	title: String,
	description: String,
	publish_at: Option<i64>,
	privacy_status: Option<String>,
) -> Result<(), String> {
	if title.trim().is_empty() {
		return Err("タイトルは必須です。".to_string());
	}
	let path = PathBuf::from(&input_path);
	if !path.is_file() {
		return Err(format!("ファイルが見つかりません: {input_path}"));
	}

	// OAuth クライアント・接続状態の確認(R2 に一切触れない `ig::start_impl` の
	// 資格情報チェックと同じ位置づけ)。実際のトークンの有効性(失効・取り消し)は
	// ここでは検証しない — アップロード実行時に 401 として顕在化し、
	// `YoutubePublishRuntimeError::NotAuthorized` として届く。
	let authenticator = youtube_oauth::build_authenticator_for_publish(&KeyringStore).await?;

	let token = CancelToken::new();
	jobs.register(job_id.clone(), token.clone());

	let handle = tauri::async_runtime::spawn(run_youtube_publish(
		app.clone(),
		job_id.clone(),
		token,
		path,
		title,
		description,
		publish_at,
		privacy_status,
		authenticator,
	));

	// パニック時のみ error イベントを発火する監視タスク(`ig::start_impl` と同じ理由:
	// tokio はタスク境界でパニックを既に分離するため、プロセスは落ちないが
	// renderer が待ち続けないようにする)。
	let app_for_watch = app.clone();
	let job_id_for_watch = job_id;
	tauri::async_runtime::spawn(async move {
		if let Err(tauri::Error::JoinError(join_err)) = handle.await {
			if join_err.is_panic() {
				let _ = app_for_watch.emit(
					&error_event_name(&job_id_for_watch),
					YoutubePublishRuntimeError::Internal {
						detail: "内部エラーが発生しました(パニック)".to_string(),
					},
				);
			}
		}
	});

	Ok(())
}

/// `job_id` の YouTube 公開ジョブをキャンセルする(ロジック本体)。アップロード中の
/// チャンク境界(`ProgressDelegate::cancel_chunk_upload`)でのみ反映されるため、
/// `ig.rs` の R2 アップロードと同じ「協調的キャンセル」の性質を持つ。
pub(crate) fn cancel_impl(job_id: JobId, jobs: State<'_, YoutubeJobsState>) -> Result<(), String> {
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

/// resumable upload のチャンク境界ごとに呼ばれ、進捗イベントの発火とキャンセル反映を行う
/// `Delegate`。それ以外(リトライ・エラー分類等)は既定実装のままでよいため上書きしない。
struct ProgressDelegate {
	app: AppHandle,
	job_id: String,
	token: CancelToken,
	last_emitted_percent: f64,
}

impl Delegate for ProgressDelegate {
	fn cancel_chunk_upload(&mut self, chunk: &ContentRange) -> bool {
		if self.token.is_cancelled() {
			return true;
		}
		if let Some(range) = &chunk.range {
			if chunk.total_length > 0 {
				// `range.last` は 0 始まりの inclusive な末尾オフセットのため、
				// 送信バイト数としては +1 する(percent が 100 を僅かに超えないよう clamp)。
				let bytes_sent = (range.last + 1).min(chunk.total_length);
				let percent = (bytes_sent as f64 / chunk.total_length as f64) * 100.0;
				// 1% 刻み + 完了(100%)は必ず emit する(`ig.rs` の間引きと同じ方針)。
				if percent >= self.last_emitted_percent + PROGRESS_EMIT_STEP_PERCENT
					|| percent >= 100.0
				{
					self.last_emitted_percent = percent;
					let _ = self.app.emit(
						&progress_event_name(&self.job_id),
						YoutubePublishProgress::Uploading {
							bytes_sent,
							total_bytes: chunk.total_length,
							percent,
						},
					);
				}
			}
		}
		false
	}
}

/// ジョブ本体(非同期タスク)。YouTube へのアップロードを実行し、進捗/完了/失敗を
/// Tauri イベントで通知する。
#[allow(clippy::too_many_arguments)]
async fn run_youtube_publish(
	app: AppHandle,
	job_id: JobId,
	token: CancelToken,
	input_path: PathBuf,
	title: String,
	description: String,
	publish_at: Option<i64>,
	privacy_status: Option<String>,
	authenticator: youtube_oauth::YoutubeAuthenticator,
) {
	let jobs = app.state::<YoutubeJobsState>();
	let _guard = JobGuard {
		jobs: &jobs,
		job_id: &job_id,
	};

	// アップロード前にアクセストークンを先行取得する。期限切れなら refresh され、
	// refresh 不能(失効・取り消し)の場合は yup-oauth2 が対話フロー(ブラウザでの
	// 再同意)へフォールバックする(yup-oauth2 `find_token_info` の実装)。ブラウザを
	// 放置されるとアップロードが無期限に待つため、接続時と同じタイムアウトを設ける。
	// ここで成功しておけば、直後のアップロードは有効なトークンで開始できる
	// (アクセストークンは約1時間有効。それを超える長尺アップロード中の再 refresh は
	// 稀なエッジケースとして許容する)。
	match tokio::time::timeout(
		youtube_oauth::CONNECT_TIMEOUT,
		authenticator.token(&[YOUTUBE_UPLOAD_SCOPE]),
	)
	.await
	{
		Ok(Ok(_)) => {}
		Ok(Err(_)) | Err(_) => {
			// 認可の失敗・タイムアウトはいずれも「再接続が必要」としてユーザーに伝える
			// (詳細メッセージは接続フロー側 `connect_impl` が担う)。
			emit_error(&app, &job_id, YoutubePublishRuntimeError::NotAuthorized);
			return;
		}
	}

	let connector =
		match google_youtube3::hyper_rustls::HttpsConnectorBuilder::new().with_native_roots() {
			Ok(builder) => builder.https_or_http().enable_http2().build(),
			Err(err) => {
				emit_error(
					&app,
					&job_id,
					YoutubePublishRuntimeError::Internal {
						detail: format!("OS のルート証明書ストアを読み込めませんでした: {err}"),
					},
				);
				return;
			}
		};
	let client = google_youtube3::hyper_util::client::legacy::Client::builder(
		google_youtube3::hyper_util::rt::TokioExecutor::new(),
	)
	.build(connector);
	let hub = YouTube::new(client, authenticator);

	let (video, scheduled, privacy) =
		match build_video_request(title, description, publish_at, privacy_status) {
			Ok(built) => built,
			Err(detail) => {
				emit_error(
					&app,
					&job_id,
					YoutubePublishRuntimeError::Internal { detail },
				);
				return;
			}
		};

	let file = match tokio::fs::File::open(&input_path).await {
		Ok(f) => f.into_std().await,
		Err(err) => {
			emit_error(
				&app,
				&job_id,
				YoutubePublishRuntimeError::Internal {
					detail: format!("ファイルを開けませんでした: {err}"),
				},
			);
			return;
		}
	};

	let _ = app.emit(
		&progress_event_name(&job_id),
		YoutubePublishProgress::Uploading {
			bytes_sent: 0,
			total_bytes: 0,
			percent: 0.0,
		},
	);

	let mut delegate = ProgressDelegate {
		app: app.clone(),
		job_id: job_id.clone(),
		token,
		last_emitted_percent: -1.0,
	};

	// part(snippet,status)は `insert()` がリクエストボディの設定済みフィールドから
	// 自動導出する(`Video::to_parts()`。snippet/status を Some にしているため
	// 旧 TS 実装の `part: ["snippet","status"]` と同じ内容になる)。
	let mime_type: mime::Mime = "video/mp4".parse().expect("固定 MIME 文字列");
	let result = hub
		.videos()
		.insert(video)
		.add_scope(YOUTUBE_UPLOAD_SCOPE)
		.delegate(&mut delegate)
		.upload_resumable(file, mime_type)
		.await;

	match result {
		Ok((_response, uploaded_video)) => match uploaded_video.id {
			Some(video_id) => {
				let _ = app.emit(
					&done_event_name(&job_id),
					YoutubePublishDone {
						video_id,
						status: if scheduled {
							"scheduled".to_string()
						} else {
							privacy
						},
					},
				);
			}
			None => emit_error(
				&app,
				&job_id,
				YoutubePublishRuntimeError::Internal {
					detail: "アップロードは成功しましたが videoId が取得できませんでした"
						.to_string(),
				},
			),
		},
		Err(err) => emit_error(&app, &job_id, classify_error(err)),
	}
}

/// `videos.insert` のリクエストボディ(メタデータ)を組み立てる(旧 TS 実装
/// `uploadWithSchedule` のメタデータ組み立てを移植した純粋関数。テスト対象)。
///
/// 戻り値は `(Video, scheduled, privacy)`。`scheduled`(publishAt 指定の有無)と
/// 実際に適用した `privacy` は done イベントの `status`(旧実装の
/// `status: scheduled ? "scheduled" : privacy`)の組み立てに使う。
fn build_video_request(
	title: String,
	description: String,
	publish_at: Option<i64>,
	privacy_status: Option<String>,
) -> Result<(Video, bool, String), String> {
	// 予約公開(publishAt 指定)時は YouTube 側の要件で private が必須
	// (旧 TS 実装と同じ、モジュール冒頭コメント参照)。
	let scheduled = publish_at.is_some();
	let privacy = if scheduled {
		"private".to_string()
	} else {
		privacy_status.unwrap_or_else(|| "private".to_string())
	};

	let mut status = VideoStatus {
		privacy_status: Some(privacy.clone()),
		self_declared_made_for_kids: Some(false),
		..Default::default()
	};
	if let Some(publish_at_ms) = publish_at {
		// unix ms → `DateTime<Utc>`。google-youtube3 が serialize 時に RFC3339 へ変換する
		// (旧 TS 実装の `new Date(publishAt).toISOString()` に対応)。
		status.publish_at = Some(
			chrono::DateTime::from_timestamp_millis(publish_at_ms)
				.ok_or_else(|| format!("publishAt の値が不正です: {publish_at_ms}"))?,
		);
	}

	let video = Video {
		snippet: Some(VideoSnippet {
			title: Some(title),
			description: Some(description),
			..Default::default()
		}),
		status: Some(status),
		..Default::default()
	};
	Ok((video, scheduled, privacy))
}

/// `google_youtube3::common::Error` をユーザー向けの構造化 enum へ分類する
/// (実装指示 §2: 未認可 / quota / ネットワーク / API エラー)。
///
/// `detail` に格納する `err.to_string()`(`Display`)は診断用にそのまま残す。
/// 秘密値を含まないことは google-apis-common の `Display` 実装で確認済み:
/// `Failure` は**レスポンス**の Debug(status + レスポンスヘッダ)のみで、リクエスト側の
/// `Authorization` ヘッダやトークンは含まれない。`MissingToken` 系は detail を持たない
/// `NotAuthorized` に落とすため、yup-oauth2 のエラー文字列も renderer へ流れない
/// (§credential_store::sanitize_err の「エラーメッセージにも秘密値を含めない」方針)。
fn classify_error(err: google_youtube3::common::Error) -> YoutubePublishRuntimeError {
	use google_youtube3::common::Error;
	match err {
		Error::Cancelled => YoutubePublishRuntimeError::Cancelled,
		Error::MissingToken(_) | Error::MissingAPIKey => YoutubePublishRuntimeError::NotAuthorized,
		Error::HttpError(_) | Error::Io(_) => YoutubePublishRuntimeError::Network {
			detail: err.to_string(),
		},
		Error::Failure(ref response) => {
			classify_failure_status(response.status().as_u16(), err.to_string())
		}
		other => YoutubePublishRuntimeError::Api {
			detail: other.to_string(),
		},
	}
}

/// 非成功 HTTP ステータスの分類(`classify_error` の `Error::Failure` 部分を、
/// `hyper::Response` を組み立てずにテストできるよう分離した純粋関数)。
///
/// YouTube API は quota 超過も権限不足もいずれも HTTP 403 を返す(区別は JSON body の
/// `reason` フィールドだが、レスポンスボディの非同期読み取りをここに持ち込むと
/// エラー分岐が煩雑になるため、本実装は 403 を `QuotaOrForbidden` として一括りにし、
/// 詳細は `detail` に元エラーの `Display` をそのまま残す(ユーザーが詳細を確認できる)。
fn classify_failure_status(status: u16, detail: String) -> YoutubePublishRuntimeError {
	match status {
		401 => YoutubePublishRuntimeError::NotAuthorized,
		403 => YoutubePublishRuntimeError::QuotaOrForbidden { detail },
		_ => YoutubePublishRuntimeError::Api { detail },
	}
}

fn emit_error(app: &AppHandle, job_id: &str, error: YoutubePublishRuntimeError) {
	let _ = app.emit(&error_event_name(job_id), error);
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn event_names_embed_job_id() {
		assert_eq!(
			progress_event_name("abc-123"),
			"youtube_publish://progress/abc-123"
		);
		assert_eq!(done_event_name("abc-123"), "youtube_publish://done/abc-123");
		assert_eq!(
			error_event_name("abc-123"),
			"youtube_publish://error/abc-123"
		);
	}

	#[test]
	fn youtube_jobs_state_register_get_remove_roundtrip() {
		let jobs = YoutubeJobsState::default();
		let token = CancelToken::new();
		jobs.register("job-1".to_string(), token.clone());

		assert!(jobs.get("job-1").is_some());
		jobs.remove("job-1");
		assert!(jobs.get("job-1").is_none());
	}

	#[test]
	fn progress_payload_serializes_with_phase_tag() {
		let json = serde_json::to_value(YoutubePublishProgress::Uploading {
			bytes_sent: 10,
			total_bytes: 100,
			percent: 10.0,
		})
		.unwrap();
		assert_eq!(json["phase"], "uploading");
		assert_eq!(json["bytesSent"], 10);
	}

	#[test]
	fn done_payload_serializes_with_camel_case() {
		let json = serde_json::to_value(YoutubePublishDone {
			video_id: "abc123".to_string(),
			status: "scheduled".to_string(),
		})
		.unwrap();
		assert_eq!(json["videoId"], "abc123");
		assert_eq!(json["status"], "scheduled");
	}

	#[test]
	fn error_payload_serializes_with_kind_tag() {
		let json = serde_json::to_value(YoutubePublishRuntimeError::NotAuthorized).unwrap();
		assert_eq!(json["kind"], "not_authorized");

		let json = serde_json::to_value(YoutubePublishRuntimeError::QuotaOrForbidden {
			detail: "quota exceeded".to_string(),
		})
		.unwrap();
		assert_eq!(json["kind"], "quota_or_forbidden");
		assert_eq!(json["detail"], "quota exceeded");
	}

	// ---- build_video_request(旧 TS `uploadWithSchedule` のメタデータ組み立てに対応) ----

	#[test]
	fn scheduled_upload_forces_private_and_sets_publish_at_rfc3339() {
		// 2026-07-10T12:34:56Z(旧 TS の publish.ts は ms → toISOString() で渡していた)。
		let publish_at_ms = 1_783_686_896_000_i64;
		let (video, scheduled, privacy) = build_video_request(
			"タイトル".to_string(),
			"説明".to_string(),
			Some(publish_at_ms),
			// publishAt 指定時は privacy_status を渡しても private に固定される
			// (旧 TS 実装の `scheduled ? "private" : ...` と同じ)。
			Some("public".to_string()),
		)
		.unwrap();

		assert!(scheduled);
		assert_eq!(privacy, "private");
		let status = video.status.unwrap();
		assert_eq!(status.privacy_status.as_deref(), Some("private"));
		assert_eq!(status.self_declared_made_for_kids, Some(false));
		// chrono の RFC3339 表現が旧 TS の toISOString()(UTC)と同時刻を指す。
		assert_eq!(
			status.publish_at.unwrap().to_rfc3339(),
			"2026-07-10T12:34:56+00:00"
		);

		let snippet = video.snippet.unwrap();
		assert_eq!(snippet.title.as_deref(), Some("タイトル"));
		assert_eq!(snippet.description.as_deref(), Some("説明"));
	}

	#[test]
	fn immediate_upload_uses_given_privacy_and_omits_publish_at() {
		let (video, scheduled, privacy) = build_video_request(
			"t".to_string(),
			String::new(),
			None,
			Some("unlisted".to_string()),
		)
		.unwrap();

		assert!(!scheduled);
		assert_eq!(privacy, "unlisted");
		let status = video.status.unwrap();
		assert_eq!(status.privacy_status.as_deref(), Some("unlisted"));
		assert!(status.publish_at.is_none());
	}

	#[test]
	fn immediate_upload_defaults_to_private_when_privacy_unspecified() {
		let (_video, scheduled, privacy) =
			build_video_request("t".to_string(), String::new(), None, None).unwrap();
		assert!(!scheduled);
		assert_eq!(privacy, "private");
	}

	#[test]
	fn video_request_serializes_to_youtube_api_shape() {
		// google-youtube3 のシリアライズ(camelCase + RFC3339)が旧 TS 実装の
		// リクエストボディと同形であることの固定(旧 publish.ts のメタデータ形状)。
		let (video, _, _) = build_video_request(
			"t".to_string(),
			"d".to_string(),
			Some(1_783_686_896_000),
			None,
		)
		.unwrap();
		let json = serde_json::to_value(&video).unwrap();
		assert_eq!(json["snippet"]["title"], "t");
		assert_eq!(json["snippet"]["description"], "d");
		assert_eq!(json["status"]["privacyStatus"], "private");
		assert_eq!(json["status"]["selfDeclaredMadeForKids"], false);
		// serde_with の DateTime<Utc> 表現(RFC3339)。
		let publish_at = json["status"]["publishAt"].as_str().unwrap();
		assert!(
			publish_at.starts_with("2026-07-10T12:34:56"),
			"unexpected publishAt: {publish_at}"
		);
	}

	// ---- classify_error / classify_failure_status(実装指示 §2 のエラー分類) --------

	#[test]
	fn classify_failure_status_maps_http_codes() {
		assert!(matches!(
			classify_failure_status(401, "detail".to_string()),
			YoutubePublishRuntimeError::NotAuthorized
		));
		assert!(matches!(
			classify_failure_status(403, "detail".to_string()),
			YoutubePublishRuntimeError::QuotaOrForbidden { .. }
		));
		assert!(matches!(
			classify_failure_status(400, "detail".to_string()),
			YoutubePublishRuntimeError::Api { .. }
		));
		assert!(matches!(
			classify_failure_status(500, "detail".to_string()),
			YoutubePublishRuntimeError::Api { .. }
		));
	}

	#[test]
	fn classify_error_maps_constructible_variants() {
		use google_youtube3::common::Error;

		assert!(matches!(
			classify_error(Error::Cancelled),
			YoutubePublishRuntimeError::Cancelled
		));
		assert!(matches!(
			classify_error(Error::MissingToken("no token".into())),
			YoutubePublishRuntimeError::NotAuthorized
		));
		assert!(matches!(
			classify_error(Error::MissingAPIKey),
			YoutubePublishRuntimeError::NotAuthorized
		));
		assert!(matches!(
			classify_error(Error::Io(std::io::Error::other("boom"))),
			YoutubePublishRuntimeError::Network { .. }
		));
		assert!(matches!(
			classify_error(Error::BadRequest(serde_json::json!({"error": "bad"}))),
			YoutubePublishRuntimeError::Api { .. }
		));
	}
}
