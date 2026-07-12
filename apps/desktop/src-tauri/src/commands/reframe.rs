//! `reframe_start` / `reframe_cancel` コマンド: `media_core::reframe` を非同期に実行し、
//! 進捗・完了を Tauri イベントで通知する。
//!
//! `reframe_cancel` はジョブ ID 空間を [`crate::commands::preview`] と共有しており、
//! `preview_start` が返した `jobId` に対しても同じコマンドでキャンセルできる
//! (両モジュールとも同一の [`JobsState`] に登録するため。`preview.rs` 冒頭コメント参照)。
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
//! // encoder は省略可能。省略または "auto" なら自動選択(EncoderSelection::Auto)。
//! // それ以外("h264_amf" / "h264_mf" 等)は明示指定で、そのプラットフォームの候補
//! // テーブルに存在しない名前を渡すとジョブを起動せずに Err を返す
//! // (encoder_choice_from_param がジョブ登録前に検証する)。
//! const jobId = await invoke<string>("reframe_start", {
//!   input: "/path/to/input.mp4",
//!   output: "/path/to/output.mp4",
//!   spec, // EditSpec
//!   encoder: "auto", // 省略可。"h264_amf" 等の明示指定も可
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
//!
//! // 5. 設定画面から同時実行エンコード数(1〜4)を変更する場合(即時反映。
//! //    実行中ジョブの既得スロットは奪わず、以後の新規取得のみ新上限に従う)。
//! await invoke("set_max_concurrent_encodes", { max: 2 });
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

use media_core::encoder_select::{self, EncoderChoice};
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
	///
	/// `pub(crate)`: `commands::preview` がジョブ ID 空間を共有する
	/// (`preview_start` も同じ [`JobsState`] に登録し、`reframe_cancel` を
	/// そのままキャンセルコマンドとして再利用できるようにするため)。
	pub(crate) fn register(&self, token: CancelToken) -> JobId {
		let job_id = Uuid::new_v4().to_string();
		self.lock().insert(job_id.clone(), token);
		job_id
	}

	/// `job_id` に紐づく [`CancelToken`] の clone を返す(`Arc` 共有なので安価)。
	pub(crate) fn get(&self, job_id: &str) -> Option<CancelToken> {
		self.lock().get(job_id).cloned()
	}

	/// `job_id` の [`CancelToken`] に `cancel()` を呼ぶ。未登録(既に完了済み含む)なら
	/// `Err` を返す。
	pub(crate) fn cancel(&self, job_id: &str) -> Result<(), String> {
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
	pub(crate) fn remove(&self, job_id: &str) {
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

fn progress_event_name(job_id: &str) -> String {
	format!("reframe://progress/{job_id}")
}

fn done_event_name(job_id: &str) -> String {
	format!("reframe://done/{job_id}")
}

fn error_event_name(job_id: &str) -> String {
	format!("reframe://error/{job_id}")
}

/// `encoder` invoke パラメータ(UI の手動選択、省略可能)を [`EncoderChoice`] へ解決する。
///
/// - `None` または `Some("auto")` は自動選択(`EncoderSelection::Auto` に対応)を表す
///   `Ok(None)`。
/// - それ以外の文字列は `encoder_select::find_choice` で `platform` の候補テーブルから
///   引く。見つからなければ、そのプラットフォームで利用可能な候補名を列挙した日本語
///   エラーメッセージで `Err` を返す。
///
/// [`reframe_start`] はジョブ登録**前**にこれを呼ぶ(無効な `encoder` 値でジョブを
/// 起動しないため)。`platform` を引数として注入しているのはテストで
/// `Platform::Windows` 等を固定して検証するため
/// (`encoder_select::Platform::current` はビルド時の `cfg(target_os)` に依存し、
/// テスト環境では固定できない)。
fn encoder_choice_from_param(
	platform: encoder_select::Platform,
	param: Option<&str>,
) -> Result<Option<EncoderChoice>, String> {
	match param {
		None | Some("auto") => Ok(None),
		Some(name) => encoder_select::find_choice(platform, name)
			.map(Some)
			.ok_or_else(|| {
				let available: Vec<&str> = encoder_select::candidate_table(platform)
					.iter()
					.map(|choice| choice.name)
					.collect();
				let available = if available.is_empty() {
					"このプラットフォームでは利用可能な候補がありません".to_string()
				} else {
					available.join(", ")
				};
				format!("不明なエンコーダ指定です: {name}(利用可能な候補: {available})")
			}),
	}
}

/// `input` を `spec` の指定形状へ再フレーミングするジョブを開始し、`JobId` を返す。
///
/// ジョブ本体はバックグラウンドスレッドで実行され、この関数はジョブ登録後すぐに
/// 返る(完了を待たない)。進捗・完了は上記モジュール doc の Tauri イベントで通知する。
///
/// `encoder` は省略可能(省略時は `None`)。[`encoder_choice_from_param`] で解決し、
/// 無効な値であればジョブを登録せずに `Err` を返す(モジュール doc §renderer 向け API
/// 参照)。
#[tauri::command]
pub async fn reframe_start(
	app: AppHandle,
	jobs: State<'_, JobsState>,
	input: String,
	output: String,
	spec: EditSpec,
	encoder: Option<String>,
) -> Result<JobId, String> {
	let encoder_choice =
		encoder_choice_from_param(encoder_select::Platform::current(), encoder.as_deref())?;

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
			encoder_choice,
		);
	});

	Ok(job_id)
}

/// 同時実行エンコード数の上限を実行時に変更する(設定画面から呼ばれる想定)。
///
/// UI は 1〜4 の範囲で `max` を渡す想定だが、範囲外の値をここで拒否することはせず
/// `EncodeSlots::set_max` の 0→1 切り上げ(`concurrency.rs` 参照)にそのまま委ねる。
/// 実行中ジョブが既に取得済みのスロットは奪わない(以後の新規取得のみ新上限に従う)。
#[tauri::command]
pub fn set_max_concurrent_encodes(max: usize) {
	media_core::concurrency::EncodeSlots::global().set_max(max);
}

/// ジョブ本体(ブロッキングスレッド上で実行)。State からトークンを取り出し、
/// `media_core::reframe` を呼び、完了イベントを emit してからジョブを State から削除する。
///
/// App ハンドルと `JobsState`(`app.state()` 経由)にのみ依存し、`spec`/`input`/`output`
/// は素の値で受け取るため、`AppHandle` を持たないテストでも
/// [`ReframeOptions`] の組み立て部分だけを切り出して検証できる
/// (実際の単体テストは `JobsState` の登録/キャンセル、`media_core::reframe` の呼び出しは
/// media-core 側で検証済みのため本ファイルでは重複させない — 下記 `tests` モジュール参照)。
///
/// **P1-5: パニック時の State リーク対策**。共通の骨格(トークン取得・`JobGuard`・
/// 進捗 emit・`catch_unwind`・done/error emit)は [`run_media_job`] に集約している
/// (P2: `commands::preview::run_job` との重複解消。詳細は `run_media_job` 冒頭コメント参照)。
/// ここでは `media_core::reframe` 固有の [`ReframeOptions`] 組み立てと、成功時の
/// done ペイロード([`ReframeDone`])への変換のみを行う。
///
/// `encoder_choice` は [`encoder_choice_from_param`] が解決した結果。`None` は
/// `EncoderSelection::Auto`、`Some(choice)` は `choice.name`/`choice.to_dictionary()`
/// を使った `EncoderSelection::Explicit` に変換する。
fn run_job(
	app: &AppHandle,
	job_id: &str,
	input: &Path,
	output: &Path,
	spec: EditSpec,
	encoder_choice: Option<EncoderChoice>,
) {
	run_media_job(
		app,
		job_id,
		progress_event_name(job_id),
		done_event_name(job_id),
		error_event_name(job_id),
		move |token, on_progress| {
			let encoder = match encoder_choice {
				None => EncoderSelection::Auto,
				Some(choice) => EncoderSelection::Explicit {
					name: choice.name,
					options: choice.to_dictionary(),
				},
			};
			let options = ReframeOptions {
				preset: &spec.preset,
				sigma: fit::DEFAULT_SIGMA,
				crop: spec.crop,
				source: spec.source,
				trim: spec.trim,
				encoder,
				bit_rate: encode::DEFAULT_BITRATE,
				cancel: token,
				on_progress,
			};
			media_core::reframe(input, output, options)
		},
		|encoder_name| ReframeDone {
			encoder: encoder_name,
		},
	);
}

/// [`run_job`] 終了時に必ず `jobs.remove(job_id)` を呼ぶ RAII ガード(P1-5)。
///
/// `pub(crate)`: [`run_media_job`] が保持し、`commands::preview` からも
/// (`run_media_job` 経由で間接的に)使われる。`JobsState` 自体を共有しているのと
/// 同じ理由で、ガードもここで一元定義する。
pub(crate) struct JobGuard<'a> {
	pub(crate) jobs: &'a JobsState,
	pub(crate) job_id: &'a str,
}

impl Drop for JobGuard<'_> {
	fn drop(&mut self) {
		self.jobs.remove(self.job_id);
	}
}

/// `reframe://error/{jobId}` / `preview://error/{jobId}` イベント共通のペイロード
/// (キャンセルも含む。`MediaError` の `Display` をそのまま文字列化する。P2)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobErrorPayload {
	pub(crate) message: String,
}

/// [`reframe::run_job`] と [`crate::commands::preview::run_job`] に共通する
/// ジョブ実行の骨格を集約する(P2: Wave A で共有した [`JobGuard`] の続き)。
///
/// 両モジュールの `run_job` は「State からトークンを取得 → [`JobGuard`] で RAII 解放を
/// 予約 → 進捗 emit クロージャを組み立て → 本体処理を `catch_unwind` で包んで実行 →
/// 成功/失敗/パニックのいずれかで done または error イベントを emit」という同じ構造を
/// 持つ。異なるのは (a) 本体処理そのもの(`media_core::reframe` vs
/// `media_core::preview::render_preview` — 引数の組み立ても含む)と (b) 成功時の戻り値の
/// 型・done イベントのペイロード形(`{encoder}` vs `{path}`)の 2 点のみのため、この 2 つを
/// クロージャ(`operation`)と変換関数(`to_done_payload`)として呼び出し側から注入する形で
/// 共通化する。挙動は集約前(各モジュールに個別実装されていた `run_job`)と変えない。
///
/// - `progress_event`/`done_event`/`error_event`: 呼び出し側(各モジュールの
///   `progress_event_name`/`done_event_name`/`error_event_name`、集約前から変えていない)
///   が組み立てた完全なイベント名。`"reframe://"`/`"preview://"` の接頭辞違いをここで
///   吸収するのではなく、呼び出し側の既存ヘルパをそのまま使う(イベント名の単体テストを
///   モジュールごとに残せるようにするため)。
/// - `operation`: 実際の重い処理。`&CancelToken`/`&dyn Fn(Progress)` を受け取り
///   `media_core::Result<T>` を返す(`ReframeOptions`/`render_preview` の引数組み立ては
///   呼び出し側のクロージャ内で行う — トークン/進捗クロージャの寿命がこの関数呼び出し
///   の中に閉じているため)。
/// - `to_done_payload`: 成功値 `T` を done イベントのペイロード(`Serialize`)へ変換する。
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_media_job<T, D>(
	app: &AppHandle,
	job_id: &str,
	progress_event: String,
	done_event: String,
	error_event: String,
	operation: impl FnOnce(&CancelToken, &dyn Fn(Progress)) -> media_core::Result<T>,
	to_done_payload: impl FnOnce(T) -> D,
) where
	D: Serialize + Clone,
{
	let jobs = app.state::<JobsState>();
	let Some(token) = jobs.get(job_id) else {
		// register 直後に必ず存在するはずだが、万一取得できなくても panic はしない。
		return;
	};

	// `jobs.remove(job_id)` を関数を抜けるあらゆる経路(正常終了・catch_unwind 後の
	// 通常 return・将来の早期 return 追加)で保証する RAII ガード。
	let _remove_on_exit = JobGuard {
		jobs: &jobs,
		job_id,
	};

	let app_for_progress = app.clone();
	let on_progress = move |progress: Progress| {
		let _ = app_for_progress.emit(&progress_event, progress);
	};

	// `operation` はクロージャ・参照を含み厳密には UnwindSafe ではないが、
	// パニック発生時点でそのまま破棄するだけ(catch_unwind 後に再利用しない)なので
	// `AssertUnwindSafe` で問題ない(集約前の各 `run_job` と同じ判断)。
	let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
		operation(&token, &on_progress)
	}));

	match result {
		Ok(Ok(value)) => {
			let _ = app.emit(&done_event, to_done_payload(value));
		}
		Ok(Err(err)) => {
			let _ = app.emit(
				&error_event,
				JobErrorPayload {
					message: err.to_string(),
				},
			);
		}
		Err(_panic) => {
			let _ = app.emit(
				&error_event,
				JobErrorPayload {
					message: "内部エラーが発生しました(パニック)".to_string(),
				},
			);
		}
	}

	// `jobs.remove(job_id)` は `_remove_on_exit` の Drop で行われる(ここでは何もしない)。
}

/// `job_id` のジョブをキャンセルする。次のループ境界チェック(パケット単位)で
/// `media_core::reframe`(または `preview_start` 経由の `media_core::render_preview`)が
/// `MediaError::Cancelled` を返し、`reframe://error/{jobId}` または `preview://error/{jobId}`
/// が発火する(一時出力は `media_core` 側で削除済み — `pipeline.rs` 冒頭コメント参照)。
/// `job_id` が `preview_start` の戻り値であっても、このコマンドをそのまま使う
/// (ジョブ ID 空間の共有。`preview.rs` 冒頭コメント参照)。
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

	// --- encoder_choice_from_param ---------------------------------------------------

	#[test]
	fn encoder_choice_from_param_none_or_auto_means_auto_selection() {
		assert_eq!(
			encoder_choice_from_param(encoder_select::Platform::Windows, None),
			Ok(None)
		);
		assert_eq!(
			encoder_choice_from_param(encoder_select::Platform::Windows, Some("auto")),
			Ok(None)
		);
	}

	#[test]
	fn encoder_choice_from_param_resolves_h264_mf_with_hw_encoding_option() {
		let choice = encoder_choice_from_param(encoder_select::Platform::Windows, Some("h264_mf"))
			.expect("h264_mf should resolve")
			.expect("should be Some");
		assert_eq!(choice.name, "h264_mf");
		assert_eq!(choice.options, &[("hw_encoding", "1")]);
	}

	#[test]
	fn encoder_choice_from_param_unknown_name_lists_available_candidates() {
		let err = encoder_choice_from_param(encoder_select::Platform::Windows, Some("libx264"))
			.expect_err("libx264 is not a windows candidate");
		assert!(err.contains("h264_amf"), "message was: {err}");
		assert!(err.contains("h264_mf"), "message was: {err}");
	}

	#[test]
	fn encoder_choice_from_param_errors_on_unsupported_platform_with_explicit_name() {
		let err = encoder_choice_from_param(encoder_select::Platform::Other, Some("h264_amf"))
			.expect_err("Other platform has no candidates");
		assert!(err.contains("h264_amf"), "message was: {err}");
	}
}
