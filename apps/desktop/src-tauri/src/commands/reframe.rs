//! `reframe_start` / `reframe_cancel` コマンド: `media_core::reframe` を非同期に実行し、
//! 進捗・完了を Tauri イベントで通知する。
//!
//! `reframe_cancel` はジョブ ID 空間を [`crate::commands::preview`] と共有しており、
//! `preview_start` が受け取った `jobId` に対しても同じコマンドでキャンセルできる
//! (両モジュールとも同一の [`JobsState`] に登録するため。`preview.rs` 冒頭コメント参照)。
//! [`JobsState`] 自体の実装(try_register/get/cancel/remove 等)は
//! [`crate::commands::job_state`] に集約されている(アーキテクチャレビュー指摘対応。
//! `commands::publish::ig`/`commands::publish::youtube` と重複していた3実装を統一した。
//! 詳細は `job_state` モジュール冒頭コメント参照)。
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
//! // 1. jobId は呼び出し側(renderer)が採番する(crypto.randomUUID() 等)。
//! //    Rust 側では採番しない — 理由は下記「jobId 採番をフロントエンドへ移した理由」参照。
//! const jobId = crypto.randomUUID();
//!
//! // 2. invoke() より先に listen() を完了させる(取りこぼし防止。理由は下記参照)。
//! const unlistenProgress = await listen<Progress>(`reframe://progress/${jobId}`, (event) => {
//!   console.log(event.payload.percent);
//! });
//! const unlistenDone = await listen<{ encoder: string }>(`reframe://done/${jobId}`, (event) => {
//!   console.log("encoder used:", event.payload.encoder);
//! });
//! const unlistenError = await listen<{ message: string }>(`reframe://error/${jobId}`, (event) => {
//!   console.error(event.payload.message);
//! });
//!
//! // 3. 購読が揃ってからジョブを開始する。
//! // encoder は省略可能。省略または "auto" なら自動選択(EncoderSelection::Auto)。
//! // それ以外("h264_amf" / "h264_mf" 等)は明示指定で、そのプラットフォームの候補
//! // テーブルに存在しない名前を渡すとジョブを起動せずに Err を返す
//! // (encoder_choice_from_param がジョブ登録前に検証する)。
//! // output が input と同一ファイルを指す場合も同様にジョブを起動せず Err を返す
//! // (output_targets_input がジョブ登録前に検証する。rename で入力を上書きし
//! // 元の動画を失うデータ損失事故を防ぐガード)。
//! await invoke("reframe_start", {
//!   jobId,
//!   input: "/path/to/input.mp4",
//!   output: "/path/to/output.mp4",
//!   spec, // EditSpec
//!   encoder: "auto", // 省略可。"h264_amf" 等の明示指定も可
//! });
//!
//! // 4. 完了 / 失敗イベント(いずれか一方が必ず一度だけ発火する。キャンセルも失敗の一種として
//! //    `reframe://error/${jobId}` に "キャンセルされました" のメッセージで通知される)。
//! //    listen() を invoke() より先に張っているため、ジョブがどれだけ早く完了/失敗しても
//! //    取りこぼさない。
//!
//! // 5. 中断したい場合。
//! await invoke("reframe_cancel", { jobId });
//!
//! // 6. 設定画面から同時実行エンコード数(1〜4)を変更する場合(即時反映。
//! //    実行中ジョブの既得スロットは奪わず、以後の新規取得のみ新上限に従う)。
//! await invoke("set_max_concurrent_encodes", { max: 2 });
//! ```
//!
//! ### jobId 採番をフロントエンドへ移した理由(バグ2 対策)
//!
//! 以前は `reframe_start` が Rust 側で jobId を採番し、その戻り値を待ってから
//! renderer が `listen()` を張っていた。しかしジョブは `reframe_start` 内で
//! `spawn_blocking` された直後から進行し(OutputBusy 等の即時エラーはマイクロ秒単位で
//! 発火しうる)、`reframe_start` の `Result` が renderer に届く IPC 応答と、
//! イベント emit の IPC は別経路のため到達順序の保証が無い。つまり
//! 「jobId が Rust 側にしか無い」設計では、renderer が `listen()` を張る前に
//! イベントが発火して取りこぼす構造的なレースを避けられなかった。
//! jobId を renderer 側で先に採番し、`listen()` の完了を待ってから `invoke()` する
//! ことで、ジョブが実際に開始される(= イベントが発火しうる)より前に購読が
//! 確実に完了していることを保証できる。
//!
//! `reframe_start` はジョブをバックグラウンド(`tauri::async_runtime::spawn_blocking`、
//! tokio のブロッキングスレッドプール)へ投げて即座に返る(reframe 本体の完了を
//! 待たない)。同時実行数の制限は `media_core::concurrency::EncodeSlots` が
//! `media_core::reframe` 内部で担うため、複数ジョブを同時に `reframe_start` してよい
//! (`concurrency.rs` 冒頭コメント参照)。
//!
//! ## State / スレッド設計
//!
//! - [`JobsState`] は [`crate::commands::job_state::JobsState`]
//!   (`Mutex<HashMap<JobId, CancelToken>>`)をラップした newtype(`lib.rs` の
//!   `.manage(JobsState::default())` でアプリ全体に 1 つ登録する)。共通実装は
//!   `job_state` に集約しているが、Tauri の `State<T>` は型ごとにインスタンスを管理する
//!   ため、`preview`/`ig`/`youtube` とジョブ ID 空間を分離するために newtype で包んでいる
//!   (`job_state` モジュール冒頭コメント参照)。
//! - `reframe_start` は renderer から渡された `job_id` に対して [`CancelToken`] を発行し、
//!   `try_register` で State に挿入する(既に同じ `job_id` が登録済みなら `Err` を返し
//!   ジョブを開始しない)。同じトークンの clone(`Arc<AtomicBool>` の共有、安価)を
//!   ブロッキングタスクへ渡す。
//! - `reframe_cancel` は State からトークンを取得して `cancel()` を呼ぶだけ
//!   (トークン自体はブロッキングタスク側が `is_cancelled()` をループ境界で見ている
//!   — `media_core::cancel` 冒頭コメント参照)。
//! - ジョブ完了(成功・失敗・キャンセルいずれも)時、ブロッキングタスク自身が
//!   State からエントリを削除する(完了後に `reframe_cancel` を呼んでも
//!   "未知のジョブ" エラーになる)。
//!
//! ## ステージングディレクトリ
//!
//! `media_core::reframe` の一時出力ファイル(`pipeline.rs` の `<stem>.tmp.<ext>`)は、
//! 既定では書き出し先(`output`)と同じディレクトリに作られる。デスクトップ書き出しの
//! 出力先はユーザーが選ぶ実フォルダ(デスクトップ等)であることが多く、中間ファイルが
//! そこに一時的に見えてしまう。これを避けるため `reframe_start` は
//! `app.path().app_data_dir()/export-staging`([`resolve_staging_dir`])を
//! `ReframeOptions.staging_dir` として渡し、一時ファイルをアプリ管理のディレクトリ
//! 配下に隔離する(`pipeline.rs` モジュール冒頭コメント「`ReframeOptions.staging_dir`」
//! 参照)。完了時は media-core 側が `output` へ確定させる(同一ボリュームなら
//! `fs::rename`、別ボリュームなら `fs::copy` + 削除にフォールバック)。
//!
//! **孤児ファイルの掃除**: 通常は `pipeline::reframe` の finalize/キャンセル/失敗時
//! クリーンアップで一時ファイルは即座に消えるが、アプリのクラッシュ・強制終了等で
//! それをすり抜けた「孤児」がステージングディレクトリに残り続ける可能性がある。
//! [`resolve_staging_dir`] は呼び出しごと(= ジョブ開始ごと)に
//! [`sweep_orphaned_staging_files`] を実行し、24 時間以上前の一時ファイルらしき
//! ファイルをベストエフォートで削除する(`preview.rs::evict_if_over_limit` と同じ
//! 「読み取り/削除の失敗は個別にスキップし、呼び出し元にエラーを伝搬しない」方針)。
//!
//! `preview_start`([`crate::commands::preview`])は変更していない — プレビューの
//! 一時ファイルは元から `output_path`(= プレビューキャッシュファイル)と同じ
//! `cache_dir` 配下に書かれ、ユーザーから見える場所には出ないため
//! (`media_core::preview::render_preview` は `staging_dir: None` のまま呼ぶ)。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use media_core::encoder_select::{self, EncoderChoice};
use media_core::spec::EditSpec;
use media_core::{encode, fit, CancelToken, EncoderSelection, Progress, ReframeOptions};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::job_state;

/// renderer が採番し `reframe_start`/`preview_start` へ渡すジョブ ID。
/// 進捗/完了イベント名の組み立てにも使う。
pub type JobId = job_state::JobId;

/// 実行中ジョブの [`CancelToken`] を保持する State(reframe/preview 共有のジョブ ID
/// 空間)。
///
/// 共通実装は [`job_state::JobsState`] に集約しており、本 struct はジョブ ID 空間を
/// `publish::ig`/`publish::youtube` と分離するための薄い newtype(`Deref` で
/// `try_register`/`get`/`cancel`/`remove` をそのまま委譲する。`job_state` モジュール
/// 冒頭コメント「統一した経緯」参照)。
#[derive(Default)]
pub struct JobsState(job_state::JobsState);

impl std::ops::Deref for JobsState {
	type Target = job_state::JobsState;

	fn deref(&self) -> &Self::Target {
		&self.0
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

/// ステージングディレクトリ名(`app_data_dir()` からの相対。モジュール冒頭コメント
/// 「ステージングディレクトリ」参照)。
const STAGING_DIR_NAME: &str = "export-staging";

/// 孤児ステージングファイルとみなす経過時間(24 時間)。この期間以上前の一時ファイルは
/// `pipeline::reframe` 側のクリーンアップ(finalize/キャンセル/失敗時削除)をすり抜けた
/// もの(アプリのクラッシュ・強制終了等)とみなし、[`sweep_orphaned_staging_files`] の
/// 対象にする。
const ORPHAN_STAGING_FILE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// `app` の `app_data_dir()` 配下にステージングディレクトリのパスを組み立て、
/// 存在しなければ作成する。作成(または既存確認)後、[`sweep_orphaned_staging_files`]
/// を呼んで孤児ファイルをベストエフォートで掃除する
/// (`preview.rs::resolve_cache_dir` と同じパス組み立てパターン。掃除の呼び出しが
/// 追加されている点のみ異なる — モジュール冒頭コメント参照)。
fn resolve_staging_dir(app: &AppHandle) -> Result<PathBuf, String> {
	let base = app
		.path()
		.app_data_dir()
		.map_err(|err| format!("アプリデータディレクトリの取得に失敗しました: {err}"))?;
	let dir = base.join(STAGING_DIR_NAME);
	fs::create_dir_all(&dir).map_err(|err| {
		format!(
			"ステージングディレクトリの作成に失敗しました: {} ({err})",
			dir.display()
		)
	})?;
	sweep_orphaned_staging_files(&dir, ORPHAN_STAGING_FILE_MAX_AGE);
	Ok(dir)
}

/// `name` が `media_core::pipeline` の staging tmp 命名規則
/// (`<stem>-<token>.tmp.<ext>` または拡張子なしの `<stem>-<token>.tmp`)に緩く一致するかを
/// 判定する。掃除対象を「このアプリが作った一時ファイルらしいもの」に限定し、
/// ステージングディレクトリに万一別の何かが置かれていても誤って削除しないための
/// 簡易フィルタ(`pipeline.rs::staging_temp_output_path` 参照)。
fn looks_like_staging_tmp_name(name: &str) -> bool {
	name.ends_with(".tmp") || name.contains(".tmp.")
}

/// `dir` 配下の[一時ファイルらしい名前](looks_like_staging_tmp_name)かつ `mtime` が
/// `max_age` より古いファイルをベストエフォートで削除する
/// (モジュール冒頭コメント「ステージングディレクトリ」参照)。
///
/// `preview.rs::evict_if_over_limit` と同じ方針: `read_dir`/`metadata`/`remove_file` の
/// 失敗は個別にスキップし(ロック中のファイル等)、呼び出し元にエラーを伝搬しない。
fn sweep_orphaned_staging_files(dir: &Path, max_age: Duration) {
	let entries = match fs::read_dir(dir) {
		Ok(entries) => entries,
		Err(err) => {
			eprintln!(
				"facet desktop: ステージングディレクトリの読み取りに失敗しました(掃除をスキップ): {} ({err})",
				dir.display()
			);
			return;
		}
	};

	let now = SystemTime::now();

	for entry in entries {
		let entry = match entry {
			Ok(entry) => entry,
			Err(err) => {
				eprintln!(
					"facet desktop: ステージングディレクトリのエントリ読み取りに失敗しました(スキップ): {err}"
				);
				continue;
			}
		};
		let path = entry.path();
		let name_matches = path
			.file_name()
			.and_then(|name| name.to_str())
			.is_some_and(looks_like_staging_tmp_name);
		if !name_matches {
			continue;
		}
		let metadata = match entry.metadata() {
			Ok(metadata) => metadata,
			Err(err) => {
				eprintln!(
					"facet desktop: ステージングファイルの metadata 取得に失敗しました(スキップ): {} ({err})",
					path.display()
				);
				continue;
			}
		};
		if !metadata.is_file() {
			continue;
		}
		// mtime 取得失敗、または `now` より未来の mtime(時計のズレ等)は掃除対象に
		// しない(保守的な既定 — 誤って新しいファイルを消すよりは掃除を見送る)。
		let is_orphan = metadata
			.modified()
			.ok()
			.and_then(|mtime| now.duration_since(mtime).ok())
			.is_some_and(|age| age > max_age);
		if !is_orphan {
			continue;
		}
		if let Err(err) = fs::remove_file(&path) {
			eprintln!(
				"facet desktop: 孤児ステージングファイルの削除に失敗しました(スキップして続行): {} ({err})",
				path.display()
			);
		}
	}
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

/// `output` が(パス表記の違いを問わず)`input` と同一ファイルを指すかどうかを判定する。
///
/// **背景(データ損失バグ)**: `media_core::pipeline::finalize_output` は成功時に
/// ステージング一時ファイルを `fs::rename` で `output` へ確定させる。これはデマルチプレクサ
/// (入力側のファイルハンドル)を drop した後に行われるため、ユーザーが保存ダイアログで
/// 誤って入力ファイルそのものを出力先に選んだ場合、この guard が無ければ元の動画が
/// 静かに上書き・消失する。[`OutputPathRegistry`](media_core) は実行中の**出力**パスしか
/// 追跡しておらず、このケース(出力 == 入力)は検知できないため、ジョブを起動する前に
/// ここで明示的に弾く。
///
/// **パス比較の頑健性**: macOS(APFS)/Windows(NTFS)は既定で大文字小文字を区別しない
/// ファイルシステムのため、単純な文字列比較では `Video.mp4` と `video.mp4` が同一ファイルを
/// 指していても見逃す。また `..` を含む相対パス表記の違いも同様に見逃しうる。
/// `input` は呼び出し時点で実在するファイルなので `fs::canonicalize` できるが、`output` は
/// これから書き出す新規ファイルの場合が多く存在しないことがあるため、
/// [`canonicalize_existing_or_missing`] で「実在しなくても親ディレクトリの実体パスから
/// 組み立てる」形にして比較する。どちらのパスも `fs::canonicalize` 系の処理が失敗した場合
/// (親ディレクトリも存在しない等)は、誤検知で正当な書き出しをブロックしないよう
/// 素のパス比較にフォールバックする(見逃しはあり得るが、既存挙動からの後退はない)。
fn output_targets_input(input: &Path, output: &Path) -> bool {
	match (
		fs::canonicalize(input),
		canonicalize_existing_or_missing(output),
	) {
		(Ok(canonical_input), Ok(canonical_output)) => canonical_input == canonical_output,
		_ => input == output,
	}
}

/// `path` を `fs::canonicalize` する。`path` 自体が存在しなくても、親ディレクトリが
/// 実在すれば「親ディレクトリの実体パス + ファイル名」で組み立てて返す
/// ([`output_targets_input`] が書き出し前(=まだ存在しない)出力パスも比較できるように
/// するためのヘルパ)。親ディレクトリも実在しない、またはファイル名を取り出せない場合は
/// `Err` を返す(呼び出し側は素のパス比較へフォールバックする)。
fn canonicalize_existing_or_missing(path: &Path) -> std::io::Result<PathBuf> {
	if let Ok(canonical) = fs::canonicalize(path) {
		return Ok(canonical);
	}
	let file_name = path.file_name().ok_or_else(|| {
		std::io::Error::new(
			std::io::ErrorKind::InvalidInput,
			format!("ファイル名を取り出せません: {}", path.display()),
		)
	})?;
	let parent = match path.parent() {
		Some(parent) if !parent.as_os_str().is_empty() => parent,
		_ => Path::new("."),
	};
	let canonical_parent = fs::canonicalize(parent)?;
	Ok(canonical_parent.join(file_name))
}

/// `input` を `spec` の指定形状へ再フレーミングするジョブを開始する。
///
/// `job_id` は renderer 側が採番して渡す(モジュール冒頭コメント「jobId 採番を
/// フロントエンドへ移した理由」参照)。ジョブ本体はバックグラウンドスレッドで実行され、
/// この関数はジョブ登録後すぐに返る(完了を待たない)。進捗・完了は上記モジュール doc の
/// Tauri イベントで通知する。
///
/// `encoder` は省略可能(省略時は `None`)。[`encoder_choice_from_param`] で解決し、
/// 無効な値であればジョブを登録せずに `Err` を返す(モジュール doc §renderer 向け API
/// 参照)。同じ `job_id` のジョブが既に実行中の場合も `try_register` が拒否し、
/// ジョブを開始せず `Err` を返す(`commands::job_state` へ統一した際に IG と同じ
/// 安全側の挙動に揃えた。renderer は毎回新しい UUID を採番するため通常この経路は
/// 通らない)。
#[tauri::command]
pub async fn reframe_start(
	app: AppHandle,
	jobs: State<'_, JobsState>,
	job_id: JobId,
	input: String,
	output: String,
	spec: EditSpec,
	encoder: Option<String>,
) -> Result<(), String> {
	let encoder_choice =
		encoder_choice_from_param(encoder_select::Platform::current(), encoder.as_deref())?;

	let input_path = PathBuf::from(input);
	let output_path = PathBuf::from(output);
	if output_targets_input(&input_path, &output_path) {
		return Err(format!(
			"出力先に入力ファイルと同じパスは指定できません(元の動画が上書きされ失われます): {}",
			output_path.display()
		));
	}

	let staging_dir = resolve_staging_dir(&app)?;

	let token = CancelToken::new();
	if !jobs.try_register(job_id.clone(), token) {
		return Err("このジョブは既に実行中です".to_string());
	}

	let app_for_task = app.clone();
	let job_id_for_task = job_id;

	tauri::async_runtime::spawn_blocking(move || {
		run_job(
			&app_for_task,
			&job_id_for_task,
			&input_path,
			&output_path,
			&staging_dir,
			spec,
			encoder_choice,
		);
	});

	Ok(())
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
///
/// `staging_dir` は [`resolve_staging_dir`] が解決したアプリ管理のディレクトリ
/// (モジュール冒頭コメント「ステージングディレクトリ」参照)。`ReframeOptions.staging_dir`
/// にそのまま渡し、一時ファイルを `output` と同じディレクトリではなくここに書かせる。
fn run_job(
	app: &AppHandle,
	job_id: &str,
	input: &Path,
	output: &Path,
	staging_dir: &Path,
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
				staging_dir: Some(staging_dir.to_path_buf()),
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

/// `reframe://error/{jobId}` / `preview://error/{jobId}` イベント共通のペイロード
/// (キャンセルも含む。`MediaError` の `Display` をそのまま文字列化する。P2)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobErrorPayload {
	pub(crate) message: String,
}

/// [`reframe::run_job`] と [`crate::commands::preview::run_job`] に共通する
/// ジョブ実行の骨格を集約する(P2: Wave A で共有した
/// [`job_state::JobGuard`](crate::commands::job_state::JobGuard) の続き)。
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
	let _remove_on_exit = job_state::JobGuard::new(&jobs, job_id);

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

	// --- JobsState: newtype 越しに job_state::JobsState の try_register/cancel/remove が
	//     問題なく委譲されることの確認。共通実装の網羅的なテストは `job_state` モジュール
	//     側にもあるが(集約前からの回帰確認として)本モジュールの既存アサーションは
	//     `try_register` への追随のみ行い、意図は変えずに残してある。

	#[test]
	fn try_register_then_cancel_marks_token_cancelled() {
		let jobs = JobsState::default();
		let token = CancelToken::new();
		let job_id = "job-a".to_string();
		assert!(jobs.try_register(job_id.clone(), token.clone()));

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
	fn try_register_rejects_duplicate_job_id() {
		// アーキテクチャレビュー指摘対応: reframe/preview 側もIG と同じく二重開始を
		// 拒否する(GHSA-6cx9-j28r-f866 の修正を reframe/preview にも展開)。
		let jobs = JobsState::default();
		let token_a = CancelToken::new();
		let token_b = CancelToken::new();
		let job_id = "job-a".to_string();

		assert!(jobs.try_register(job_id.clone(), token_a));
		assert!(
			!jobs.try_register(job_id.clone(), token_b),
			"同じ job_id での2回目の登録は拒否される"
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
		let job_id = "job-a".to_string();
		jobs.try_register(job_id.clone(), token);

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
		let job_a = "job-a".to_string();
		let job_b = "job-b".to_string();
		jobs.try_register(job_a.clone(), token_a.clone());
		jobs.try_register(job_b.clone(), token_b.clone());

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

	// --- output_targets_input ---------------------------------------------------------
	//
	// `unique_test_dir` は本モジュール下部の `sweep_orphaned_staging_files` テスト群で
	// 定義されたヘルパを共用する(同じ `tests` モジュール内なので定義順に依存しない)。

	#[test]
	fn output_targets_input_true_for_identical_path() {
		let dir = unique_test_dir("output-targets-input-identical");
		let input = dir.join("video.mp4");
		fs::write(&input, b"dummy").expect("write dummy input");

		assert!(output_targets_input(&input, &input));

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn output_targets_input_true_for_dotdot_segments() {
		let dir = unique_test_dir("output-targets-input-dotdot");
		let sub = dir.join("sub");
		fs::create_dir_all(&sub).expect("create sub dir");
		let input = sub.join("video.mp4");
		fs::write(&input, b"dummy").expect("write dummy input");

		// `sub/../sub/video.mp4` は `sub/video.mp4` と同一ファイルを指すが、
		// 文字列としては `input` と異なる(canonicalize で吸収されるべきケース)。
		let output_via_dotdot = sub.join("..").join("sub").join("video.mp4");

		assert!(output_targets_input(&input, &output_via_dotdot));

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn output_targets_input_false_for_distinct_files() {
		let dir = unique_test_dir("output-targets-input-distinct");
		let input = dir.join("input.mp4");
		let output = dir.join("output.mp4");
		fs::write(&input, b"dummy-in").expect("write dummy input");
		fs::write(&output, b"dummy-out").expect("write dummy output");

		assert!(!output_targets_input(&input, &output));

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn output_targets_input_false_when_output_parent_does_not_exist() {
		let dir = unique_test_dir("output-targets-input-missing-parent");
		let input = dir.join("input.mp4");
		fs::write(&input, b"dummy-in").expect("write dummy input");

		// 出力先の親ディレクトリ自体が存在しない(= canonicalize が失敗する)場合は
		// 素のパス比較にフォールバックする。ここでは常に異なるパスなので false になる
		// (正当な新規書き出しを誤ってブロックしないことの確認)。
		let output = dir.join("does-not-exist").join("output.mp4");

		assert!(!output_targets_input(&input, &output));

		let _ = fs::remove_dir_all(&dir);
	}

	#[cfg(any(target_os = "macos", target_os = "windows"))]
	#[test]
	fn output_targets_input_true_for_case_difference_on_case_insensitive_fs() {
		// APFS(macOS)/NTFS(Windows)は既定で大文字小文字を区別しないため、綴りの
		// 大文字小文字だけが異なるパスでも同一ファイルを指す(このアプリが両 OS を
		// 対象にしている以上、必須のケース)。Linux 等の大文字小文字を区別する
		// ファイルシステムでは別表記は別名として存在しないため本テストの対象外
		// (`#[cfg]` で除外)。
		let dir = unique_test_dir("output-targets-input-case");
		let input = dir.join("Video.mp4");
		fs::write(&input, b"dummy").expect("write dummy input");

		let output = dir.join("VIDEO.MP4");

		assert!(output_targets_input(&input, &output));

		let _ = fs::remove_dir_all(&dir);
	}

	// --- looks_like_staging_tmp_name ---------------------------------------------------

	#[test]
	fn looks_like_staging_tmp_name_matches_media_core_naming_scheme() {
		// media_core::pipeline::staging_temp_output_path が作る名前
		// (`<stem>-<token>.tmp.<ext>` / 拡張子なしの `<stem>-<token>.tmp`)。
		assert!(looks_like_staging_tmp_name("video-abc123def456.tmp.mp4"));
		assert!(looks_like_staging_tmp_name("video-abc123def456.tmp"));
	}

	#[test]
	fn looks_like_staging_tmp_name_rejects_unrelated_names() {
		assert!(!looks_like_staging_tmp_name("video.mp4"));
		assert!(!looks_like_staging_tmp_name("notes.txt"));
		assert!(!looks_like_staging_tmp_name(".DS_Store"));
	}

	// --- sweep_orphaned_staging_files ---------------------------------------------------
	//
	// `preview.rs::evict_if_over_limit` のテストと同じ流儀(`unique_test_dir` で他テストと
	// 独立したディレクトリを使い、`set_modified` で mtime を明示的に制御する)。

	fn unique_test_dir(name: &str) -> PathBuf {
		let nanos = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map(|d| d.as_nanos())
			.unwrap_or(0);
		let dir =
			std::env::temp_dir().join(format!("facet-desktop-staging-sweep-test-{name}-{nanos}"));
		fs::create_dir_all(&dir).expect("create unique test staging dir");
		dir
	}

	fn write_dummy_file(dir: &Path, file_name: &str, age: Duration) -> PathBuf {
		let path = dir.join(file_name);
		fs::write(&path, b"dummy").expect("write dummy staging file");
		let mtime = SystemTime::now() - age;
		let file = std::fs::OpenOptions::new()
			.write(true)
			.open(&path)
			.expect("open dummy staging file to set mtime");
		file.set_modified(mtime).expect("set dummy file mtime");
		path
	}

	fn dir_entries_sorted(dir: &Path) -> Vec<String> {
		let mut names: Vec<String> = fs::read_dir(dir)
			.expect("read test staging dir")
			.map(|entry| {
				entry
					.expect("read dir entry")
					.file_name()
					.to_string_lossy()
					.into_owned()
			})
			.collect();
		names.sort();
		names
	}

	#[test]
	fn sweep_orphaned_staging_files_removes_only_old_tmp_like_files() {
		let dir = unique_test_dir("removes-only-old-tmp");
		// 十分古い(掃除対象)。
		write_dummy_file(
			&dir,
			"old-video-aaa.tmp.mp4",
			Duration::from_secs(2 * 60 * 60),
		);
		// 新しい(まだ実行中ジョブの一時ファイルかもしれないので保護)。
		write_dummy_file(&dir, "new-video-bbb.tmp.mp4", Duration::from_secs(1));
		// 古いが「一時ファイルらしい名前」ではない(誤って削除しない)。
		write_dummy_file(&dir, "old-unrelated.txt", Duration::from_secs(2 * 60 * 60));

		sweep_orphaned_staging_files(&dir, Duration::from_secs(60 * 60));

		assert_eq!(
			dir_entries_sorted(&dir),
			vec!["new-video-bbb.tmp.mp4", "old-unrelated.txt"],
			"only the old + tmp-like file should be removed"
		);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn sweep_orphaned_staging_files_keeps_everything_when_all_within_max_age() {
		let dir = unique_test_dir("keeps-fresh");
		write_dummy_file(&dir, "a-video.tmp.mp4", Duration::from_secs(1));
		write_dummy_file(&dir, "b-video.tmp", Duration::from_secs(1));

		sweep_orphaned_staging_files(&dir, Duration::from_secs(24 * 60 * 60));

		assert_eq!(
			dir_entries_sorted(&dir),
			vec!["a-video.tmp.mp4", "b-video.tmp"]
		);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn sweep_orphaned_staging_files_on_missing_dir_does_not_panic() {
		// resolve_staging_dir は作成後にのみ呼ぶが、掃除自体は best-effort な設計
		// (`fs::read_dir` 失敗時は静かにスキップする)ことを確認する。
		let missing = std::env::temp_dir().join("facet-desktop-staging-sweep-test-does-not-exist");
		sweep_orphaned_staging_files(&missing, Duration::from_secs(1));
	}
}
