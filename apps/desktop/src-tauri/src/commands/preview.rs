//! `preview_start` コマンド: `media_core::render_preview` を非同期に実行し、
//! 進捗・完了を Tauri イベントで通知する。
//!
//! [`reframe`](crate::commands::reframe) モジュールと同じパターンを踏襲する
//! (`JobsState` 共有・`spawn_blocking`・イベント名は `reframe://` を `preview://` に
//! 変えただけの対応形)。**キャンセルは専用コマンドを持たず、`reframe_cancel` を
//! そのまま使う** — `preview_start` も [`JobsState`](super::reframe::JobsState) に
//! ジョブを登録するため、ジョブ ID 空間が `reframe_start` と共有されており、
//! `reframe_cancel(jobId)` はどちらのジョブに対しても機能する
//! (`reframe.rs` の `JobsState::register`/`get`/`remove` を `pub(crate)` にして
//! 本モジュールから再利用している)。
//!
//! ## renderer 向け API
//!
//! ```ts
//! import { invoke } from "@tauri-apps/api/core";
//! import { listen } from "@tauri-apps/api/event";
//! import { convertFileSrc } from "@tauri-apps/api/core";
//!
//! // EditSpec は packages/core/src/types.ts と同形(camelCase)。reframe_start と共通。
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
//! // 1. ジョブを開始する。戻り値の jobId は reframe_start と同じ ID 空間を使う。
//! const jobId = await invoke<string>("preview_start", {
//!   input: "/path/to/input.mp4",
//!   spec, // EditSpec
//! });
//!
//! // 2. 進捗イベントを購読する(既定 200ms 間隔でスロットリング。progress.rs 参照。
//! //    キャッシュヒット時は render_preview が pipeline::reframe を呼ばないため
//! //    一度も発火しないまま done が来ることがある — これは正常系)。
//! const unlistenProgress = await listen<Progress>(`preview://progress/${jobId}`, (event) => {
//!   console.log(event.payload.percent);
//! });
//!
//! // 3. 完了 / 失敗イベント(いずれか一方が必ず一度だけ発火する)。done の payload は
//! //    生成(またはキャッシュヒットした)プレビューファイルの絶対パス。
//! //    renderer は <video>/<img> の src にそのまま使えないので convertFileSrc を通す。
//! const unlistenDone = await listen<{ path: string }>(`preview://done/${jobId}`, (event) => {
//!   videoEl.src = convertFileSrc(event.payload.path);
//! });
//! const unlistenError = await listen<{ message: string }>(`preview://error/${jobId}`, (event) => {
//!   console.error(event.payload.message);
//! });
//!
//! // 4. 中断したい場合は reframe_cancel を使う(専用コマンドはない。モジュール冒頭参照)。
//! await invoke("reframe_cancel", { jobId });
//! ```
//!
//! ## キャッシュディレクトリ
//!
//! `cache_dir` は Tauri の `app_data_dir()` 配下の `preview-cache` サブディレクトリを
//! 使う(`AppHandle` から `app.path().app_data_dir()` で取得する。プラットフォーム別の
//! 実際のパスは Tauri のドキュメント参照)。取得に失敗した場合(通常は環境不備)は
//! ジョブを開始せず、`preview_start` 自体がエラーを返す(`run_job` に到達する前に弾く)。
//!
//! キャッシュの削除ポリシーは未定(`media_core::preview` モジュール冒頭コメントの
//! TODO を参照。本コマンド層は掃除を一切行わない)。

use std::path::{Path, PathBuf};

use media_core::spec::EditSpec;
use media_core::{preview, CancelToken, Progress};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::reframe::{JobId, JobsState};

/// キャッシュディレクトリ名(`app_data_dir()` からの相対)。
const CACHE_DIR_NAME: &str = "preview-cache";

/// `preview://done/{jobId}` イベントのペイロード。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewDone {
	/// 生成(またはキャッシュヒット)したプレビューファイルの絶対パス。
	/// renderer は `convertFileSrc` を通してから `<video>`/`<img>` の `src` に使う
	/// (モジュール冒頭の renderer 向け API 参照)。
	path: String,
}

/// `preview://error/{jobId}` イベントのペイロード(キャンセルも含む。`MediaError` の
/// `Display` をそのまま文字列化する)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewError {
	message: String,
}

fn progress_event_name(job_id: &str) -> String {
	format!("preview://progress/{job_id}")
}

fn done_event_name(job_id: &str) -> String {
	format!("preview://done/{job_id}")
}

fn error_event_name(job_id: &str) -> String {
	format!("preview://error/{job_id}")
}

/// `app` の `app_data_dir()` 配下にプレビューキャッシュディレクトリのパスを組み立てる。
/// ディレクトリの作成自体は `media_core::preview::render_preview` が
/// `fs::create_dir_all` で行う(ここではパスの計算のみ)。
fn resolve_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
	let base = app
		.path()
		.app_data_dir()
		.map_err(|err| format!("アプリデータディレクトリの取得に失敗しました: {err}"))?;
	Ok(base.join(CACHE_DIR_NAME))
}

/// `input` を `spec` の指定形状へ低ビットレートでプレビュー用に再フレーミングする
/// ジョブを開始し、`JobId` を返す(`reframe_start` と同じ [`JobsState`] を共有する)。
///
/// ジョブ本体はバックグラウンドスレッドで実行され、この関数はジョブ登録後すぐに
/// 返る(完了を待たない)。進捗・完了は上記モジュール doc の Tauri イベントで通知する。
/// キャッシュヒット時は再エンコードせず、ほぼ即座に `done` イベントが発火する。
#[tauri::command]
pub async fn preview_start(
	app: AppHandle,
	jobs: State<'_, JobsState>,
	input: String,
	spec: EditSpec,
) -> Result<JobId, String> {
	let cache_dir = resolve_cache_dir(&app)?;

	let token = CancelToken::new();
	let job_id = jobs.register(token);

	let app_for_task = app.clone();
	let job_id_for_task = job_id.clone();
	let input_path = PathBuf::from(input);

	tauri::async_runtime::spawn_blocking(move || {
		run_job(
			&app_for_task,
			&job_id_for_task,
			&input_path,
			&cache_dir,
			spec,
		);
	});

	Ok(job_id)
}

/// ジョブ本体(ブロッキングスレッド上で実行)。State からトークンを取り出し、
/// `media_core::render_preview` を呼び、完了イベントを emit してからジョブを
/// State から削除する(`reframe.rs` の `run_job` と対応する構造)。
fn run_job(app: &AppHandle, job_id: &str, input: &Path, cache_dir: &Path, spec: EditSpec) {
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

	match preview::render_preview(input, &spec, cache_dir, &token, &on_progress) {
		Ok(path) => {
			let _ = app.emit(
				&done_event_name(job_id),
				PreviewDone {
					path: path.to_string_lossy().into_owned(),
				},
			);
		}
		Err(err) => {
			let _ = app.emit(
				&error_event_name(job_id),
				PreviewError {
					message: err.to_string(),
				},
			);
		}
	}

	jobs.remove(job_id);
}

#[cfg(test)]
mod tests {
	use super::*;

	// --- イベント名の組み立て(reframe.rs のテストパターンに倣う) -----------------

	#[test]
	fn event_names_embed_job_id() {
		let job_id = "abc-123";
		assert_eq!(progress_event_name(job_id), "preview://progress/abc-123");
		assert_eq!(done_event_name(job_id), "preview://done/abc-123");
		assert_eq!(error_event_name(job_id), "preview://error/abc-123");
	}

	#[test]
	fn cache_dir_name_is_stable() {
		// キャッシュディレクトリ名自体の回帰(誤って変更されないことの固定)。
		// `resolve_cache_dir` は `AppHandle` が必要なため直接はテストできないが、
		// 定数自体はここで固定できる。
		assert_eq!(CACHE_DIR_NAME, "preview-cache");
	}

	// --- JobsState 経由のジョブ登録/共有(reframe.rs 側の JobsState テストと重複させず、
	//     preview.rs が reframe.rs の JobsState を問題なく再利用できることのみ確認) ---

	#[test]
	fn preview_and_reframe_share_job_id_space() {
		let jobs = JobsState::default();
		let token = CancelToken::new();
		let job_id = jobs.register(token.clone());

		// reframe_cancel が使う cancel() を preview 側で登録したジョブに対して呼べる。
		jobs.cancel(&job_id)
			.expect("shared job must be cancellable");
		assert!(token.is_cancelled());
	}
}
