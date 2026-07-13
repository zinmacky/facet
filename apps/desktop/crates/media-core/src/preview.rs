//! プレビュー/投稿用レンダリング + spec ハッシュキャッシュ。
//!
//! 本モジュールはキャッシュ付きレンダリングを 2 つの品質で提供する:
//! - [`render_preview`]: 低ビットレート([`PREVIEW_BITRATE`] = 2Mbps)。編集中の
//!   目視確認用(高速)。
//! - [`render_publish`]: 本書き出しと同一ビットレート([`PUBLISH_BITRATE`] =
//!   `encode::DEFAULT_BITRATE` = 8Mbps)。IG 等への投稿用 — 投稿される実体が
//!   プレビュー品質にならないようにする(呼び出し側はキャッシュディレクトリも
//!   プレビューと分離すること。`cache_key` がビットレートをキー材料に含むため
//!   同一ディレクトリでも衝突はしないが、ディレクトリ分離により容量上限
//!   ([`preview_cache_max_bytes`]/[`publish_cache_max_bytes`])も独立に管理できる)。
//!
//! 両者は同一の実装([`render_cached`])を共有し、ビットレートとキャッシュ上限のみが
//! 異なる。
//!
//! 移植元(真実の源、旧 studio 実装は削除済み): `apps/studio/server/src/routes/preview.ts`。TS 版は
//! `{ spec, input: resolve(input) }` を JSON 化して sha1 の先頭 16 桁を
//! キャッシュキーにし、`WORK_DIR/preview-<hash>.mp4` が既に存在すればそのまま返す
//! (無ければ `bitrate: "2M"` の低ビットレートで `encode()` して書き出す)。
//!
//! 本モジュールは同じ発想を踏襲しつつ、次の点を拡張している(TS 版との差分):
//! - TS 版はファイル内容の変化(同一パスのまま上書き)を検知できない
//!   (`resolve(input)` = パス文字列のみをハッシュ材料にするため)。本モジュールは
//!   呼び出し側から渡された `input_size`/`input_mtime` もハッシュ材料に含め、
//!   同一パスでもファイルが更新されていればキャッシュを再生成する。
//! - ハッシュアルゴリズムは sha1 ではなく sha2(Sha256)を使う(`Cargo.toml` 参照)。
//!   キー自体が一致する必要はなく「同一入力+同一 spec → 同一キー」という決定性のみが
//!   要件のため、アルゴリズムの選択自体は TS 版と一致させていない。
//!
//! **キャッシュ削除ポリシー(実装済み)**: `render_preview` がキャッシュミスで新規に
//! ファイルを書き出した直後、`cache_dir` 配下の最終生成物(`<key>.mp4`)の合計サイズを
//! 数え、上限([`DEFAULT_PREVIEW_CACHE_MAX_BYTES`]、環境変数
//! [`PREVIEW_CACHE_MAX_BYTES_ENV`] で上書き可 — `concurrency::MAX_CONCURRENT_ENCODES_ENV`
//! と同じ流儀)を超えていれば `mtime` の古い順に削除し、上限内に収める。
//! - たった今書き出したファイル自身は常に削除対象から除外する(生成直後に自分の
//!   キャッシュが消える事故を防ぐ)。
//! - 実行中ジョブが `pipeline::reframe` を通じて書いている一時ファイル
//!   (`<key>.tmp.mp4`。`pipeline.rs` 冒頭コメント参照)は対象にしない — 掃除対象は
//!   拡張子 `.mp4` かつ `.tmp.mp4` で終わらないファイルのみ(`is_finished_cache_file`)。
//! - 削除はベストエフォート: 個々のファイルの `metadata`/`remove_file` が失敗しても
//!   (ロック中など)そのファイルをスキップして次に進み、`MediaError` は返さない
//!   (キャッシュ掃除の失敗でプレビュー生成自体を失敗させない)。
//!
//! キャッシュヒット時(既存ファイルをそのまま返す経路)は掃除を走らせない
//! (`render_preview` 冒頭コメント参照)。

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::cancel::CancelToken;
use crate::encode;
use crate::error::{MediaError, Result};
use crate::fit;
use crate::pipeline::{self, EncoderSelection, Progress, ReframeOptions};
use crate::spec::EditSpec;

/// プレビュー用ビットレート。TS 版 `preview.ts` の `bitrate: "2M"` と同一
/// (`encode::DEFAULT_BITRATE`(8Mbps)より低く、生成を高速化する)。
pub const PREVIEW_BITRATE: usize = 2_000_000;

/// 投稿用レンダリングのビットレート。本書き出し(`reframe_start` 経由の
/// `encode::DEFAULT_BITRATE`)と同一品質にする — 投稿される動画がプレビュー品質
/// (2Mbps)に落ちないようにするための定数(モジュール冒頭コメント参照)。
pub const PUBLISH_BITRATE: usize = encode::DEFAULT_BITRATE;

/// キャッシュキー材料のフィールド区切りに使うバイト。パス文字列や JSON 中に
/// まず出現しない制御文字(U+0001, ASCII SOH)を使い、`"a" + "1"` と
/// `"a1" + ""` のような連結の曖昧さを避ける。
const FIELD_SEPARATOR: char = '\u{1}';

/// キャッシュファイル名の先頭ハッシュ部分の長さ(16 進数の桁数)。
/// TS 版(sha1 先頭 16 桁 = 64bit)より衝突耐性を高めるため 32 桁(sha256 の
/// 先頭 128bit)を採用する。
const KEY_HEX_LEN: usize = 32;

/// `input_path` + `input_size` + `input_mtime` + `spec` + `bit_rate` からレンダリング
/// キャッシュのキーを作る(ファイル名にそのまま使える 16 進数文字列。拡張子は含まない)。
///
/// 決定性の要件:
/// - 同一の引数(`input_path`/`input_size`/`input_mtime`/`spec`/`bit_rate` がすべて
///   等しい)を何度呼んでも同じキーを返す(プロセスを跨いでも安定 — sha256 は乱数
///   シードを持たないアルゴリズムなので `std::collections::hash_map::DefaultHasher`
///   (SipHash、プロセスごとにシードが変わりうる)とは異なりこれが保証される)。
/// - `spec`(preset/trim/crop のいずれか)が変われば別のキーになる。
/// - `input_size`/`input_mtime` が変われば(パスが同じでも)別のキーになる
///   (同一パスへの上書きを検知するため。モジュール冒頭コメント参照)。
/// - `bit_rate` が変われば別のキーになる(プレビュー品質 2Mbps と投稿品質 8Mbps の
///   生成物はディレクトリ分離に加えキー自体でも区別する — 万一同一ディレクトリを
///   指定されても品質の取り違えが構造的に起きないようにする)。
///
/// `input_path` は呼び出し側で解決済み(正規化・絶対パス化された)ものを渡す想定。
/// 本関数はパス解決(`fs::canonicalize` 等)を行わない — 相対パスと絶対パスで別の
/// パスとして扱われるべきかは呼び出し側の責務とする(TS 版は `resolve(input)` を
/// 呼び出し側の関数内で行っている。`render_cached` はここで `input` をそのまま
/// 材料に使うので、呼び出し側が同じファイルに対して常に同じ表記のパスを渡す
/// 必要がある)。
pub fn render_cache_key(
	input_path: &Path,
	input_size: u64,
	input_mtime: SystemTime,
	spec: &EditSpec,
	bit_rate: usize,
) -> String {
	// spec のシリアライズはこの EditSpec の実装では実質失敗しない(f64 フィールドは
	// すべて正当な JSON からのデシリアライズ由来で有限値のみを持つ)が、`unwrap`/
	// `expect` は使わない方針のため、万一失敗しても panic せず Debug 表現へ
	// フォールバックする(それでも決定性は保たれる — Debug 出力もフィールド値から
	// 一意に決まる)。
	let spec_repr = serde_json::to_string(spec).unwrap_or_else(|_| format!("{spec:?}"));

	// mtime は UNIX epoch からのナノ秒に正規化する。epoch より前(通常発生しない)の
	// 場合は 0 にフォールバックする(unwrap せず決定的な既定値を使うだけで、
	// 「異常な mtime は別扱いされない」という程度の妥協 — キャッシュキーの用途上、
	// 実害はない)。
	let mtime_nanos = input_mtime
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_nanos())
		.unwrap_or(0);

	let mut material = String::new();
	let _ = write!(
		material,
		"{}{sep}{}{sep}{}{sep}{}{sep}{}",
		input_path.to_string_lossy(),
		input_size,
		mtime_nanos,
		spec_repr,
		bit_rate,
		sep = FIELD_SEPARATOR,
	);

	let digest = Sha256::digest(material.as_bytes());
	let mut hex = String::with_capacity(digest.len() * 2);
	for byte in digest.iter() {
		let _ = write!(hex, "{byte:02x}");
	}
	hex.truncate(KEY_HEX_LEN);
	hex
}

/// `cache_dir` 内のキャッシュファイルパスを組み立てる(`<key>.mp4`)。
fn cache_file_path(cache_dir: &Path, key: &str) -> PathBuf {
	cache_dir.join(format!("{key}.mp4"))
}

/// レンダリングキャッシュディレクトリ(`cache_dir`)の合計サイズ上限の既定値(2 GiB)。
/// プレビューキャッシュ・投稿用キャッシュそれぞれに独立に適用される
/// (ディレクトリが別なので合算はされない)。
///
/// ユーザー承認済みの初期方針: 合計 2GB 上限・mtime の古い順削除
/// (モジュール冒頭コメント参照)。
pub const DEFAULT_PREVIEW_CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// プレビューキャッシュの [`DEFAULT_PREVIEW_CACHE_MAX_BYTES`] を上書きする環境変数名。
///
/// `concurrency::MAX_CONCURRENT_ENCODES_ENV` と同じ流儀(未設定・数値としてパース
/// 不能・0 以下のいずれの場合も既定値にフォールバックする)。`Facet_` 独自設定である
/// ことを示すため(`MAX_CONCURRENT_ENCODES_ENV` とは異なり)`FACET_` プレフィックスを
/// 付けている。
pub const PREVIEW_CACHE_MAX_BYTES_ENV: &str = "FACET_PREVIEW_CACHE_MAX_BYTES";

/// 投稿用キャッシュの上限を上書きする環境変数名(プレビュー側と独立)。
pub const PUBLISH_CACHE_MAX_BYTES_ENV: &str = "FACET_PUBLISH_CACHE_MAX_BYTES";

/// `env_name` の環境変数からキャッシュ上限バイト数を読む。
///
/// 未設定・数値としてパース不能・0 のいずれの場合も
/// [`DEFAULT_PREVIEW_CACHE_MAX_BYTES`] にフォールバックする。
fn cache_max_bytes_from_env(env_name: &str) -> u64 {
	env::var(env_name)
		.ok()
		.and_then(|raw| raw.trim().parse::<u64>().ok())
		.filter(|&max| max > 0)
		.unwrap_or(DEFAULT_PREVIEW_CACHE_MAX_BYTES)
}

/// プレビューキャッシュの上限バイト数([`PREVIEW_CACHE_MAX_BYTES_ENV`] で上書き可)。
pub fn preview_cache_max_bytes() -> u64 {
	cache_max_bytes_from_env(PREVIEW_CACHE_MAX_BYTES_ENV)
}

/// 投稿用キャッシュの上限バイト数([`PUBLISH_CACHE_MAX_BYTES_ENV`] で上書き可)。
pub fn publish_cache_max_bytes() -> u64 {
	cache_max_bytes_from_env(PUBLISH_CACHE_MAX_BYTES_ENV)
}

/// `path` がキャッシュ掃除の対象となる「完成済みの」プレビューファイルかどうかを
/// 判定する。
///
/// `cache_file_path` が作るファイル名は `<key>.mp4`(拡張子 `.mp4`)、`pipeline::reframe`
/// が書き込み中に使う一時ファイル名は `<key>.tmp.mp4`(`pipeline.rs` の
/// `temp_output_path` 参照。`.with_extension("")` は最後の拡張子のみを剥がすため、
/// 出力拡張子が `mp4` の場合は `<stem>.tmp.mp4` になる)。両者はどちらも
/// `Path::extension()` が `"mp4"` を返すため、拡張子だけでは区別できない —
/// ファイル名が `.tmp.mp4` で終わっていないことも合わせて確認する。
fn is_finished_cache_file(path: &Path) -> bool {
	match path.file_name().and_then(|name| name.to_str()) {
		Some(name) => name.ends_with(".mp4") && !name.ends_with(".tmp.mp4"),
		None => false,
	}
}

/// `cache_dir` 配下の完成済みキャッシュファイル(`is_finished_cache_file`)の合計サイズが
/// `max_bytes` を超えていれば、`mtime` の古い順に削除して上限内に収める。
///
/// - `just_written`(直前に `render_preview` が書き出したファイル)は常に削除対象から
///   除外する(ファイル名で比較する — `cache_dir` の表記ゆれに影響されないため)。
/// - ベストエフォート: `cache_dir` の読み取り自体に失敗した場合、および個々のファイルの
///   `metadata`/`remove_file` が失敗した場合(他プロセスによるロック等)は、
///   そのエントリをスキップして処理を続ける。呼び出し元にエラーを伝搬しない
///   (モジュール冒頭コメント参照)。
fn evict_if_over_limit(cache_dir: &Path, just_written: &Path, max_bytes: u64) {
	let entries = match fs::read_dir(cache_dir) {
		Ok(entries) => entries,
		Err(err) => {
			eprintln!(
				"facet media-core: プレビューキャッシュディレクトリの読み取りに失敗しました(掃除をスキップ): {} ({err})",
				cache_dir.display()
			);
			return;
		}
	};

	let just_written_name = just_written.file_name();

	let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
	let mut total_bytes: u64 = 0;
	for entry in entries {
		let entry = match entry {
			Ok(entry) => entry,
			Err(err) => {
				eprintln!(
					"facet media-core: プレビューキャッシュディレクトリのエントリ読み取りに失敗しました(スキップ): {err}"
				);
				continue;
			}
		};
		let path = entry.path();
		if !is_finished_cache_file(&path) {
			continue;
		}
		let metadata = match entry.metadata() {
			Ok(metadata) => metadata,
			Err(err) => {
				eprintln!(
					"facet media-core: プレビューキャッシュファイルの metadata 取得に失敗しました(スキップ): {} ({err})",
					path.display()
				);
				continue;
			}
		};
		if !metadata.is_file() {
			continue;
		}
		let size = metadata.len();
		// mtime 取得に失敗した場合(非対応プラットフォーム等)は UNIX epoch を割り当て、
		// 「最も古いファイル」として扱う(削除順の先頭に来るだけで、他の判定には
		// 影響しない決定的なフォールバック)。
		let mtime = metadata.modified().unwrap_or(UNIX_EPOCH);
		total_bytes = total_bytes.saturating_add(size);
		files.push((path, size, mtime));
	}

	if total_bytes <= max_bytes {
		return;
	}

	// mtime 昇順(古い順)。mtime が同じ場合はパスで安定した順序にする。
	files.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| a.0.cmp(&b.0)));

	for (path, size, _mtime) in files {
		if total_bytes <= max_bytes {
			break;
		}
		if path.file_name() == just_written_name {
			continue;
		}
		match fs::remove_file(&path) {
			Ok(()) => {
				total_bytes = total_bytes.saturating_sub(size);
			}
			Err(err) => {
				// ロック中(実行中ジョブが読み取り中等)や権限不足などで削除できない
				// ケースを警告相当に留めて続行する(モジュール冒頭コメント参照)。
				eprintln!(
					"facet media-core: プレビューキャッシュファイルの削除に失敗しました(スキップして続行): {} ({err})",
					path.display()
				);
			}
		}
	}
}

/// `spec` に従って `input` を低ビットレート([`PREVIEW_BITRATE`])でプレビュー用に
/// 再フレーミングし、`cache_dir` 配下にキャッシュする(実体は [`render_cached`])。
pub fn render_preview(
	input: &Path,
	spec: &EditSpec,
	cache_dir: &Path,
	cancel: &CancelToken,
	on_progress: &dyn Fn(Progress),
) -> Result<PathBuf> {
	render_cached(
		input,
		spec,
		cache_dir,
		PREVIEW_BITRATE,
		preview_cache_max_bytes(),
		cancel,
		on_progress,
	)
}

/// `spec` に従って `input` を本書き出し品質([`PUBLISH_BITRATE`] =
/// `encode::DEFAULT_BITRATE`)で投稿用に再フレーミングし、`cache_dir` 配下に
/// キャッシュする(実体は [`render_cached`])。
///
/// `cache_dir` にはプレビューキャッシュとは**別の**ディレクトリを渡すこと
/// (取り違え防止。モジュール冒頭コメント参照。呼び出し側の実例:
/// `src-tauri/src/commands/preview.rs` の `publish-cache`)。
pub fn render_publish(
	input: &Path,
	spec: &EditSpec,
	cache_dir: &Path,
	cancel: &CancelToken,
	on_progress: &dyn Fn(Progress),
) -> Result<PathBuf> {
	render_cached(
		input,
		spec,
		cache_dir,
		PUBLISH_BITRATE,
		publish_cache_max_bytes(),
		cancel,
		on_progress,
	)
}

/// 同一 output への二重要求をコアレスする際のポーリング間隔。
const COALESCE_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// コアレス待ちの最大ポーリング回数(100ms × 3000 = 約5分の安全上限)。実行中の
/// 1 本目は通常この上限より前に完了/失敗して待ちが解ける。上限は「1 本目が病的に
/// 停止した場合」のバックストップで、超過時は元の挙動どおり `OutputBusy` を返す。
const COALESCE_MAX_POLLS: usize = 3000;

/// [`render_cached`] のコアレス結果。呼び出し側が eviction を走らせるかの判断に使う。
#[derive(Debug)]
enum RenderOutcome {
	/// 自分がエンコードして書き出した(eviction 対象)。
	Rendered,
	/// 実行中の別ジョブの完了を待ってキャッシュを共有した(自分は書き出していない)。
	Coalesced,
}

/// [`coalesce_render`] の 1 回のレンダリング試行結果。
enum RenderAttempt {
	/// 自分が書き出しに成功した。
	Rendered,
	/// 同一 output へ別ジョブが書き込み中(`OutputBusy`)。待って再試行する。
	Busy,
}

/// 同一 `output_path` へ書き込み中の別ジョブがあるとき、即 `OutputBusy` で落とさずに
/// 待機してキャッシュを共有する(M-2: ダブルクリック等で同一 spec のプレビューが
/// 二重要求されたとき、2 本目を失敗させない)。
///
/// - `already_present` が真になれば 1 本目の成功物が出現したとみなし `Coalesced`。
/// - `try_render` が `Rendered` を返せば自分が書き出したので `Rendered`。1 本目が
///   失敗して registry が解放されれば、次の `try_render` は `Busy` ではなく実行に入る。
/// - 上限まで `Busy` が続けば `OutputBusy` を返す(元挙動へのフォールバック)。
///
/// sleep を注入するため純粋なループとして切り出す(`concurrency::retry_on_encoder_open`
/// と同じ設計で、ffmpeg 非依存の単体テストが可能)。
fn coalesce_render(
	cancel: &CancelToken,
	output_path: &Path,
	already_present: impl Fn() -> bool,
	mut try_render: impl FnMut() -> Result<RenderAttempt>,
	sleep: impl Fn(Duration),
	max_polls: usize,
) -> Result<RenderOutcome> {
	for _ in 0..max_polls {
		if already_present() {
			return Ok(RenderOutcome::Coalesced);
		}
		if cancel.is_cancelled() {
			return Err(MediaError::Cancelled);
		}
		match try_render()? {
			RenderAttempt::Rendered => return Ok(RenderOutcome::Rendered),
			RenderAttempt::Busy => sleep(COALESCE_POLL_INTERVAL),
		}
	}
	// 上限到達直前に 1 本目が完了しているかもしれないので最後に一度だけ確認する。
	if already_present() {
		return Ok(RenderOutcome::Coalesced);
	}
	Err(MediaError::OutputBusy {
		path: output_path.to_path_buf(),
	})
}

/// `spec` に従って `input` を `bit_rate` で再フレーミングし、`cache_dir` 配下に
/// キャッシュする([`render_preview`]/[`render_publish`] の共通実体)。
///
/// - キャッシュヒット(同一 `input`(サイズ/mtime 含む)+ 同一 `spec` + 同一
///   `bit_rate` で既に生成済み)の場合は再エンコードせず既存ファイルのパスを
///   即座に返す。
/// - キャッシュミスの場合は [`pipeline::reframe`] を `bit_rate` で実行し、
///   `<cache_dir>/<key>.mp4` に書き出す。書き込みは `reframe` 自身が行う
///   一時ファイル→リネーム方式(`pipeline.rs` 冒頭コメント参照)にそのまま乗るため、
///   本関数側で追加の原子性担保は不要(中断・失敗時に不完全な mp4 が
///   `cache_dir` に残ることはない)。
/// - エンコーダは [`EncoderSelection::Auto`](プラットフォーム別候補、
///   `encoder_select` 参照)を使う(プレビュー用途でも本エンコードと同じ選択規則)。
/// - キャッシュミスで新規に書き出した場合のみ、書き込み成功後に `cache_dir` の掃除
///   ([`evict_if_over_limit`]、上限は `max_cache_bytes`)を行う(モジュール冒頭
///   コメント参照)。キャッシュヒット時(既に存在するファイルをそのまま返す経路)は
///   掃除を走らせない。
fn render_cached(
	input: &Path,
	spec: &EditSpec,
	cache_dir: &Path,
	bit_rate: usize,
	max_cache_bytes: u64,
	cancel: &CancelToken,
	on_progress: &dyn Fn(Progress),
) -> Result<PathBuf> {
	let metadata = fs::metadata(input)?;
	let input_size = metadata.len();
	let input_mtime = metadata.modified()?;

	let key = render_cache_key(input, input_size, input_mtime, spec, bit_rate);
	fs::create_dir_all(cache_dir)?;
	let output_path = cache_file_path(cache_dir, &key);

	// キャッシュヒット: 既存ファイルをそのまま返す(再エンコードしない)。
	// `reframe` は完了時のみ最終ファイル名を出現させる(§6.2)ため、ここで
	// `output_path` が存在するなら生成は完了済みであることが保証されている。
	if output_path.exists() {
		return Ok(output_path);
	}

	// 同一 output への二重要求は 1 本目の完了を待って共有する(M-2)。`reframe` は
	// 消費型の `ReframeOptions` を取るため、試行ごとに options を組み直す(`OutputBusy`
	// は実処理前に返るので busy 試行に無駄なエンコードは発生しない)。
	let outcome = coalesce_render(
		cancel,
		&output_path,
		|| output_path.exists(),
		|| {
			let options = ReframeOptions {
				preset: &spec.preset,
				sigma: fit::DEFAULT_SIGMA,
				crop: spec.crop,
				source: spec.source,
				trim: spec.trim,
				encoder: EncoderSelection::Auto,
				bit_rate,
				cancel,
				on_progress,
				// 生成物は既に `cache_dir` 内で完結しており、`output_path` 自体が
				// アプリ管理のキャッシュディレクトリ配下(ユーザーから見える書き出し先では
				// ない)。そのため一時ファイルも常に `output_path` と同じディレクトリ
				// (= cache_dir)に書く従来挙動でよく、`staging_dir` は使わない
				// (`pipeline.rs` モジュール冒頭コメント「`ReframeOptions.staging_dir`」参照)。
				staging_dir: None,
			};
			match pipeline::reframe(input, &output_path, options) {
				Ok(_) => Ok(RenderAttempt::Rendered),
				Err(MediaError::OutputBusy { .. }) => Ok(RenderAttempt::Busy),
				Err(err) => Err(err),
			}
		},
		std::thread::sleep,
		COALESCE_MAX_POLLS,
	)?;

	// 自分が書き出したときのみ eviction を走らせる(共有時は書き込んでいない)。
	if matches!(outcome, RenderOutcome::Rendered) {
		evict_if_over_limit(cache_dir, &output_path, max_cache_bytes);
	}

	Ok(output_path)
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use super::*;
	use crate::spec::{CropRect, FitMode, Preset, SourceDimensions, Trim};

	fn sample_spec() -> EditSpec {
		EditSpec {
			source: SourceDimensions {
				width: 1920,
				height: 1080,
			},
			trim: Some(Trim {
				start: 1.0,
				end: 5.0,
			}),
			crop: Some(CropRect {
				x: 0.1,
				y: 0.0,
				width: 0.8,
				height: 1.0,
			}),
			preset: Preset {
				name: "9:16".to_string(),
				width: 1080,
				height: 1920,
				fit: FitMode::BlurPad,
			},
		}
	}

	fn epoch_plus(secs: u64) -> SystemTime {
		UNIX_EPOCH + Duration::from_secs(secs)
	}

	#[test]
	fn same_input_produces_same_key() {
		let spec = sample_spec();
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);

		let key1 = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);
		let key2 = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);

		assert_eq!(key1, key2);
		assert_eq!(key1.len(), KEY_HEX_LEN);
	}

	#[test]
	fn preset_change_produces_different_key() {
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);
		let mut spec = sample_spec();
		let base_key = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);

		spec.preset.width = 1350;
		spec.preset.height = 1080;
		let changed_key = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);

		assert_ne!(base_key, changed_key);
	}

	#[test]
	fn fit_mode_change_produces_different_key() {
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);
		let mut spec = sample_spec();
		let base_key = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);

		spec.preset.fit = FitMode::Crop;
		let changed_key = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);

		assert_ne!(base_key, changed_key);
	}

	#[test]
	fn trim_change_produces_different_key() {
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);
		let mut spec = sample_spec();
		let base_key = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);

		spec.trim = Some(Trim {
			start: 2.0,
			end: 6.0,
		});
		let changed_key = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);

		assert_ne!(base_key, changed_key);
	}

	#[test]
	fn trim_removed_produces_different_key() {
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);
		let mut spec = sample_spec();
		let base_key = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);

		spec.trim = None;
		let changed_key = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);

		assert_ne!(base_key, changed_key);
	}

	#[test]
	fn crop_change_produces_different_key() {
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);
		let mut spec = sample_spec();
		let base_key = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);

		spec.crop = Some(CropRect {
			x: 0.2,
			y: 0.0,
			width: 0.6,
			height: 1.0,
		});
		let changed_key = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);

		assert_ne!(base_key, changed_key);
	}

	#[test]
	fn mtime_change_produces_different_key() {
		let spec = sample_spec();
		let path = Path::new("/tmp/input.mp4");

		let key1 = render_cache_key(
			path,
			12_345,
			epoch_plus(1_700_000_000),
			&spec,
			PREVIEW_BITRATE,
		);
		let key2 = render_cache_key(
			path,
			12_345,
			epoch_plus(1_700_000_001),
			&spec,
			PREVIEW_BITRATE,
		);

		assert_ne!(key1, key2);
	}

	#[test]
	fn size_change_produces_different_key() {
		let spec = sample_spec();
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);

		let key1 = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);
		let key2 = render_cache_key(path, 12_346, mtime, &spec, PREVIEW_BITRATE);

		assert_ne!(key1, key2);
	}

	#[test]
	fn input_path_change_produces_different_key() {
		let spec = sample_spec();
		let mtime = epoch_plus(1_700_000_000);

		let key1 = render_cache_key(
			Path::new("/tmp/a.mp4"),
			12_345,
			mtime,
			&spec,
			PREVIEW_BITRATE,
		);
		let key2 = render_cache_key(
			Path::new("/tmp/b.mp4"),
			12_345,
			mtime,
			&spec,
			PREVIEW_BITRATE,
		);

		assert_ne!(key1, key2);
	}

	#[test]
	fn bit_rate_change_produces_different_key() {
		// 同一入力・同一 spec でも品質(ビットレート)が違えば別キャッシュエントリに
		// なる(プレビュー 2Mbps と投稿用 8Mbps の取り違え防止。ディレクトリ分離に
		// 加えた二重の防御 — モジュール冒頭コメント参照)。
		let spec = sample_spec();
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);

		let preview_key = render_cache_key(path, 12_345, mtime, &spec, PREVIEW_BITRATE);
		let publish_key = render_cache_key(path, 12_345, mtime, &spec, PUBLISH_BITRATE);

		assert_ne!(preview_key, publish_key);
	}

	#[test]
	fn publish_bitrate_matches_full_export_quality() {
		// 投稿用レンダリングの品質が本書き出し(reframe_start の既定 =
		// encode::DEFAULT_BITRATE)と一致していることの固定(誤ってプレビュー品質へ
		// 退行しないこと)。
		assert_eq!(PUBLISH_BITRATE, encode::DEFAULT_BITRATE);
		assert!(PREVIEW_BITRATE < PUBLISH_BITRATE);
	}

	#[test]
	fn field_boundary_ambiguity_does_not_collide() {
		// FIELD_SEPARATOR がなければ path="a" size=1 と path="a1" size=(空) が
		// 衝突しうる、という単純連結の落とし穴を再現できないことを確認する
		// (区切り文字を挟むことで path 側に数字が続いても曖昧にならない)。
		let spec = sample_spec();
		let mtime = epoch_plus(0);

		let key1 = render_cache_key(Path::new("/tmp/a"), 1, mtime, &spec, PREVIEW_BITRATE);
		let key2 = render_cache_key(Path::new("/tmp/a1"), 0, mtime, &spec, PREVIEW_BITRATE);

		assert_ne!(key1, key2);
	}

	#[test]
	fn cache_file_path_uses_key_and_mp4_extension() {
		let dir = Path::new("/cache");
		let path = cache_file_path(dir, "abcdef0123456789");
		assert_eq!(path, PathBuf::from("/cache/abcdef0123456789.mp4"));
	}

	// --- evict_if_over_limit / preview_cache_max_bytes ------------------------------

	use std::fs::OpenOptions;

	// PREVIEW_CACHE_MAX_BYTES_ENV はプロセス全体で共有される状態のため、これを
	// 読み書きするテスト同士が並行実行(cargo test の既定挙動)されると競合する。
	// `concurrency.rs` の ENV_TEST_LOCK と同じ考え方でこのロックで直列化する。
	static ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

	fn with_env_lock<R>(f: impl FnOnce() -> R) -> R {
		let _guard = ENV_TEST_LOCK
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner);
		f()
	}

	fn restore_env_var(env_name: &str, previous: Option<String>) {
		match previous {
			Some(value) => env::set_var(env_name, value),
			None => env::remove_var(env_name),
		}
	}

	fn restore_env(previous: Option<String>) {
		restore_env_var(PREVIEW_CACHE_MAX_BYTES_ENV, previous);
	}

	/// 呼び出しごとに一意な一時ディレクトリを作って返す(他テスト・他プロセスとの
	/// 干渉を避けるため `name` + 現在時刻ナノ秒を組み合わせる。`tempfile` クレートは
	/// 導入せず、既存テスト(`pipeline.rs`)と同様に素の `std::env::temp_dir()` を使う)。
	fn unique_test_dir(name: &str) -> PathBuf {
		let nanos = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map(|d| d.as_nanos())
			.unwrap_or(0);
		let dir = std::env::temp_dir().join(format!("facet-preview-cache-test-{name}-{nanos}"));
		fs::create_dir_all(&dir).expect("create unique test cache dir");
		dir
	}

	/// `dir` 配下に `size` バイトのダミーファイルを作り、`mtime` を明示的に設定する。
	fn write_dummy_file(dir: &Path, file_name: &str, size: u64, mtime: SystemTime) -> PathBuf {
		let path = dir.join(file_name);
		fs::write(&path, vec![0u8; size as usize]).expect("write dummy cache file");
		let file = OpenOptions::new()
			.write(true)
			.open(&path)
			.expect("open dummy cache file to set mtime");
		file.set_modified(mtime).expect("set dummy file mtime");
		path
	}

	fn dir_entries_sorted(dir: &Path) -> Vec<String> {
		let mut names: Vec<String> = fs::read_dir(dir)
			.expect("read test cache dir")
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
	fn is_finished_cache_file_excludes_tmp_files() {
		assert!(is_finished_cache_file(Path::new("/cache/abcdef.mp4")));
		assert!(!is_finished_cache_file(Path::new("/cache/abcdef.tmp.mp4")));
		assert!(!is_finished_cache_file(Path::new("/cache/abcdef.json")));
	}

	#[test]
	fn under_limit_deletes_nothing() {
		let dir = unique_test_dir("under-limit");
		write_dummy_file(&dir, "a.mp4", 100, epoch_plus(1_000));
		write_dummy_file(&dir, "b.mp4", 100, epoch_plus(2_000));

		// 実際には存在しないパスを just_written として渡しても、上限内であれば
		// そもそも削除ループへ入らないため問題にならない。
		evict_if_over_limit(&dir, &dir.join("does-not-exist.mp4"), 10_000);

		assert_eq!(dir_entries_sorted(&dir), vec!["a.mp4", "b.mp4"]);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn over_limit_deletes_oldest_first_and_keeps_newest() {
		let dir = unique_test_dir("over-limit");
		write_dummy_file(&dir, "oldest.mp4", 100, epoch_plus(1_000));
		write_dummy_file(&dir, "middle.mp4", 100, epoch_plus(2_000));
		let newest = write_dummy_file(&dir, "newest.mp4", 100, epoch_plus(3_000));

		// 合計 300 バイト、上限 150 バイト: 古い順に削除し、150 バイト以下になった時点で
		// 止まる(oldest 削除後に 200、middle も削除して 100 <= 150 で停止)。
		evict_if_over_limit(&dir, &newest, 150);

		assert_eq!(dir_entries_sorted(&dir), vec!["newest.mp4"]);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn just_written_file_is_protected_even_if_oldest() {
		let dir = unique_test_dir("protect-just-written");
		// just_written をわざと一番古い mtime にする(「生成直後のファイルが消える
		// 事故」を再現しようとしたケース)。
		let just_written = write_dummy_file(&dir, "just-written.mp4", 100, epoch_plus(1));
		write_dummy_file(
			&dir,
			"older-mtime-but-not-protected.mp4",
			100,
			epoch_plus(2),
		);
		write_dummy_file(&dir, "newer.mp4", 100, epoch_plus(3));

		// 合計 300 バイト、上限 250: 1 ファイル(100 バイト)削除すれば足りる。
		// just_written が(mtime 上は最古でも)保護されるため、実際に削除されるのは
		// just_written を除いて最も古い "older-mtime-but-not-protected" であり、
		// "newer" は生き残る。
		evict_if_over_limit(&dir, &just_written, 250);

		let remaining = dir_entries_sorted(&dir);
		assert_eq!(
			remaining,
			vec!["just-written.mp4", "newer.mp4"],
			"just_written must survive despite being oldest, and newer.mp4 must not be \
			 deleted once the limit is satisfied"
		);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn tmp_files_are_ignored_by_size_accounting_and_never_deleted() {
		let dir = unique_test_dir("tmp-files-ignored");
		// .tmp.mp4 は「実行中ジョブの一時ファイル」を模している。サイズを大きくして
		// あっても、これのみを理由に削除が発生してはならない(finished ファイルの合計
		// のみで判定するため)。
		write_dummy_file(&dir, "in-progress.tmp.mp4", 10_000, epoch_plus(1));
		let finished = write_dummy_file(&dir, "finished.mp4", 100, epoch_plus(2));

		evict_if_over_limit(&dir, &finished, 10_000_000);

		assert_eq!(
			dir_entries_sorted(&dir),
			vec!["finished.mp4", "in-progress.tmp.mp4"]
		);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn preview_cache_max_bytes_uses_default_when_env_unset_or_invalid() {
		with_env_lock(|| {
			let previous = env::var(PREVIEW_CACHE_MAX_BYTES_ENV).ok();

			env::remove_var(PREVIEW_CACHE_MAX_BYTES_ENV);
			assert_eq!(preview_cache_max_bytes(), DEFAULT_PREVIEW_CACHE_MAX_BYTES);

			env::set_var(PREVIEW_CACHE_MAX_BYTES_ENV, "not-a-number");
			assert_eq!(preview_cache_max_bytes(), DEFAULT_PREVIEW_CACHE_MAX_BYTES);

			env::set_var(PREVIEW_CACHE_MAX_BYTES_ENV, "0");
			assert_eq!(preview_cache_max_bytes(), DEFAULT_PREVIEW_CACHE_MAX_BYTES);

			restore_env(previous);
		});
	}

	#[test]
	fn preview_cache_max_bytes_env_override_takes_effect() {
		with_env_lock(|| {
			let previous = env::var(PREVIEW_CACHE_MAX_BYTES_ENV).ok();

			env::set_var(PREVIEW_CACHE_MAX_BYTES_ENV, "12345");
			assert_eq!(preview_cache_max_bytes(), 12_345);

			restore_env(previous);
		});
	}

	#[test]
	fn publish_cache_max_bytes_is_independent_from_preview_env() {
		// 投稿用キャッシュの上限は専用の環境変数(PUBLISH_CACHE_MAX_BYTES_ENV)のみを
		// 見る — プレビュー側の環境変数を設定しても publish 側の上限は変わらず、
		// その逆も同様(ディレクトリ分離と対になる独立した容量管理)。
		with_env_lock(|| {
			let prev_preview = env::var(PREVIEW_CACHE_MAX_BYTES_ENV).ok();
			let prev_publish = env::var(PUBLISH_CACHE_MAX_BYTES_ENV).ok();

			env::remove_var(PUBLISH_CACHE_MAX_BYTES_ENV);
			env::set_var(PREVIEW_CACHE_MAX_BYTES_ENV, "111");
			assert_eq!(preview_cache_max_bytes(), 111);
			assert_eq!(publish_cache_max_bytes(), DEFAULT_PREVIEW_CACHE_MAX_BYTES);

			env::set_var(PUBLISH_CACHE_MAX_BYTES_ENV, "222");
			assert_eq!(publish_cache_max_bytes(), 222);
			assert_eq!(preview_cache_max_bytes(), 111);

			restore_env_var(PREVIEW_CACHE_MAX_BYTES_ENV, prev_preview);
			restore_env_var(PUBLISH_CACHE_MAX_BYTES_ENV, prev_publish);
		});
	}

	#[test]
	fn publish_cache_max_bytes_uses_default_when_env_unset_or_invalid() {
		with_env_lock(|| {
			let previous = env::var(PUBLISH_CACHE_MAX_BYTES_ENV).ok();

			env::remove_var(PUBLISH_CACHE_MAX_BYTES_ENV);
			assert_eq!(publish_cache_max_bytes(), DEFAULT_PREVIEW_CACHE_MAX_BYTES);

			env::set_var(PUBLISH_CACHE_MAX_BYTES_ENV, "not-a-number");
			assert_eq!(publish_cache_max_bytes(), DEFAULT_PREVIEW_CACHE_MAX_BYTES);

			env::set_var(PUBLISH_CACHE_MAX_BYTES_ENV, "0");
			assert_eq!(publish_cache_max_bytes(), DEFAULT_PREVIEW_CACHE_MAX_BYTES);

			restore_env_var(PUBLISH_CACHE_MAX_BYTES_ENV, previous);
		});
	}

	// ---- coalesce_render(M-2: 同一 output の二重要求) --------------------------

	#[test]
	fn coalesce_render_renders_immediately_without_sleeping() {
		let cancel = CancelToken::new();
		let slept = std::cell::Cell::new(0usize);
		let outcome = coalesce_render(
			&cancel,
			Path::new("/tmp/x.mp4"),
			|| false,
			|| Ok(RenderAttempt::Rendered),
			|_| slept.set(slept.get() + 1),
			10,
		)
		.expect("should render");
		assert!(matches!(outcome, RenderOutcome::Rendered));
		assert_eq!(slept.get(), 0, "書き出せたら待たない");
	}

	#[test]
	fn coalesce_render_waits_then_shares_cache() {
		let cancel = CancelToken::new();
		let checks = std::cell::Cell::new(0usize);
		let slept = std::cell::Cell::new(0usize);
		let outcome = coalesce_render(
			&cancel,
			Path::new("/tmp/x.mp4"),
			|| {
				// 2 回目の確認で 1 本目の成果物が出現したことにする。
				let n = checks.get();
				checks.set(n + 1);
				n >= 1
			},
			|| Ok(RenderAttempt::Busy),
			|_| slept.set(slept.get() + 1),
			10,
		)
		.expect("should coalesce");
		assert!(matches!(outcome, RenderOutcome::Coalesced));
		assert!(slept.get() >= 1, "1 本目を待つ間 sleep する");
	}

	#[test]
	fn coalesce_render_busy_then_renders_when_first_fails() {
		let cancel = CancelToken::new();
		let attempts = std::cell::Cell::new(0usize);
		let outcome = coalesce_render(
			&cancel,
			Path::new("/tmp/x.mp4"),
			|| false,
			|| {
				// 1 回目は busy、2 回目(1 本目が解放された後)は自分が書き出す。
				let n = attempts.get();
				attempts.set(n + 1);
				if n == 0 {
					Ok(RenderAttempt::Busy)
				} else {
					Ok(RenderAttempt::Rendered)
				}
			},
			|_| {},
			10,
		)
		.expect("should render on retry");
		assert!(matches!(outcome, RenderOutcome::Rendered));
		assert_eq!(attempts.get(), 2);
	}

	#[test]
	fn coalesce_render_propagates_non_busy_error() {
		let cancel = CancelToken::new();
		let err = coalesce_render(
			&cancel,
			Path::new("/tmp/x.mp4"),
			|| false,
			|| Err(MediaError::EncoderNotFound { name: "x".into() }),
			|_| {},
			10,
		)
		.expect_err("should propagate");
		assert!(matches!(err, MediaError::EncoderNotFound { .. }));
	}

	#[test]
	fn coalesce_render_returns_cancelled() {
		let cancel = CancelToken::new();
		cancel.cancel();
		let err = coalesce_render(
			&cancel,
			Path::new("/tmp/x.mp4"),
			|| false,
			|| Ok(RenderAttempt::Rendered),
			|_| {},
			10,
		)
		.expect_err("should be cancelled");
		assert!(matches!(err, MediaError::Cancelled));
	}

	#[test]
	fn coalesce_render_times_out_as_output_busy() {
		let cancel = CancelToken::new();
		let outcome = coalesce_render(
			&cancel,
			Path::new("/tmp/busy.mp4"),
			|| false,
			|| Ok(RenderAttempt::Busy),
			|_| {},
			3,
		);
		assert!(matches!(outcome, Err(MediaError::OutputBusy { .. })));
	}
}
