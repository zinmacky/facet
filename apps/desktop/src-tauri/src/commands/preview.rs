//! `preview_start` コマンド: `media_core::render_preview`(または `quality: "publish"`
//! 指定時は `media_core::render_publish`)を非同期に実行し、進捗・完了を Tauri
//! イベントで通知する。
//!
//! [`reframe`](crate::commands::reframe) モジュールと同じパターンを踏襲する
//! (`JobsState` 共有・`spawn_blocking`・イベント名は `reframe://` を `preview://` に
//! 変えただけの対応形。jobId を renderer 側で採番して先に listen() を張る理由も
//! `reframe.rs` 冒頭の「jobId 採番をフロントエンドへ移した理由」と同じ)。
//! **キャンセルは専用コマンドを持たず、`reframe_cancel` をそのまま使う** —
//! `preview_start` も [`JobsState`](super::reframe::JobsState) にジョブを登録するため、
//! ジョブ ID 空間が `reframe_start` と共有されており、`reframe_cancel(jobId)` は
//! どちらのジョブに対しても機能する(`JobsState` の実装は
//! [`crate::commands::job_state`] に集約されており、`reframe.rs` の newtype が
//! `try_register`/`get`/`remove`/`cancel` を委譲している。本モジュールはその newtype を
//! そのまま再利用する)。
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
//! // 1. jobId は renderer 側で採番する(reframe_start と同じ ID 空間を使う)。
//! const jobId = crypto.randomUUID();
//!
//! // 2. invoke() より先に listen() を完了させる(取りこぼし防止。reframe.rs 冒頭参照)。
//! //    キャッシュヒット時は render_preview が pipeline::reframe を呼ばないため
//! //    progress が一度も発火しないまま done が来ることがある — これは正常系。
//! const unlistenProgress = await listen<Progress>(`preview://progress/${jobId}`, (event) => {
//!   console.log(event.payload.percent);
//! });
//! const unlistenDone = await listen<{ path: string }>(`preview://done/${jobId}`, (event) => {
//!   videoEl.src = convertFileSrc(event.payload.path);
//! });
//! const unlistenError = await listen<{ message: string }>(`preview://error/${jobId}`, (event) => {
//!   console.error(event.payload.message);
//! });
//!
//! // 3. 購読が揃ってからジョブを開始する。done の payload は生成(またはキャッシュヒットした)
//! //    プレビューファイルの絶対パス。renderer は <video>/<img> の src にそのまま使えないので
//! //    convertFileSrc を通す。
//! //    quality は省略可("preview" 既定)。"publish" を渡すと本書き出しと同一品質
//! //    (8Mbps)で publish-cache へ生成する(IG 投稿用 — §モジュール冒頭)。
//! await invoke("preview_start", {
//!   jobId,
//!   input: "/path/to/input.mp4",
//!   spec, // EditSpec
//!   quality: "publish", // 省略時 "preview"
//! });
//!
//! // 4. 中断したい場合は reframe_cancel を使う(専用コマンドはない。モジュール冒頭参照)。
//! await invoke("reframe_cancel", { jobId });
//! ```
//!
//! ## キャッシュディレクトリ
//!
//! `cache_dir` は Tauri の `app_data_dir()` 配下のサブディレクトリを使う
//! (`AppHandle` から `app.path().app_data_dir()` で取得する。プラットフォーム別の
//! 実際のパスは Tauri のドキュメント参照)。品質ごとに分離する:
//! `quality: "preview"`(既定)は `preview-cache`、`quality: "publish"` は
//! `publish-cache`(2Mbps のプレビュー生成物が誤って投稿されない・その逆も起きない
//! 構造的分離。`media_core::preview` モジュール冒頭コメント参照)。取得に失敗した
//! 場合(通常は環境不備)はジョブを開始せず、`preview_start` 自体がエラーを返す
//! (`run_job` に到達する前に弾く)。
//!
//! キャッシュの削除ポリシー(容量上限・古い順削除)は media_core 側が品質ごとに
//! 独立して適用する(本コマンド層は掃除を一切行わない)。

use std::path::{Path, PathBuf};

use media_core::spec::EditSpec;
use media_core::{preview, CancelToken};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use super::reframe::{run_media_job, JobId, JobsState};

/// プレビュー品質のキャッシュディレクトリ名(`app_data_dir()` からの相対)。
const CACHE_DIR_NAME: &str = "preview-cache";

/// 投稿品質([`RenderQuality::Publish`])のキャッシュディレクトリ名
/// (`app_data_dir()` からの相対。[`CACHE_DIR_NAME`] と分離する — モジュール冒頭参照)。
const PUBLISH_CACHE_DIR_NAME: &str = "publish-cache";

/// レンダリング品質。renderer から `quality` 引数として渡される
/// (省略時は [`RenderQuality::Preview`])。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderQuality {
	/// 低ビットレート(2Mbps)・`preview-cache`。編集中の目視確認用。
	#[default]
	Preview,
	/// 本書き出しと同一品質(8Mbps)・`publish-cache`。IG 等への投稿用。
	Publish,
}

impl RenderQuality {
	/// この品質のキャッシュディレクトリ名(`app_data_dir()` からの相対)。
	fn cache_dir_name(self) -> &'static str {
		match self {
			RenderQuality::Preview => CACHE_DIR_NAME,
			RenderQuality::Publish => PUBLISH_CACHE_DIR_NAME,
		}
	}
}

/// `preview://done/{jobId}` イベントのペイロード。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewDone {
	/// 生成(またはキャッシュヒット)したプレビューファイルの絶対パス。
	/// renderer は `convertFileSrc` を通してから `<video>`/`<img>` の `src` に使う
	/// (モジュール冒頭の renderer 向け API 参照)。
	path: String,
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

/// `app` の `app_data_dir()` 配下に `quality` に応じたキャッシュディレクトリのパスを
/// 組み立てる。ディレクトリの作成自体は media_core 側(`render_preview`/`render_publish`)
/// が `fs::create_dir_all` で行う(ここではパスの計算のみ)。
fn resolve_cache_dir(app: &AppHandle, quality: RenderQuality) -> Result<PathBuf, String> {
	let base = app
		.path()
		.app_data_dir()
		.map_err(|err| format!("アプリデータディレクトリの取得に失敗しました: {err}"))?;
	Ok(base.join(quality.cache_dir_name()))
}

/// `input` を `spec` の指定形状へ再フレーミングするジョブを開始する
/// (`reframe_start` と同じ [`JobsState`] を共有する)。品質は `quality` で選ぶ
/// (省略時はプレビュー品質 2Mbps。`"publish"` で本書き出しと同一品質 8Mbps —
/// モジュール冒頭コメント参照)。
///
/// `job_id` は renderer 側が採番して渡す(`reframe.rs` 冒頭コメント「jobId 採番を
/// フロントエンドへ移した理由」参照)。ジョブ本体はバックグラウンドスレッドで実行され、
/// この関数はジョブ登録後すぐに返る(完了を待たない)。進捗・完了は上記モジュール doc の
/// Tauri イベントで通知する。キャッシュヒット時は再エンコードせず、ほぼ即座に `done`
/// イベントが発火する。
///
/// 同じ `job_id` のジョブ(`reframe_start` 経由のものも含む — ジョブ ID 空間を共有する)
/// が既に実行中の場合は `try_register` が拒否し、ジョブを開始せず `Err` を返す
/// (`reframe_start` と同じ挙動。`reframe.rs` の doc コメント参照)。
#[tauri::command]
pub async fn preview_start(
	app: AppHandle,
	jobs: State<'_, JobsState>,
	job_id: JobId,
	input: String,
	spec: EditSpec,
	quality: Option<RenderQuality>,
) -> Result<(), String> {
	let quality = quality.unwrap_or_default();
	let cache_dir = resolve_cache_dir(&app, quality)?;

	let token = CancelToken::new();
	if !jobs.try_register(job_id.clone(), token) {
		return Err("このジョブは既に実行中です".to_string());
	}

	let app_for_task = app.clone();
	let job_id_for_task = job_id;
	let input_path = PathBuf::from(input);

	tauri::async_runtime::spawn_blocking(move || {
		run_job(
			&app_for_task,
			&job_id_for_task,
			&input_path,
			&cache_dir,
			spec,
			quality,
		);
	});

	Ok(())
}

/// ジョブ本体(ブロッキングスレッド上で実行)。`quality` に応じて
/// `media_core::render_preview` / `media_core::render_publish` を呼び、
/// 完了イベントを emit してからジョブを State から削除する
/// (`reframe.rs` の `run_job` と対応する構造)。
///
/// **P1-5: パニック時の State リーク対策**(`reframe.rs` の `run_job` と同型)。
/// 共通の骨格(トークン取得・`JobGuard`・進捗 emit・`catch_unwind`・done/error emit)は
/// [`run_media_job`] に集約している(P2: `reframe.rs::run_job` との重複解消。詳細は
/// `run_media_job` 冒頭コメント参照)。ここでは品質別レンダリング固有の引数組み立てと、
/// 成功時の done ペイロード([`PreviewDone`])への変換のみを行う。
fn run_job(
	app: &AppHandle,
	job_id: &str,
	input: &Path,
	cache_dir: &Path,
	spec: EditSpec,
	quality: RenderQuality,
) {
	run_media_job(
		app,
		job_id,
		progress_event_name(job_id),
		done_event_name(job_id),
		error_event_name(job_id),
		move |token, on_progress| match quality {
			RenderQuality::Preview => {
				preview::render_preview(input, &spec, cache_dir, token, on_progress)
			}
			RenderQuality::Publish => {
				preview::render_publish(input, &spec, cache_dir, token, on_progress)
			}
		},
		|path| PreviewDone {
			path: path.to_string_lossy().into_owned(),
		},
	);
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
		assert_eq!(PUBLISH_CACHE_DIR_NAME, "publish-cache");
	}

	#[test]
	fn render_quality_maps_to_separate_cache_dirs() {
		// プレビュー品質と投稿品質でキャッシュディレクトリが分離されていること
		// (2Mbps 生成物と 8Mbps 生成物の取り違えが構造的に起きないこと)の固定。
		assert_eq!(RenderQuality::Preview.cache_dir_name(), "preview-cache");
		assert_eq!(RenderQuality::Publish.cache_dir_name(), "publish-cache");
		assert_ne!(
			RenderQuality::Preview.cache_dir_name(),
			RenderQuality::Publish.cache_dir_name()
		);
	}

	#[test]
	fn render_quality_defaults_to_preview() {
		// `quality` 省略時(既存の renderer 呼び出し)は従来どおりプレビュー品質。
		assert_eq!(RenderQuality::default(), RenderQuality::Preview);
	}

	#[test]
	fn render_quality_deserializes_from_lowercase_strings() {
		// renderer からは "preview" / "publish" の小文字文字列で渡される
		// (`serde(rename_all = "lowercase")` の固定)。
		let preview: RenderQuality =
			serde_json::from_str("\"preview\"").expect("deserialize preview");
		let publish: RenderQuality =
			serde_json::from_str("\"publish\"").expect("deserialize publish");
		assert_eq!(preview, RenderQuality::Preview);
		assert_eq!(publish, RenderQuality::Publish);
		// 未知の値はエラーになる(黙って Preview に落ちない)。
		assert!(serde_json::from_str::<RenderQuality>("\"high\"").is_err());
	}

	// --- JobsState 経由のジョブ登録/共有(reframe.rs 側の JobsState テストと重複させず、
	//     preview.rs が reframe.rs の JobsState を問題なく再利用できることのみ確認) ---

	#[test]
	fn preview_and_reframe_share_job_id_space() {
		let jobs = JobsState::default();
		let token = CancelToken::new();
		let job_id = "job-a".to_string();
		assert!(jobs.try_register(job_id.clone(), token.clone()));

		// reframe_cancel が使う cancel() を preview 側で登録したジョブに対して呼べる。
		jobs.cancel(&job_id)
			.expect("shared job must be cancellable");
		assert!(token.is_cancelled());
	}

	#[test]
	fn preview_try_register_rejects_job_id_already_used_by_reframe() {
		// アーキテクチャレビュー指摘対応: reframe/preview はジョブ ID 空間を共有するため、
		// 片方が登録した job_id はもう片方の try_register からも拒否されるべきこと
		// (どちらの呼び出し元から見ても「二重開始」であることに変わりはない)を確認する。
		let jobs = JobsState::default();
		let token_from_reframe = CancelToken::new();
		let token_from_preview = CancelToken::new();
		let job_id = "job-a".to_string();

		assert!(jobs.try_register(job_id.clone(), token_from_reframe));
		assert!(
			!jobs.try_register(job_id.clone(), token_from_preview),
			"reframe 側が登録済みの job_id は preview_start からも拒否される"
		);
	}
}
