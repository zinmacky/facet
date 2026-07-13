//! デコード → フィルタ → エンコード → mux のメインループ。
//!
//! スパイク(`spikes/libav-reframe/src/reframe.rs`)のループ構造を移植しつつ、
//! `unwrap` をすべて `Result<_, MediaError>` の伝搬に置き換えている。
//!
//! **Wave 3 のためのフックをここで固定する**(公開 API として安定させ、Wave 3 の
//! 3 エージェントが並行でこのシグネチャへ接続できるようにする):
//! - [`crate::cancel::CancelToken`] をループ境界(パケット単位)で毎回チェックする。
//!   キャンセルを検知したら一時出力ファイルを削除して `MediaError::Cancelled` を返す。
//!   クローン可能・スレッド安全なので、将来 Tauri コマンド(別スレッド/非同期)から
//!   同じトークンの `cancel()` を呼んで中断できる(`cancel.rs` 冒頭コメント参照)。
//! - `on_progress: &dyn Fn(Progress)` は `progress::ProgressTracker` 経由で呼ばれる。
//!   `ProgressTracker` がフレームを送出するたびに fps/speed/out_time_secs/percent を
//!   算出し、既定 200ms 間隔でスロットリングした上で `on_progress` を発火する
//!   (`Progress` のフィールド定義・スロットリング仕様は `progress.rs` 参照)。
//! - エンコーダは [`EncoderSelection`] として引数注入する(`Explicit` は明示指定、
//!   `Auto` はプラットフォーム別候補を `encoder_select` から取得し順に試す。
//!   Wave 2 配線で確定)。
//!
//! **キャンセル/失敗時の出力の扱い**: 出力は一時ファイル名(既定では `output_path` と
//! 同じディレクトリの `<stem>.tmp.<ext>`)に書き、正常終了時のみ最終ファイル名へ
//! リネームする。途中終了(エラー・キャンセルいずれも)は一時ファイルを削除するため、
//! `output_path` に不完全な mp4 が残ることはない(docs/desktop-migration-plan.md §6.2)。
//!
//! **`ReframeOptions.staging_dir`**: `Some(dir)` を渡すと、一時ファイルを `output_path`
//! と同じディレクトリではなく `dir` 配下に書く(ファイル名は衝突回避のため
//! [`staging_temp_output_path`] が一意化する)。書き出し先(例: デスクトップ)に
//! ユーザーから見える中間ファイルを一切出したくない用途向け(呼び出し側 —
//! `src-tauri/src/commands/reframe.rs` — がアプリ管理のステージングディレクトリを
//! 渡す)。完了時は [`finalize_output`] が `dir` から `output_path` へ確定させる
//! (通常は `fs::rename`、別ボリューム等で失敗した場合のみ `fs::copy` + 削除に
//! フォールバックする。同関数冒頭コメント参照)。`None`(既定)の場合は
//! 全体を通じて従来どおりの「出力先と同じディレクトリに `.tmp` を作り rename する」
//! 挙動のみを使う。
//!
//! **Wave 2 で接続したモジュール**:
//! - `trim`: `open_input` 直後に `TrimWindow::new(trim, trim::AV_TIME_BASE)` の
//!   `start_ts()` で demuxer をシークし(`start_ts == 0` ならシーク自体を省略)、
//!   デコードループでは `ist_time_base` の `TrimWindow` で各フレームを
//!   `classify()` する(`Skip` は破棄して継続、`Stop` はループを抜けて flush、
//!   `Keep` は `rebase()` で pts を再基準化してから通常処理)。`trim` が `None` の
//!   場合、`TrimWindow` は no-op(常に `Keep`・恒等 rebase)になるため、分岐を
//!   増やさずに同じコードパスで扱える。
//! - `crop`: `ReframeOptions.crop`(+ `source`)から `crop::crop_filter()` で
//!   文字列化し、`fit::FilterGraphSpec.pre_crop` へ接続する。
//! - `encoder_select`: `ReframeOptions.encoder` が `Auto` の場合、候補を先頭から
//!   順に `encode::open_encoder` で試し、`MediaError::EncoderOpen` なら次候補へ、
//!   それ以外の失敗は即座に返す。
//!
//! **Wave 3 で接続したモジュール**:
//! - `audio`: 入力に音声ストリームがあれば [`crate::audio::AudioPipeline`] を構築し、
//!   映像と同じパケットループ内でインターリーブして駆動する(`stream.index()` で
//!   映像/音声どちらのパケットかを振り分ける)。音声が無い入力では従来どおり映像のみの
//!   パイプラインとして動作する(`ReframeOptions` に音声の有効/無効フラグは存在しない
//!   — 旧 `packages/ffmpeg-runner`(削除済み)の `-map 0:a?` と同じ「あれば通す」挙動)。
//!   詳細な設計(trim/リサンプル/FIFO/pts 再基準化)は `audio.rs` モジュール冒頭コメント参照。
//!   trim ありの場合、映像・音声はそれぞれ独立したタイムベースで trim の end を
//!   判定する(`TrimWindow::classify`)ため、パケットループは**映像・音声のどちらも
//!   trim end に到達するまで**継続する([`run_pipeline`] 内のパケットループ末尾の
//!   コメント参照)。以前は映像側が先に end に到達した時点でループ全体を打ち切って
//!   いたため、コンテナのインターリーブ順序次第で未処理の音声パケットが失われ、
//!   trim 終端付近の音声/映像 duration が数十 ms 単位でズレる不具合があった
//!   (修正済み)。
//! - `concurrency`: [`reframe`] 冒頭で [`crate::concurrency::EncodeSlots::global`] から
//!   スロットを取得し(関数末尾まで保持、RAII で解放)、同時エンコード数を制限する。
//!   `Auto` 選択時のエンコーダ候補ループは
//!   [`crate::concurrency::retry_on_encoder_open`] でラップし、`EncoderOpen`(HW
//!   セッション枯渇等)はリトライ後も次候補へ進む(`concurrency.rs` 冒頭コメント参照)。

use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use ffmpeg_next::{self as ffmpeg, filter, format, frame, Dictionary, Packet, Rational};
use sha2::{Digest, Sha256};

use crate::audio;
use crate::cancel::CancelToken;
use crate::concurrency;
use crate::crop;
use crate::decode;
use crate::encode::{self, EncoderSpec};
use crate::encoder_select;
use crate::error::{is_again_or_eof, MediaError, Result};
use crate::fit::{self, FilterGraphSpec};
use crate::probe;
use crate::progress::ProgressTracker;
use crate::spec::{CropRect, Preset, SourceDimensions, Trim};
use crate::trim::{self, TrimDecision, TrimWindow};

/// パイプライン進捗の構造体。定義本体は Wave 3 で `progress.rs` へ移設した
/// (frame/total_frames/percent に加え out_time_secs/fps/speed を持つ)。
pub use crate::progress::Progress;

/// エンコーダの選び方。`Explicit` はテスト・CLI での明示指定用、`Auto` は
/// `encoder_select` のプラットフォーム別候補を先頭から順に試す(Wave 2 配線)。
pub enum EncoderSelection<'a> {
	/// `encoder_select::select()` が返す候補を先頭から順に試す。
	/// 全滅した場合は最後の `MediaError::EncoderOpen`(候補が 1 つも登録されて
	/// いない場合は `MediaError::NoEncoderCandidate`)を返す。
	Auto,
	/// エンコーダ名 + 追加オプションを直接指定する(単体テスト・CLI の
	/// 明示指定用途)。`encoder_select` を経由しない。
	Explicit {
		name: &'a str,
		options: Dictionary<'a>,
	},
}

/// [`reframe`] に渡すオプション一式。
pub struct ReframeOptions<'a> {
	pub preset: &'a Preset,
	/// blur-pad の gblur sigma。既定は [`fit::DEFAULT_SIGMA`]。
	pub sigma: u32,
	/// ソース側の事前クロップ矩形(0..1 正規化)。`None` なら事前クロップなし
	/// (`EditSpec.crop` に対応、Wave 2 配線)。
	pub crop: Option<CropRect>,
	/// 元動画の実ピクセル寸法。`crop` を実ピクセルの `crop=` フィルタへ解決するのに
	/// 使う(`crop` が `None` の場合は未使用。`EditSpec.source` に対応)。
	pub source: SourceDimensions,
	/// 秒単位のイン/アウト点。`None` なら全尺を処理する(`EditSpec.trim` に対応、
	/// Wave 2 配線)。
	pub trim: Option<Trim>,
	pub encoder: EncoderSelection<'a>,
	pub bit_rate: usize,
	/// クローン可能・スレッド安全なキャンセルトークン([`CancelToken`] 冒頭コメント参照)。
	pub cancel: &'a CancelToken,
	pub on_progress: &'a dyn Fn(Progress),
	/// 一時出力ファイルを書くディレクトリ。`Some(dir)` なら `output_path` と同じ
	/// ディレクトリではなく `dir` 配下に一時ファイルを書く(モジュール冒頭コメント
	/// 「`ReframeOptions.staging_dir`」参照)。`None`(既定)は従来どおり
	/// `output_path` と同じディレクトリに `.tmp` を作る挙動を完全に維持する
	/// (既存の呼び出し元・テスト・CLI example に影響を与えない)。
	pub staging_dir: Option<PathBuf>,
}

/// 実行中の出力先パス(`output_path`)をプロセス全体で追跡するグローバルレジストリ
/// (P1-2: 同一 output_path への同時実行競合の検知)。
///
/// `reframe()` は冒頭でここに `output_path` を登録し、既に別のジョブが同じパスへ
/// 書き出し中であれば [`MediaError::OutputBusy`] を返して即座に失敗する
/// (デコーダ/エンコーダ open 等、実際の書き出し処理には一切入らない)。
/// 登録は [`OutputPathGuard`] の RAII で `reframe()` 終了時(成功・失敗・キャンセル
/// いずれも)に自動的に解放されるため、1 本目が完了すれば同じパスへ再度書き出せる。
struct OutputPathRegistry {
	active: Mutex<HashSet<PathBuf>>,
}

impl OutputPathRegistry {
	/// プロセス全体で共有するインスタンス(`OnceLock`。`concurrency::EncodeSlots::global`
	/// と同じパターン)。
	fn global() -> &'static OutputPathRegistry {
		static INSTANCE: OnceLock<OutputPathRegistry> = OnceLock::new();
		INSTANCE.get_or_init(|| OutputPathRegistry {
			active: Mutex::new(HashSet::new()),
		})
	}

	/// `path` を実行中として登録する。既に登録済み(=別のジョブが同じパスへ実行中)
	/// なら `None` を返す(呼び出し側はこれを [`MediaError::OutputBusy`] に変換する)。
	fn register(&self, path: &Path) -> Option<OutputPathGuard<'_>> {
		let mut active = lock_or_recover(&self.active);
		if !active.insert(path.to_path_buf()) {
			return None;
		}
		Some(OutputPathGuard {
			registry: self,
			path: path.to_path_buf(),
		})
	}

	fn release(&self, path: &Path) {
		let mut active = lock_or_recover(&self.active);
		active.remove(path);
	}
}

/// [`OutputPathRegistry::register`] が返す RAII ガード。drop 時に登録を解除する。
struct OutputPathGuard<'a> {
	registry: &'a OutputPathRegistry,
	path: PathBuf,
}

impl Drop for OutputPathGuard<'_> {
	fn drop(&mut self) {
		self.registry.release(&self.path);
	}
}

/// `Mutex` の poisoning を復旧して中身を取り出す(`concurrency::lock_or_recover` と同じ
/// 設計判断: ロック保持中の処理は `HashSet` の insert/remove のみでパニックしうる操作を
/// 含まないため、poisoning が起きても中身の不変条件は壊れていない)。
fn lock_or_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
	mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `EditSpec` 1 つを libav パイプラインで実行し、`input_path` を `preset` 形状へ
/// 再フレーミングして `output_path` に書き出す(音声ストリームがあれば AAC ≤48kHz へ
/// 再エンコードして通す。`audio.rs` / `lib.rs` 冒頭コメント参照)。
///
/// 出力は完了時のみ `output_path` に現れる(§6.2、モジュール冒頭コメント参照)。
///
/// 戻り値は実際に使われたエンコーダ名(`encode::open_encoder` に渡した
/// `EncoderSpec.name`)。`EncoderSelection::Auto` の場合、どの候補が採用されたかを
/// 呼び出し側(ログ・実機検証・将来の UI 表示)が確認できるようにするための情報
/// (Wave 2 配線)。
pub fn reframe(
	input_path: &Path,
	output_path: &Path,
	options: ReframeOptions<'_>,
) -> Result<String> {
	ffmpeg::init().map_err(|source| MediaError::Init { source })?;

	// スロット取得前の早期キャンセルチェック(P1-3)。ここで検知できれば、
	// 一時ファイルの作成やスロット待機を一切行わずに即座に抜けられる。
	if options.cancel.is_cancelled() {
		return Err(MediaError::Cancelled);
	}

	// 同一 output_path への同時実行を検知して即座に拒否する(P1-2)。スロット待機
	// (他ジョブと共有される有限リソース)より先に行うことで、既に同じ出力先へ
	// 書き出し中の 2 本目がスロット空きを無駄に待つことも防げる。
	// `_output_guard` は関数末尾までスコープに保持し、drop 時に RAII で解放される。
	let _output_guard = OutputPathRegistry::global()
		.register(output_path)
		.ok_or_else(|| MediaError::OutputBusy {
			path: output_path.to_path_buf(),
		})?;

	// 同時エンコード数を制限するスロットを取得する(関数末尾までスコープに保持し、
	// drop 時に RAII で解放される。`concurrency` モジュール冒頭コメント参照)。
	// `acquire_cancellable` はスロット待機中も `cancel` を短周期でポーリングし、
	// 待機中にキャンセルされた場合は待ち続けずに `None` を返す(P1-3)。
	let _slot = match concurrency::EncodeSlots::global().acquire_cancellable(options.cancel) {
		Some(slot) => slot,
		None => return Err(MediaError::Cancelled),
	};

	let tmp_output_path = temp_output_path(output_path, options.staging_dir.as_deref());
	// パイプライン自体の失敗・成功後の確定処理(`finalize_output`)失敗のいずれでも、
	// 完成済みの一時ファイルが `output_path` へ反映されないまま残ることを防ぐため、
	// 掃除(`remove_file`)を両パスで共通化する(P1-1: リネーム失敗時の一時ファイル
	// 放置対策)。`rename` 失敗は Windows ではファイルロック等で起こりうる。
	let result = run_pipeline(input_path, &tmp_output_path, options).and_then(|encoder_name| {
		finalize_output(&tmp_output_path, output_path).map(|()| encoder_name)
	});
	if result.is_err() {
		// 途中終了(パイプライン失敗・キャンセル・確定処理失敗のいずれか)。
		// 一時出力が存在すれば削除する(存在しない場合の Err は無視してよい)。
		let _ = fs::remove_file(&tmp_output_path);
	}
	result
}

/// 一時出力ファイルパスを組み立てる。`staging_dir` が `Some` ならそのディレクトリ配下、
/// `None` なら従来どおり `output` と同じディレクトリに置く(モジュール冒頭コメント
/// 「`ReframeOptions.staging_dir`」参照)。
fn temp_output_path(output: &Path, staging_dir: Option<&Path>) -> PathBuf {
	match staging_dir {
		Some(dir) => staging_temp_output_path(dir, output),
		None => sibling_temp_output_path(output),
	}
}

/// `output` と同じディレクトリに一時ファイルパスを組み立てる(`staging_dir: None` の
/// 従来挙動)。最終的な拡張子(muxer 判定に使われる)を保つよう `<stem>.tmp.<ext>` の
/// 形にする(`<path>.tmp` のように末尾へ単純追加すると `format::output` が拡張子から
/// コンテナ形式を推測できなくなるため)。
fn sibling_temp_output_path(output: &Path) -> PathBuf {
	match output.extension().and_then(|ext| ext.to_str()) {
		Some(ext) => {
			let mut tmp = output.with_extension("").into_os_string();
			tmp.push(".tmp.");
			tmp.push(ext);
			PathBuf::from(tmp)
		}
		None => {
			let mut tmp = output.as_os_str().to_os_string();
			tmp.push(".tmp");
			PathBuf::from(tmp)
		}
	}
}

/// `dir` 配下に一時ファイルパスを組み立てる(`staging_dir: Some(dir)` の場合)。
/// 同じ `dir` を複数ジョブが同時に使っても衝突しないよう、ファイル名に
/// [`unique_staging_token`] を挟む(media-core は job_id を知らないため、出力パス+
/// プロセス内カウンタ+時刻から一意化する)。拡張子の扱いは [`sibling_temp_output_path`]
/// と同じ理由で保つ。
fn staging_temp_output_path(dir: &Path, output: &Path) -> PathBuf {
	let stem = output
		.file_stem()
		.and_then(|stem| stem.to_str())
		.unwrap_or("output");
	let token = unique_staging_token(output);
	let file_name = match output.extension().and_then(|ext| ext.to_str()) {
		Some(ext) => format!("{stem}-{token}.tmp.{ext}"),
		None => format!("{stem}-{token}.tmp"),
	};
	dir.join(file_name)
}

/// `staging_temp_output_path` 用の一意なファイル名トークンを払い出すプロセス内カウンタ。
static STAGING_TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `output` パス + プロセス ID + プロセス内カウンタ + 現在時刻(ナノ秒)を材料に sha256 して
/// 先頭 16 桁(64bit 相当)を返す。`preview.rs::preview_cache_key` と同じ「決定性は不要、
/// 衝突回避のみが目的」というハッシュの使い方だが、こちらは意図的にプロセス起動ごと・
/// 呼び出しごとに変わる非決定的な材料(カウンタ・時刻)を混ぜて一意性を担保する。
fn unique_staging_token(output: &Path) -> String {
	let counter = STAGING_TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
	let nanos = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_nanos())
		.unwrap_or(0);

	let mut material = String::new();
	let _ = write!(
		material,
		"{}\u{1}{}\u{1}{}\u{1}{}",
		output.to_string_lossy(),
		std::process::id(),
		counter,
		nanos,
	);

	let digest = Sha256::digest(material.as_bytes());
	let mut hex = String::with_capacity(16);
	for byte in digest.iter().take(8) {
		let _ = write!(hex, "{byte:02x}");
	}
	hex
}

/// `tmp_output_path` を `output_path` へ確定させる。まず `fs::rename` を試み、
/// (`staging_dir` が `output_path` と別ボリュームにある等の理由で)失敗した場合のみ
/// [`finalize_via_copy`] へフォールバックする。
///
/// Windows で書き込み中ハンドルが残ったままリネームすると失敗しうる点は
/// `run_pipeline` 末尾で `octx` を明示 drop 済みのため、この関数に到達する時点では
/// 一時ファイルへの書き込みハンドルは既に閉じている。
fn finalize_output(tmp_output_path: &Path, output_path: &Path) -> Result<()> {
	match fs::rename(tmp_output_path, output_path) {
		Ok(()) => Ok(()),
		Err(rename_err) => finalize_via_copy(tmp_output_path, output_path, rename_err),
	}
}

/// [`finalize_output`] で `fs::rename` が失敗した場合のフォールバック(既定の
/// `staging_dir: None` では同一ボリュームのため通常発生しないが、`staging_dir` が
/// `output_path` と別ボリュームにある場合は `rename` が失敗しうる)。
///
/// `tmp_output_path` から `output_path` へ直接 `fs::copy` し、成功すれば元の
/// `tmp_output_path` を削除する。**トレードオフ**: `fs::copy` は `fs::rename` と異なり
/// 原子的ではないため、コピー中の一瞬だけ `output_path` に不完全なファイルが見える
/// (これは `rename` が失敗するケース — 主に別ボリューム間の書き出し — でのみ発生し、
/// 同一ボリュームでは常に `rename` が成功するため発生しない)。
///
/// `copy` 自体も失敗した場合は、`copy` のエラーではなく引数で受け取った**元の
/// `rename` エラー**を返す(`rename` 失敗の根本原因 — 権限不足やディスク枯渇等 — が
/// そのまま `copy` の失敗原因にもなっていることが多く、呼び出し側にとって診断的に
/// 意味があるのは通常 `rename` 側のエラーであるため。`copy_err` はベストエフォートで
/// `eprintln!` に残す)。このとき `output_path` の削除は、この呼び出し**以前に
/// `output_path` が存在しなかった場合のみ**行う(= 今回の失敗した `copy` が作った
/// 可能性がある不完全なファイルの後始末に限定する)。`output_path` が呼び出し前から
/// 存在していた場合は削除しない — 既存ファイルへの上書き書き出し中に `copy` が失敗した
/// ケースで、ユーザーの既存ファイルを消してしまう事故を避けるため(`fs::copy` は
/// 内部で宛先を作成/truncate してから書き込むため、この保護があっても truncate 済みに
/// なっている可能性はゼロではないが、少なくとも「ファイル自体を消す」追加のデータ損失は
/// 避けられる)。
///
/// `rename_err` を引数として受け取る形に切り出しているのは、単体テストで
/// `fs::rename` を実際に失敗させずに(≒ 実ボリュームをまたぐ環境を用意せずに)
/// このフォールバック経路単体を検証できるようにするため。
fn finalize_via_copy(
	tmp_output_path: &Path,
	output_path: &Path,
	rename_err: std::io::Error,
) -> Result<()> {
	let output_existed_before = output_path.exists();
	match fs::copy(tmp_output_path, output_path) {
		Ok(_) => {
			let _ = fs::remove_file(tmp_output_path);
			Ok(())
		}
		Err(copy_err) => {
			eprintln!(
				"facet media-core: 出力の確定に失敗しました(rename: {rename_err}, copy fallback: {copy_err}): {} -> {}",
				tmp_output_path.display(),
				output_path.display()
			);
			if !output_existed_before {
				let _ = fs::remove_file(output_path);
			}
			Err(MediaError::from(rename_err))
		}
	}
}

fn run_pipeline(
	input_path: &Path,
	tmp_output_path: &Path,
	options: ReframeOptions<'_>,
) -> Result<String> {
	let ReframeOptions {
		preset,
		sigma,
		crop,
		source,
		trim,
		encoder,
		bit_rate,
		cancel,
		on_progress,
		// `tmp_output_path` は呼び出し元(`reframe()`)が既に `staging_dir` を
		// 織り込んで計算済みのため、ここでは使わない。
		staging_dir: _,
	} = options;

	// 入力オープン前の早期キャンセルチェック(P1-3)。`reframe()` 冒頭のチェック
	// (スロット取得前)から入力オープンまでの間にキャンセルされた場合、ここで
	// 検知して無駄な demuxer オープンを避ける。
	if cancel.is_cancelled() {
		return Err(MediaError::Cancelled);
	}

	let mut decode_ctx = decode::open_input(input_path)?;
	let ist_index = decode_ctx.stream_index;
	let ist_time_base = decode_ctx.time_base;
	let container_total_frames = decode_ctx.total_frames;
	let frame_rate = decode_ctx.decoder.frame_rate();

	// trim: demuxer シーク(統合ガイド 1.、trim.rs 冒頭コメント参照)。
	// `trim` が `None` の場合、`TrimWindow::new(None, ..)` は start_ts=0 の no-op
	// window になるため、以下は無条件に実行してよい(start_ts==0 ならシーク省略)。
	let seek_window = TrimWindow::new(trim.as_ref(), trim::AV_TIME_BASE);
	if seek_window.start_ts() != 0 {
		decode_ctx
			.input
			.seek(seek_window.start_ts(), ..)
			.map_err(|source| MediaError::Seek {
				path: input_path.to_path_buf(),
				source,
			})?;
	}

	// trim ありの場合のみ、実効尺(ソース尺 - trim)から総フレーム数を見積もり直す
	// (統合ガイド 3.)。trim なしなら従来どおりコンテナ申告値を使う(数値計算自体は
	// [`total_frames_with_trim`] に切り出してユニットテスト可能にしている)。
	let total_frames = match trim.as_ref() {
		Some(t) => {
			let video_stream =
				decode_ctx
					.input
					.stream(ist_index)
					.ok_or(MediaError::InputStreamMissing {
						path: input_path.to_path_buf(),
						index: ist_index,
					})?;
			let source_duration_secs = probe::duration_seconds(&decode_ctx, &video_stream);
			total_frames_with_trim(t, frame_rate, source_duration_secs)
		}
		None => container_total_frames,
	};

	// フレーム単位の trim 分類・再基準化用ウィンドウ(ストリームのタイムベース)。
	let frame_window = TrimWindow::new(trim.as_ref(), ist_time_base);

	// 音声ストリームの検出(`decoder`/`input` を可変参照へ分割する前に、共有の
	// `decode_ctx.input` から不変借用で読む。audio.rs モジュール冒頭コメント参照)。
	// 無ければ `None`(映像のみのパイプラインとして継続する)。
	let audio_source = audio::open_audio_decoder(&decode_ctx.input)?;

	// `input`/`decoder` を別々の可変参照として取り出す(同一ループ内で両方を
	// 独立に可変借用するため。DecodeContext のフィールドは互いに素なので安全)。
	let decoder = &mut decode_ctx.decoder;
	let input = &mut decode_ctx.input;

	let mut octx = format::output(tmp_output_path).map_err(|source| MediaError::OutputCreate {
		path: tmp_output_path.to_path_buf(),
		source,
	})?;

	let global_header = octx.format().flags().contains(format::Flags::GLOBAL_HEADER);

	// エンコーダ open 直前の早期キャンセルチェック(P1-3)。`Auto` 選択時は候補ごとに
	// リトライ待機(`concurrency::retry_on_encoder_open`)が入りうるため、ここで
	// 検知しておくことで無駄な HW セッション確保の試行を避ける。
	if cancel.is_cancelled() {
		return Err(MediaError::Cancelled);
	}

	let (mut encoder_ctx, enc_pix_fmt, stream_index, encoder_name_used) = open_selected_encoder(
		&mut octx,
		encoder,
		preset,
		ist_time_base,
		frame_rate,
		bit_rate,
		global_header,
	)?;

	let enc_pix_name = encode::pix_fmt_name(enc_pix_fmt);
	let pre_crop = crop.map(|rect| crop::crop_filter(rect, source));
	let filter_spec_str = fit::build_filter_graph(&FilterGraphSpec {
		preset,
		pre_crop: pre_crop.as_deref(),
		pix_fmt: &enc_pix_name,
		sigma,
	});
	let mut graph = open_filter_graph(decoder, ist_time_base, &filter_spec_str, enc_pix_fmt)?;

	// 音声パイプラインの構築(出力ストリームの追加・エンコーダ open まで)。
	// 映像のストリーム追加(`open_selected_encoder` 内の `add_stream`)より後に
	// 呼ぶことで、出力コンテナのストリーム順を「映像 0・音声 1」に保つ。
	let mut audio_pipeline = match audio_source {
		Some(source) => Some(audio::AudioPipeline::open(
			&mut octx,
			source,
			trim.as_ref(),
			global_header,
		)?),
		None => None,
	};

	// mp4 に +faststart(moov 先頭。docs/desktop-migration-plan.md §12.1/§6.2)。
	let mut mux_opts = Dictionary::new();
	mux_opts.set("movflags", "+faststart");
	octx.write_header_with(mux_opts)
		.map_err(|source| MediaError::Mux { source })?;
	let ost_time_base = octx
		.stream(stream_index)
		.ok_or(MediaError::OutputStreamMissing {
			index: stream_index,
		})?
		.time_base();
	if let Some(pipeline) = audio_pipeline.as_mut() {
		pipeline.bind_output_time_base(&octx)?;
	}

	let mut decoded = frame::Video::empty();
	let mut filtered = frame::Video::empty();
	let mut encoded = Packet::empty();
	let mut frame_count: u64 = 0;
	// 映像側が trim の end に到達したか(統合ガイド 2. `Stop`)。true になった後は
	// 以後の映像パケットのデコードをスキップする(下のパケットループ参照)。
	// 早期終了時はデコーダ内部にまだ残っているかもしれない未取得フレームも
	// (pts が単調増加である限り)すべて end 以降のため、デコーダ側の EOF flush は
	// 行わずフィルタ/エンコーダの flush のみ行う。
	// 注意: `stopped_early` が true になっても、音声パイプラインが自身の trim
	// window で `Stop` と判定するまではパケットループ自体は継続する(下の
	// ループ末尾のコメント参照 — インターリーブ順序依存で音声が早期に打ち切られる
	// 不具合の修正)。
	let mut stopped_early = false;
	// 直近で得られたフレームの pts を秒に変換した値(`Progress.out_time_secs` の元)。
	// フィルタ出力フレームの pts が稀に不明(`None`)な場合でも 0 に巻き戻らないよう、
	// 判明したときだけ更新する(`pull_filtered` 内)。
	let mut last_out_time_secs: f64 = 0.0;
	let mut progress_tracker = ProgressTracker::new(total_frames, on_progress);

	'decode: for (stream, packet) in input.packets() {
		if cancel.is_cancelled() {
			return Err(MediaError::Cancelled);
		}
		let packet_stream_index = stream.index();
		if packet_stream_index == ist_index {
			// 映像が既に trim の end に到達している(`stopped_early`)場合、これ以上
			// 映像パケットをデコードする意味はない。ただし直後のコメントの通り、
			// ループ自体(音声側の処理)はまだ打ち切らない。
			if !stopped_early {
				decoder
					.send_packet(&packet)
					.map_err(|source| MediaError::Decode { source })?;
				loop {
					match decoder.receive_frame(&mut decoded) {
						Ok(()) => {}
						Err(err) if is_again_or_eof(&err) => break,
						Err(source) => return Err(MediaError::Decode { source }),
					}
					match classify_and_rebase(&mut decoded, &frame_window) {
						TrimDecision::Skip => continue,
						TrimDecision::Stop => {
							stopped_early = true;
							break;
						}
						TrimDecision::Keep => {}
					}
					push_to_filter(&mut graph, &decoded)?;
					pull_filtered(
						&mut graph,
						&mut encoder_ctx,
						&mut octx,
						stream_index,
						ist_time_base,
						ost_time_base,
						&mut filtered,
						&mut encoded,
						&mut frame_count,
						&mut last_out_time_secs,
						&mut progress_tracker,
					)?;
				}
			}
		} else if let Some(pipeline) = audio_pipeline.as_mut() {
			// 音声ストリームのパケットは映像と同じループ内でインターリーブして
			// 処理する(audio.rs モジュール冒頭コメント参照。stream index で振り分け)。
			if packet_stream_index == pipeline.stream_index() {
				pipeline.process_packet(&packet, &mut octx)?;
			}
		}
		if cancel.is_cancelled() {
			return Err(MediaError::Cancelled);
		}
		// 映像・音声の trim end はそれぞれ独立したタイムベースで判定されるため、
		// コンテナのインターリーブ順序次第で「映像が先に end に到達する」ケースが
		// ありうる。**旧実装はここで即座に `break 'decode`(パケットループ全体を
		// 終了)していたため**、その時点でまだ demux されていない音声パケット
		// (音声自身の trim window ではまだ `Keep` 対象)が一切処理されないまま
		// 失われ、trim 終端付近の音声/映像 duration がインターリーブ順序に依存して
		// 数十 ms 単位でズレる既知不具合の直接原因だった(`audio.rs` モジュール冒頭
		// コメント参照)。修正: 映像側は `stopped_early` 以後デコードをスキップする
		// だけに留め、音声パイプラインが自身の trim window で独立に `Stop` と
		// 判定するまで(音声が無い場合は映像の `stopped_early` のみで即座に)
		// ループを継続する。これにより残る誤差は AAC 1 フレーム(1024 サンプル)
		// 分の量子化程度に収まる。
		let audio_done = audio_pipeline
			.as_ref()
			.map(|pipeline| pipeline.is_stopped())
			.unwrap_or(true);
		if stopped_early && audio_done {
			break 'decode;
		}
	}

	// flush: decoder → filter → encoder(スパイク同様の 3 段 flush)。
	// trim の end で早期終了した場合はデコーダ側の flush をスキップする
	// (上の `stopped_early` コメント参照)。
	if !stopped_early {
		decoder
			.send_eof()
			.map_err(|source| MediaError::Decode { source })?;
		loop {
			match decoder.receive_frame(&mut decoded) {
				Ok(()) => {}
				Err(err) if is_again_or_eof(&err) => break,
				Err(source) => return Err(MediaError::Decode { source }),
			}
			match classify_and_rebase(&mut decoded, &frame_window) {
				TrimDecision::Skip => continue,
				TrimDecision::Stop => break,
				TrimDecision::Keep => {}
			}
			push_to_filter(&mut graph, &decoded)?;
			pull_filtered(
				&mut graph,
				&mut encoder_ctx,
				&mut octx,
				stream_index,
				ist_time_base,
				ost_time_base,
				&mut filtered,
				&mut encoded,
				&mut frame_count,
				&mut last_out_time_secs,
				&mut progress_tracker,
			)?;
		}
	}
	flush_filter_source(&mut graph)?;
	pull_filtered(
		&mut graph,
		&mut encoder_ctx,
		&mut octx,
		stream_index,
		ist_time_base,
		ost_time_base,
		&mut filtered,
		&mut encoded,
		&mut frame_count,
		&mut last_out_time_secs,
		&mut progress_tracker,
	)?;

	encoder_ctx
		.send_eof()
		.map_err(|source| MediaError::Encode { source })?;
	drain_encoder(
		&mut encoder_ctx,
		&mut octx,
		stream_index,
		ist_time_base,
		ost_time_base,
		&mut encoded,
	)?;
	// 完了時は必ず最終進捗を通知する(直前の update がスロットリングで間引かれていても、
	// 呼び出し側は 100% の Progress を確実に受け取れる)。
	progress_tracker.finish(frame_count, last_out_time_secs);

	// 音声パイプラインの flush(デコーダ EOF・リサンプラ・FIFO の残り・エンコーダ
	// flush をまとめて行う。`AudioPipeline::flush` 参照)。`stopped_early`(映像側の
	// trim end 早期終了)とは独立に、常に実行する — 音声自身の trim end 到達判定
	// (`AudioPipeline` 内部の `stopped`)は映像側の早期終了と一致するとは限らないため
	// (audio.rs モジュール冒頭コメント参照)。
	if let Some(pipeline) = audio_pipeline.as_mut() {
		pipeline.flush(&mut octx)?;
	}

	octx.write_trailer()
		.map_err(|source| MediaError::Mux { source })?;
	// Windows で書き込み中ハンドルが残ったままリネームすると失敗しうるため、
	// ここで明示的に出力コンテキストを閉じる(Drop で avio を close する)。
	drop(octx);

	Ok(encoder_name_used)
}

/// デコード済みフレームの trim 分類を行い、`Keep` の場合は pts を再基準化する
/// (統合ガイド 2.)。pts が不明な場合は分類できないため `Keep`(素通し、pts は
/// 変更しない)として扱う(防御的フォールバック。通常のストリームでは発生しない)。
fn classify_and_rebase(decoded: &mut frame::Video, frame_window: &TrimWindow) -> TrimDecision {
	match decoded.timestamp() {
		Some(pts) => {
			let decision = frame_window.classify(pts);
			if decision == TrimDecision::Keep {
				decoded.set_pts(Some(frame_window.rebase(pts)));
			}
			decision
		}
		None => TrimDecision::Keep,
	}
}

/// trim 適用時の `Progress.total_frames` を見積もる(統合ガイド 3.)。
/// フレームレートが不明(`frame_rate: None`)な場合は見積り不能として `None` を返す。
/// `trim なし` のケースはこの関数の外側(呼び出し側、`run_pipeline`)で
/// コンテナ申告値をそのまま使うため、ここでは扱わない。
fn total_frames_with_trim(
	trim: &Trim,
	frame_rate: Option<Rational>,
	source_duration_secs: f64,
) -> Option<u64> {
	let frame_rate = frame_rate?;
	trim::estimate_total_frames(
		trim::effective_duration_secs(Some(trim), source_duration_secs),
		frame_rate,
	)
}

/// [`EncoderSelection`] に従ってエンコーダを開く。戻り値の `String` は実際に
/// 使われたエンコーダ名(`reframe` の戻り値としてそのまま呼び出し側へ伝わる)。
///
/// `Auto` の場合は `encoder_select::select()` が返す候補を先頭から順に試し、
/// `MediaError::EncoderOpen`(エンコーダ open 失敗)または `MediaError::OutputStreamCreate`
/// (open 成功後の add_stream 失敗、P2)なら次候補へ進む。それ以外の失敗
/// (`EncoderNotFound` 等)は即座に返す。全候補がこの 2 つのいずれかで失敗した場合は
/// 最後に発生したエラーを返す(§11-2: libx264 等へのソフトウェア
/// フォールバックはしない)。
#[allow(clippy::too_many_arguments)]
fn open_selected_encoder(
	octx: &mut format::context::Output,
	selection: EncoderSelection<'_>,
	preset: &Preset,
	time_base: Rational,
	frame_rate: Option<Rational>,
	bit_rate: usize,
	global_header: bool,
) -> Result<(ffmpeg::encoder::Video, format::Pixel, usize, String)> {
	match selection {
		EncoderSelection::Explicit { name, options } => {
			let (opened, pixel_format, stream_index) = encode::open_encoder(
				octx,
				EncoderSpec {
					name,
					options,
					width: preset.width,
					height: preset.height,
					time_base,
					frame_rate,
					bit_rate,
					global_header,
				},
			)?;
			Ok((opened, pixel_format, stream_index, name.to_string()))
		}
		EncoderSelection::Auto => {
			let candidates = encoder_select::select()?;
			let retry_config = concurrency::RetryConfig::default();
			let mut last_err: Option<MediaError> = None;
			for choice in candidates {
				// HW エンコーダのセッション枯渇(-12903 相当)による open 失敗は、
				// 他ジョブの完了を待てば解消することが多いため、次候補へ進む前に
				// 待機リトライする(`concurrency` モジュール冒頭コメント参照)。
				let attempt = concurrency::retry_on_encoder_open(
					&retry_config,
					&|duration| std::thread::sleep(duration),
					|| {
						encode::open_encoder(
							octx,
							EncoderSpec {
								name: choice.name,
								options: choice.to_dictionary(),
								width: preset.width,
								height: preset.height,
								time_base,
								frame_rate,
								bit_rate,
								global_header,
							},
						)
					},
				);
				match attempt {
					Ok((opened, pixel_format, stream_index)) => {
						return Ok((opened, pixel_format, stream_index, choice.name.to_string()))
					}
					// `EncoderOpen`(エンコーダ自体の open 失敗)・`OutputStreamCreate`
					// (open 成功後の add_stream 失敗、P2 で EncoderOpen から分離)の
					// いずれも「この候補は使えない、次候補へ」という扱いは変えない
					// (add_stream 失敗を専用 variant に分けたのは診断精度のためであり、
					// Auto 選択のフォールバック挙動自体は分離前と同じに保つ)。
					Err(
						err @ (MediaError::EncoderOpen { .. }
						| MediaError::OutputStreamCreate { .. }),
					) => last_err = Some(err),
					Err(err) => return Err(err),
				}
			}
			// `encoder_select::select()` は候補が 1 つもない場合
			// `MediaError::NoEncoderCandidate` を返す(=ここには来ない)ため、
			// `last_err` は理論上必ず `Some` になる。防御的に `None` の場合は
			// `unwrap`/`expect` せず明確なエラーを返す。
			Err(last_err.unwrap_or(MediaError::NoEncoderCandidate {
				platform: "auto".to_string(),
				attempted: Vec::new(),
			}))
		}
	}
}

/// `buffer`/`buffersink` を使った最小のフィルタグラフを構築する
/// (スパイクの `build_filter` を移植)。
fn open_filter_graph(
	decoder: &ffmpeg::decoder::Video,
	ist_time_base: Rational,
	filter_spec_str: &str,
	enc_pix_fmt: format::Pixel,
) -> Result<filter::Graph> {
	let mut graph = filter::Graph::new();

	let sar = decode::sample_aspect_ratio(decoder);
	let args = format!(
		"width={}:height={}:pix_fmt={}:time_base={}:pixel_aspect={}",
		decoder.width(),
		decoder.height(),
		encode::pix_fmt_name(decoder.format()),
		ist_time_base,
		sar,
	);

	let buffer_filter = filter::find("buffer").ok_or_else(|| MediaError::FilterNotFound {
		name: "buffer".to_string(),
	})?;
	let buffersink_filter =
		filter::find("buffersink").ok_or_else(|| MediaError::FilterNotFound {
			name: "buffersink".to_string(),
		})?;

	let filter_graph_err = |source: ffmpeg::Error| MediaError::FilterGraph {
		spec: filter_spec_str.to_string(),
		source,
	};

	graph
		.add(&buffer_filter, "in", &args)
		.map_err(filter_graph_err)?;
	graph
		.add(&buffersink_filter, "out", "")
		.map_err(filter_graph_err)?;

	{
		let mut out = graph.get("out").ok_or_else(|| MediaError::FilterNotFound {
			name: "out".to_string(),
		})?;
		out.set_pixel_format(enc_pix_fmt);
	}

	graph
		.output("in", 0)
		.map_err(filter_graph_err)?
		.input("out", 0)
		.map_err(filter_graph_err)?
		.parse(filter_spec_str)
		.map_err(filter_graph_err)?;
	graph.validate().map_err(filter_graph_err)?;

	Ok(graph)
}

fn push_to_filter(graph: &mut filter::Graph, decoded: &frame::Video) -> Result<()> {
	graph
		.get("in")
		.ok_or_else(|| MediaError::FilterNotFound {
			name: "in".to_string(),
		})?
		.source()
		.add(decoded)
		.map_err(|source| MediaError::Filter { source })
}

fn flush_filter_source(graph: &mut filter::Graph) -> Result<()> {
	graph
		.get("in")
		.ok_or_else(|| MediaError::FilterNotFound {
			name: "in".to_string(),
		})?
		.source()
		.flush()
		.map_err(|source| MediaError::Filter { source })
}

fn drain_encoder(
	encoder: &mut ffmpeg::encoder::Video,
	octx: &mut format::context::Output,
	stream_index: usize,
	ist_time_base: Rational,
	ost_time_base: Rational,
	encoded: &mut Packet,
) -> Result<()> {
	loop {
		match encoder.receive_packet(encoded) {
			Ok(()) => {}
			Err(err) if is_again_or_eof(&err) => break,
			Err(source) => return Err(MediaError::Encode { source }),
		}
		encoded.set_stream(stream_index);
		encoded.rescale_ts(ist_time_base, ost_time_base);
		encoded
			.write_interleaved(octx)
			.map_err(|source| MediaError::Mux { source })?;
	}
	Ok(())
}

#[allow(clippy::too_many_arguments)]
fn pull_filtered<F: Fn() -> Instant>(
	graph: &mut filter::Graph,
	encoder: &mut ffmpeg::encoder::Video,
	octx: &mut format::context::Output,
	stream_index: usize,
	ist_time_base: Rational,
	ost_time_base: Rational,
	filtered: &mut frame::Video,
	encoded: &mut Packet,
	frame_count: &mut u64,
	last_out_time_secs: &mut f64,
	tracker: &mut ProgressTracker<'_, F>,
) -> Result<()> {
	loop {
		let sink_result = graph
			.get("out")
			.ok_or_else(|| MediaError::FilterNotFound {
				name: "out".to_string(),
			})?
			.sink()
			.frame(filtered);
		match sink_result {
			Ok(()) => {}
			Err(err) if is_again_or_eof(&err) => break,
			Err(source) => return Err(MediaError::Filter { source }),
		}
		encoder
			.send_frame(filtered)
			.map_err(|source| MediaError::Encode { source })?;
		drain_encoder(
			encoder,
			octx,
			stream_index,
			ist_time_base,
			ost_time_base,
			encoded,
		)?;
		*frame_count += 1;
		// フィルタ出力フレームの pts が判明していれば out_time_secs を更新する
		// (`buffersink` は通常 `best_effort_timestamp` を保つが、まれに不明な場合は
		// 直前の値を引き継ぎ 0 に巻き戻さない)。
		if let Some(pts) = filtered.timestamp() {
			*last_out_time_secs = pts_to_secs(pts, ist_time_base);
		}
		tracker.update(*frame_count, *last_out_time_secs);
	}
	Ok(())
}

/// pts(`time_base` 単位の整数)を秒に変換する。
fn pts_to_secs(pts: i64, time_base: Rational) -> f64 {
	pts as f64 * f64::from(time_base.numerator()) / f64::from(time_base.denominator())
}

#[cfg(test)]
mod tests {
	use super::*;

	// --- Progress の構造体本体・生成ロジックのテストは `progress.rs` へ移設した
	//     (Wave 3 統合。`Progress` はもうこのファイルに定義を持たない)。

	// --- temp_output_path(staging_dir: None、従来挙動の回帰) --------------------------

	#[test]
	fn temp_output_path_preserves_extension() {
		let tmp = temp_output_path(Path::new("/out/video.mp4"), None);
		assert_eq!(tmp, PathBuf::from("/out/video.tmp.mp4"));
	}

	#[test]
	fn temp_output_path_without_extension_appends_tmp_suffix() {
		let tmp = temp_output_path(Path::new("/out/video"), None);
		assert_eq!(tmp, PathBuf::from("/out/video.tmp"));
	}

	// --- temp_output_path(staging_dir: Some、新規) -------------------------------------

	#[test]
	fn temp_output_path_with_staging_dir_places_tmp_under_staging_dir() {
		let staging_dir = Path::new("/staging");
		let tmp = temp_output_path(Path::new("/out/video.mp4"), Some(staging_dir));

		assert_eq!(tmp.parent(), Some(staging_dir));
		let file_name = tmp.file_name().and_then(|n| n.to_str()).unwrap();
		assert!(
			file_name.starts_with("video-") && file_name.ends_with(".tmp.mp4"),
			"unexpected staging tmp file name: {file_name}"
		);
	}

	#[test]
	fn temp_output_path_with_staging_dir_without_extension_appends_tmp_suffix() {
		let staging_dir = Path::new("/staging");
		let tmp = temp_output_path(Path::new("/out/video"), Some(staging_dir));

		assert_eq!(tmp.parent(), Some(staging_dir));
		let file_name = tmp.file_name().and_then(|n| n.to_str()).unwrap();
		assert!(
			file_name.starts_with("video-") && file_name.ends_with(".tmp"),
			"unexpected staging tmp file name: {file_name}"
		);
	}

	#[test]
	fn temp_output_path_with_staging_dir_is_unique_across_calls() {
		let staging_dir = Path::new("/staging");
		let output = Path::new("/out/video.mp4");

		let first = temp_output_path(output, Some(staging_dir));
		let second = temp_output_path(output, Some(staging_dir));

		assert_ne!(
			first, second,
			"同じ output に対する staging tmp パスは呼び出しごとに一意であるべき"
		);
	}

	// --- finalize_output / finalize_via_copy --------------------------------------------
	//
	// `finalize_via_copy` を独立した関数に切り出しているため、実際に `fs::rename` を
	// 失敗させる(≒ 実ボリュームをまたぐ環境を用意する)ことなく、copy フォールバック
	// 経路単体をユニットテストできる(モジュール内 `finalize_via_copy` 冒頭コメント参照)。

	fn unique_test_dir(name: &str) -> PathBuf {
		let nanos = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map(|d| d.as_nanos())
			.unwrap_or(0);
		let dir = std::env::temp_dir().join(format!("facet-pipeline-finalize-test-{name}-{nanos}"));
		fs::create_dir_all(&dir).expect("create unique test dir");
		dir
	}

	fn dummy_rename_err() -> std::io::Error {
		std::io::Error::other("simulated rename failure for test")
	}

	#[test]
	fn finalize_via_copy_moves_content_and_removes_tmp_on_success() {
		let dir = unique_test_dir("copy-success");
		let tmp = dir.join("source.tmp.mp4");
		let output = dir.join("output.mp4");
		fs::write(&tmp, b"hello staging").expect("write tmp file");

		let result = finalize_via_copy(&tmp, &output, dummy_rename_err());

		assert!(result.is_ok(), "expected Ok, got {result:?}");
		assert!(!tmp.exists(), "tmp file should be removed after copy");
		assert_eq!(
			fs::read(&output).expect("read finalized output"),
			b"hello staging"
		);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn finalize_via_copy_returns_original_rename_error_and_cleans_up_on_copy_failure() {
		let dir = unique_test_dir("copy-failure");
		// tmp が存在しないため fs::copy は必ず失敗する(copy 失敗を安全に再現する手段)。
		let tmp = dir.join("does-not-exist.tmp.mp4");
		let output = dir.join("output.mp4");

		let result = finalize_via_copy(&tmp, &output, dummy_rename_err());

		assert!(
			matches!(result, Err(MediaError::Io(_))),
			"expected the original rename error to be surfaced, got {result:?}"
		);
		assert!(
			!output.exists(),
			"incomplete copy destination must not be left behind"
		);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn finalize_via_copy_preserves_pre_existing_output_file_when_copy_fails() {
		let dir = unique_test_dir("copy-failure-preexisting-output");
		// tmp が存在しないため fs::copy は必ず失敗する。
		let tmp = dir.join("does-not-exist.tmp.mp4");
		let output = dir.join("output.mp4");
		fs::write(&output, b"pre-existing user file").expect("write pre-existing output file");

		let result = finalize_via_copy(&tmp, &output, dummy_rename_err());

		assert!(
			matches!(result, Err(MediaError::Io(_))),
			"expected the original rename error to be surfaced, got {result:?}"
		);
		assert!(
			output.exists(),
			"a pre-existing output_path must not be deleted just because the copy fallback failed"
		);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn finalize_output_renames_within_same_directory() {
		let dir = unique_test_dir("rename-success");
		let tmp = dir.join("source.tmp.mp4");
		let output = dir.join("output.mp4");
		fs::write(&tmp, b"same volume rename").expect("write tmp file");

		let result = finalize_output(&tmp, &output);

		assert!(result.is_ok(), "expected Ok, got {result:?}");
		assert!(!tmp.exists(), "tmp file should be gone after rename");
		assert_eq!(
			fs::read(&output).expect("read finalized output"),
			b"same volume rename"
		);

		let _ = fs::remove_dir_all(&dir);
	}

	// --- OutputPathRegistry(P1-2) ----------------------------------------------------
	//
	// `OutputPathRegistry::global()` はプロセス全体で共有される `OnceLock` のため、
	// 各テストが異なる(テスト名を含む)ダミーパスを使うことで、並行実行される他の
	// テストとの干渉を避ける(`concurrency.rs` の `MAX_CONCURRENT_ENCODES_ENV` テストが
	// 専用ロックで直列化しているのとは異なるアプローチだが、パスが重複しない限り
	// 状態は独立している)。

	#[test]
	fn second_register_for_same_path_returns_none_until_first_guard_drops() {
		let path = Path::new("/tmp/facet-desktop-test-output-busy-basic.mp4");
		let registry = OutputPathRegistry::global();

		let first_guard = registry
			.register(path)
			.expect("first register should succeed");
		assert!(
			registry.register(path).is_none(),
			"second register for the same path should be rejected while the first is active"
		);

		drop(first_guard);

		assert!(
			registry.register(path).is_some(),
			"after the first guard is dropped, the path should be registrable again"
		);
	}

	#[test]
	fn register_for_different_paths_does_not_conflict() {
		let registry = OutputPathRegistry::global();
		let path_a = Path::new("/tmp/facet-desktop-test-output-busy-a.mp4");
		let path_b = Path::new("/tmp/facet-desktop-test-output-busy-b.mp4");

		let _guard_a = registry.register(path_a).expect("path_a should register");
		let _guard_b = registry.register(path_b).expect("path_b should register");
	}

	#[test]
	fn reframe_returns_output_busy_error_for_a_path_registered_by_another_guard() {
		// `reframe()` 自身は実 ffmpeg 依存だが、`reframe()` 冒頭のチェックが
		// `OutputPathRegistry` 経由で `MediaError::OutputBusy` を返すこと自体は、
		// レジストリへ事前登録してから `reframe()` を呼ぶことで実ファイル・実 ffmpeg
		// 抜きで検証できる(`register` に失敗した時点でデコーダ/エンコーダ open 等の
		// 実処理には一切入らないため)。
		let path = Path::new("/tmp/facet-desktop-test-output-busy-via-reframe.mp4");
		let _held = OutputPathRegistry::global()
			.register(path)
			.expect("first registration should succeed");

		let preset = Preset {
			name: "output-busy-test".to_string(),
			width: 1080,
			height: 1920,
			fit: crate::spec::FitMode::BlurPad,
		};
		let cancel = CancelToken::new();
		let on_progress = |_p: Progress| {};
		let options = ReframeOptions {
			preset: &preset,
			sigma: fit::DEFAULT_SIGMA,
			crop: None,
			source: SourceDimensions {
				width: 0,
				height: 0,
			},
			trim: None,
			encoder: EncoderSelection::Explicit {
				name: "does-not-matter",
				options: Dictionary::new(),
			},
			bit_rate: 0,
			cancel: &cancel,
			on_progress: &on_progress,
			staging_dir: None,
		};

		let result = reframe(
			Path::new("/tmp/facet-desktop-test-output-busy-input.mp4"),
			path,
			options,
		);
		assert!(
			matches!(result, Err(MediaError::OutputBusy { .. })),
			"expected OutputBusy, got: {result:?}"
		);
	}

	// --- open_selected_encoder: Auto の全滅時に Explicit ではなく候補ループを
	//     経由すること自体は実 FFmpeg 依存なので実機検証で確認する(このファイルの
	//     ユニットテストでは encoder_select 側の候補選択ロジックのみを検証する)。

	// --- total_frames_with_trim ----------------------------------------------------------

	#[test]
	fn total_frames_with_trim_uses_effective_duration_and_frame_rate() {
		let t = Trim {
			start: 5.0,
			end: 15.0,
		};
		// 実効尺は 10 秒(effective_duration_secs と同じ計算)、30fps。
		let result = total_frames_with_trim(&t, Some(Rational(30, 1)), 20.0);
		assert_eq!(result, Some(300));
	}

	#[test]
	fn total_frames_with_trim_clamps_to_source_duration() {
		// end がソース尺を超えるケース: effective_duration_secs 側でクランプされる。
		let t = Trim {
			start: 2.0,
			end: 100.0,
		};
		let result = total_frames_with_trim(&t, Some(Rational(30, 1)), 10.0);
		// 実効尺 = 10.0 - 2.0 = 8.0 秒 -> 8.0 * 30 = 240 フレーム。
		assert_eq!(result, Some(240));
	}

	#[test]
	fn total_frames_with_trim_unknown_frame_rate_is_none() {
		let t = Trim {
			start: 0.0,
			end: 5.0,
		};
		assert_eq!(total_frames_with_trim(&t, None, 10.0), None);
	}

	#[test]
	fn encoder_selection_explicit_holds_name_and_options() {
		let mut options = Dictionary::new();
		options.set("hw_encoding", "1");
		let selection = EncoderSelection::Explicit {
			name: "h264_mf",
			options,
		};
		match selection {
			EncoderSelection::Explicit { name, options } => {
				assert_eq!(name, "h264_mf");
				assert_eq!(options.get("hw_encoding"), Some("1"));
			}
			EncoderSelection::Auto => panic!("expected Explicit"),
		}
	}
}
