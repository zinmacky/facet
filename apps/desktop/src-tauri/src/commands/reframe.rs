//! `reframe_start` / `reframe_cancel` コマンド: `media_core::reframe` を非同期に実行し、
//! 進捗・完了を Tauri イベントで通知する。
//!
//! ## renderer 向け API
//!
//! ```ts
//! import { invoke } from "@tauri-apps/api/core";
//! import { listen } from "@tauri-apps/api/event";
//!
//! // EditSpec は packages/core/src/types.ts と同形(camelCase)。
//! // media_core::spec::EditSpec の Rust 定義に対応する。
//! type EditSpec = {
//!   source: { width: number; height: number };
//!   trim?: { start: number; end: number };
//!   crop?: { x: number; y: number; width: number; height: number };
//!   preset: { name: string; width: number; height: number; fit: "blur-pad" | "crop" };
//! };
//!
//! type Progress = {
//!   frame: number;
//!   totalFrames: number | null;
//!   percent: number | null;
//!   outTimeSecs: number;
//!   fps: number;
//!   speed: number;
//! };
//!
//! // 1. ジョブを開始する。戻り値の jobId をイベント名の組み立てに使う。
//! const jobId = await invoke<string>("reframe_start", {
//!   input: "/path/to/input.mp4",
//!   output: "/path/to/output.mp4",
//!   spec, // EditSpec
//! });
//!
//! // 2. 進捗イベントを購読する(既定 200ms 間隔でスロットリングされる。progress.rs 参照)。
//! const unlistenProgress = await listen<Progress>(`reframe://progress/${jobId}`, (event) => {
//!   console.log(event.payload.percent);
//! });
//!
//! // 3. 完了 / 失敗イベント(いずれか一方が必ず一度だけ発火する。キャンセルも失敗の一種として
//! //    `reframe://error/${jobId}` に "キャンセルされました" のメッセージで通知される)。
//! const unlistenDone = await listen<{ encoder: string }>(`reframe://done/${jobId}`, (event) => {
//!   console.log("encoder used:", event.payload.encoder);
//! });
//! const unlistenError = await listen<{ message: string }>(`reframe://error/${jobId}`, (event) => {
//!   console.error(event.payload.message);
//! });
//!
//! // 4. 中断したい場合。
//! await invoke("reframe_cancel", { jobId });
//! ```
//!
//! `reframe_start` はジョブをバックグラウンド(`tauri::async_runtime::spawn_blocking`、
//! tokio のブロッキングスレッドプール)へ投げて即座に `jobId` を返す(reframe 本体の完了を
//! 待たない)。同時実行数の制限は `media_core::concurrency::EncodeSlots` が
//! `media_core::reframe` 内部で担うため、複数ジョブを同時に `reframe_start` してよい
//! (`concurrency.rs` 冒頭コメント参照)。
//!
//! ## State / スレッド設計
//!
//! - [`JobsState`] は `Mutex<HashMap<JobId, CancelToken>>` を保持する(`lib.rs` の
//!   `.manage(JobsState::default())` でアプリ全体に 1 つ登録する)。
//! - `reframe_start` はジョブ登録時に [`CancelToken`] を発行して State に挿入し、
//!   同じトークンの clone(`Arc<AtomicBool>` の共有、安価)をブロッキングタスクへ渡す。
//! - `reframe_cancel` は State からトークンを取得して `cancel()` を呼ぶだけ
//!   (トークン自体はブロッキングタスク側が `is_cancelled()` をループ境界で見ている
//!   — `media_core::cancel` 冒頭コメント参照)。
//! - ジョブ完了(成功・失敗・キャンセルいずれも)時、ブロッキングタスク自身が
//!   State からエントリを削除する(完了後に `reframe_cancel` を呼んでも
//!   "未知のジョブ" エラーになる)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use media_core::spec::EditSpec;
use media_core::{encode, fit, CancelToken, EncoderSelection, Progress, ReframeOptions};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

/// `reframe_start` が発行するジョブ ID。進捗/完了イベント名の組み立てにも使う。
pub type JobId = String;

/// 実行中ジョブの [`CancelToken`] を保持する State。
///
/// `Mutex` は libav 側の重い処理とは無関係な単純な map 操作にのみ使うため、
/// 非同期 Mutex(`tokio::sync::Mutex`)ではなく `std::sync::Mutex` で十分
/// (ロック区間はごく短く、await をまたがない)。
#[derive(Default)]
pub struct JobsState(Mutex<HashMap<JobId, CancelToken>>);

impl JobsState {
	/// `Mutex` がポイズンされていても(他スレッドの panic 後でも)復旧してロックを取る。
	/// `unwrap`/`expect` を使わずに済ませるための薄いラッパ。
	fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<JobId, CancelToken>> {
		self.0
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
	}

	/// 新しい [`CancelToken`] を登録し、発行した `JobId` を返す。
	fn register(&self, token: CancelToken) -> JobId {
		let job_id = Uuid::new_v4().to_string();
		self.lock().insert(job_id.clone(), token);
		job_id
	}

	/// `job_id` に紐づく [`CancelToken`] の clone を返す(`Arc` 共有なので安価)。
	fn get(&self, job_id: &str) -> Option<CancelToken> {
		self.lock().get(job_id).cloned()
	}

	/// `job_id` の [`CancelToken`] に `cancel()` を呼ぶ。未登録(既に完了済み含む)なら
	/// `Err` を返す。
	fn cancel(&self, job_id: &str) -> Result<(), String> {
		match self.lock().get(job_id) {
			Some(token) => {
				token.cancel();
				Ok(())
			}
			None => Err(format!(
				"未知のジョブです(既に完了した可能性があります): {job_id}"
			)),
		}
	}

	/// ジョブ完了時にエントリを削除する。
	fn remove(&self, job_id: &str) {
		self.lock().remove(job_id);
	}
}

/// `reframe://done/{jobId}` イベントのペイロード。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReframeDone {
	/// 実際に使用されたエンコーダ名(`EncoderSelection::Auto` でどの候補が採用されたか)。
	encoder: String,
}

/// `reframe://error/{jobId}` イベントのペイロード(キャンセルも含む。`MediaError` の
/// `Display` をそのまま文字列化する)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReframeError {
	message: String,
}

fn progress_event_name(job_id: &str) -> String {
	format!("reframe://progress/{job_id}")
}

fn done_event_name(job_id: &str) -> String {
	format!("reframe://done/{job_id}")
}

fn error_event_name(job_id: &str) -> String {
	format!("reframe://error/{job_id}")
}

/// `input` を `spec` の指定形状へ再フレーミングするジョブを開始し、`JobId` を返す。
///
/// ジョブ本体はバックグラウンドスレッドで実行され、この関数はジョブ登録後すぐに
/// 返る(完了を待たない)。進捗・完了は上記モジュール doc の Tauri イベントで通知する。
#[tauri::command]
pub async fn reframe_start(
	app: AppHandle,
	jobs: State<'_, JobsState>,
	input: String,
	output: String,
	spec: EditSpec,
) -> Result<JobId, String> {
	let token = CancelToken::new();
	let job_id = jobs.register(token);

	let app_for_task = app.clone();
	let job_id_for_task = job_id.clone();
	let input_path = PathBuf::from(input);
	let output_path = PathBuf::from(output);

	tauri::async_runtime::spawn_blocking(move || {
		run_job(
			&app_for_task,
			&job_id_for_task,
			&input_path,
			&output_path,
			spec,
		);
	});

	Ok(job_id)
}

/// ジョブ本体(ブロッキングスレッド上で実行)。State からトークンを取り出し、
/// `media_core::reframe` を呼び、完了イベントを emit してからジョブを State から削除する。
///
/// App ハンドルと `JobsState`(`app.state()` 経由)にのみ依存し、`spec`/`input`/`output`
/// は素の値で受け取るため、`AppHandle` を持たないテストでも
/// [`ReframeOptions`] の組み立て部分だけを切り出して検証できる
/// (実際の単体テストは `JobsState` の登録/キャンセル、`media_core::reframe` の呼び出しは
/// media-core 側で検証済みのため本ファイルでは重複させない — 下記 `tests` モジュール参照)。
fn run_job(app: &AppHandle, job_id: &str, input: &Path, output: &Path, spec: EditSpec) {
	let jobs = app.state::<JobsState>();
	let Some(token) = jobs.get(job_id) else {
		// register 直後に必ず存在するはずだが、万一取得できなくても panic はしない。
		return;
	};

	let app_for_progress = app.clone();
	let job_id_for_progress = job_id.to_string();
	let on_progress = move |progress: Progress| {
		let _ = app_for_progress.emit(&progress_event_name(&job_id_for_progress), progress);
	};

	let options = ReframeOptions {
		preset: &spec.preset,
		sigma: fit::DEFAULT_SIGMA,
		crop: spec.crop,
		source: spec.source,
		trim: spec.trim,
		encoder: EncoderSelection::Auto,
		bit_rate: encode::DEFAULT_BITRATE,
		cancel: &token,
		on_progress: &on_progress,
	};

	match media_core::reframe(input, output, options) {
		Ok(encoder_name) => {
			let _ = app.emit(
				&done_event_name(job_id),
				ReframeDone {
					encoder: encoder_name,
				},
			);
		}
		Err(err) => {
			let _ = app.emit(
				&error_event_name(job_id),
				ReframeError {
					message: err.to_string(),
				},
			);
		}
	}

	jobs.remove(job_id);
}

/// `job_id` のジョブをキャンセルする。次のループ境界チェック(パケット単位)で
/// `media_core::reframe` が `MediaError::Cancelled` を返し、`reframe://error/{jobId}` が
/// 発火する(一時出力は `media_core` 側で削除済み — `pipeline.rs` 冒頭コメント参照)。
#[tauri::command]
pub fn reframe_cancel(job_id: String, jobs: State<'_, JobsState>) -> Result<(), String> {
	jobs.cancel(&job_id)
}

#[cfg(test)]
mod tests {
	use super::*;

	// --- JobsState: 登録 -> キャンセル -> トークンが cancelled になることの確認
	//     (App ハンドルに依存しないロジック部分のユニットテスト)。

	#[test]
	fn register_then_cancel_marks_token_cancelled() {
		let jobs = JobsState::default();
		let token = CancelToken::new();
		let job_id = jobs.register(token.clone());

		assert!(!token.is_cancelled(), "登録直後はキャンセルされていない");

		jobs.cancel(&job_id)
			.expect("registered job must be cancellable");

		assert!(
			token.is_cancelled(),
			"cancel 後は元のトークンも cancelled になる"
		);
		let stored = jobs
			.get(&job_id)
			.expect("job should still be present until removed");
		assert!(
			stored.is_cancelled(),
			"State 経由で取得したクローンも cancelled"
		);
	}

	#[test]
	fn cancel_unknown_job_returns_error() {
		let jobs = JobsState::default();
		let result = jobs.cancel("no-such-job");
		assert!(result.is_err());
	}

	#[test]
	fn remove_makes_job_and_get_disappear() {
		let jobs = JobsState::default();
		let token = CancelToken::new();
		let job_id = jobs.register(token);

		jobs.remove(&job_id);

		assert!(jobs.get(&job_id).is_none());
		assert!(
			jobs.cancel(&job_id).is_err(),
			"削除後は cancel も未知のジョブ扱い"
		);
	}

	#[test]
	fn multiple_jobs_are_independent() {
		let jobs = JobsState::default();
		let token_a = CancelToken::new();
		let token_b = CancelToken::new();
		let job_a = jobs.register(token_a.clone());
		let job_b = jobs.register(token_b.clone());

		jobs.cancel(&job_a).expect("job_a must exist");

		assert!(token_a.is_cancelled());
		assert!(
			jobs.get(&job_b).is_some_and(|token| !token.is_cancelled()),
			"job_b は job_a の cancel の影響を受けない"
		);
	}

	// --- イベント名の組み立て -------------------------------------------------------

	#[test]
	fn event_names_embed_job_id() {
		let job_id = "abc-123";
		assert_eq!(progress_event_name(job_id), "reframe://progress/abc-123");
		assert_eq!(done_event_name(job_id), "reframe://done/abc-123");
		assert_eq!(error_event_name(job_id), "reframe://error/abc-123");
	}
}
