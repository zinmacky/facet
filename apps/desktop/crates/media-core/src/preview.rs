//! プレビュー仮エンコード + spec ハッシュキャッシュ。
//!
//! 移植元(真実の源): `apps/studio/server/src/routes/preview.ts`。TS 版は
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
//! **キャッシュ削除ポリシーは未定**(Phase 2 media-core 実装計画の既知リスク4)。
//! `cache_dir` は際限なく増え続けるため、上限サイズ・世代数・最終アクセス時刻に基づく
//! 掃除のいずれかを Tauri 統合時までに決める必要がある。本モジュールはキャッシュの
//! 書き込み・参照のみを行い、削除は一切行わない。
//!
//! TODO(キャッシュ削除ポリシー未定): 上限サイズ/世代数/LRU 等の掃除方針を決めて
//! ここに実装する(docs/desktop-migration-plan.md 側にも追記予定)。

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::cancel::CancelToken;
use crate::error::Result;
use crate::fit;
use crate::pipeline::{self, EncoderSelection, Progress, ReframeOptions};
use crate::spec::EditSpec;

/// プレビュー用ビットレート。TS 版 `preview.ts` の `bitrate: "2M"` と同一
/// (`encode::DEFAULT_BITRATE`(8Mbps)より低く、生成を高速化する)。
pub const PREVIEW_BITRATE: usize = 2_000_000;

/// キャッシュキー材料のフィールド区切りに使うバイト。パス文字列や JSON 中に
/// まず出現しない制御文字(U+0001, ASCII SOH)を使い、`"a" + "1"` と
/// `"a1" + ""` のような連結の曖昧さを避ける。
const FIELD_SEPARATOR: char = '\u{1}';

/// キャッシュファイル名の先頭ハッシュ部分の長さ(16 進数の桁数)。
/// TS 版(sha1 先頭 16 桁 = 64bit)より衝突耐性を高めるため 32 桁(sha256 の
/// 先頭 128bit)を採用する。
const KEY_HEX_LEN: usize = 32;

/// `input_path` + `input_size` + `input_mtime` + `spec` からプレビューキャッシュの
/// キーを作る(ファイル名にそのまま使える 16 進数文字列。拡張子は含まない)。
///
/// 決定性の要件:
/// - 同一の引数(`input_path`/`input_size`/`input_mtime`/`spec` がすべて等しい)を
///   何度呼んでも同じキーを返す(プロセスを跨いでも安定 — sha256 は乱数シードを
///   持たないアルゴリズムなので `std::collections::hash_map::DefaultHasher`
///   (SipHash、プロセスごとにシードが変わりうる)とは異なりこれが保証される)。
/// - `spec`(preset/trim/crop のいずれか)が変われば別のキーになる。
/// - `input_size`/`input_mtime` が変われば(パスが同じでも)別のキーになる
///   (同一パスへの上書きを検知するため。モジュール冒頭コメント参照)。
///
/// `input_path` は呼び出し側で解決済み(正規化・絶対パス化された)ものを渡す想定。
/// 本関数はパス解決(`fs::canonicalize` 等)を行わない — 相対パスと絶対パスで別の
/// パスとして扱われるべきかは呼び出し側の責務とする(TS 版は `resolve(input)` を
/// 呼び出し側の関数内で行っている。`render_preview` はここで `input` をそのまま
/// 材料に使うので、呼び出し側が同じファイルに対して常に同じ表記のパスを渡す
/// 必要がある)。
pub fn preview_cache_key(
	input_path: &Path,
	input_size: u64,
	input_mtime: SystemTime,
	spec: &EditSpec,
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
		"{}{sep}{}{sep}{}{sep}{}",
		input_path.to_string_lossy(),
		input_size,
		mtime_nanos,
		spec_repr,
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

/// `spec` に従って `input` を低ビットレートでプレビュー用に再フレーミングし、
/// `cache_dir` 配下にキャッシュする。
///
/// - キャッシュヒット(同一 `input`(サイズ/mtime 含む)+ 同一 `spec` で既に生成済み)
///   の場合は再エンコードせず既存ファイルのパスを即座に返す。
/// - キャッシュミスの場合は [`pipeline::reframe`] を [`PREVIEW_BITRATE`] で実行し、
///   `<cache_dir>/<key>.mp4` に書き出す。書き込みは `reframe` 自身が行う
///   一時ファイル→リネーム方式(`pipeline.rs` 冒頭コメント参照)にそのまま乗るため、
///   本関数側で追加の原子性担保は不要(中断・失敗時に不完全な mp4 が
///   `cache_dir` に残ることはない)。
/// - エンコーダは [`EncoderSelection::Auto`](プラットフォーム別候補、
///   `encoder_select` 参照)を使う(プレビュー用途でも本エンコードと同じ選択規則)。
///
/// TODO(キャッシュ削除ポリシー未定): 本関数は `cache_dir` を掃除しない
///   (モジュール冒頭コメント参照)。
pub fn render_preview(
	input: &Path,
	spec: &EditSpec,
	cache_dir: &Path,
	cancel: &CancelToken,
	on_progress: &dyn Fn(Progress),
) -> Result<PathBuf> {
	let metadata = fs::metadata(input)?;
	let input_size = metadata.len();
	let input_mtime = metadata.modified()?;

	let key = preview_cache_key(input, input_size, input_mtime, spec);
	fs::create_dir_all(cache_dir)?;
	let output_path = cache_file_path(cache_dir, &key);

	// キャッシュヒット: 既存ファイルをそのまま返す(再エンコードしない)。
	// `reframe` は完了時のみ最終ファイル名を出現させる(§6.2)ため、ここで
	// `output_path` が存在するなら生成は完了済みであることが保証されている。
	if output_path.exists() {
		return Ok(output_path);
	}

	let options = ReframeOptions {
		preset: &spec.preset,
		sigma: fit::DEFAULT_SIGMA,
		crop: spec.crop,
		source: spec.source,
		trim: spec.trim,
		encoder: EncoderSelection::Auto,
		bit_rate: PREVIEW_BITRATE,
		cancel,
		on_progress,
	};

	pipeline::reframe(input, &output_path, options)?;
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

		let key1 = preview_cache_key(path, 12_345, mtime, &spec);
		let key2 = preview_cache_key(path, 12_345, mtime, &spec);

		assert_eq!(key1, key2);
		assert_eq!(key1.len(), KEY_HEX_LEN);
	}

	#[test]
	fn preset_change_produces_different_key() {
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);
		let mut spec = sample_spec();
		let base_key = preview_cache_key(path, 12_345, mtime, &spec);

		spec.preset.width = 1350;
		spec.preset.height = 1080;
		let changed_key = preview_cache_key(path, 12_345, mtime, &spec);

		assert_ne!(base_key, changed_key);
	}

	#[test]
	fn fit_mode_change_produces_different_key() {
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);
		let mut spec = sample_spec();
		let base_key = preview_cache_key(path, 12_345, mtime, &spec);

		spec.preset.fit = FitMode::Crop;
		let changed_key = preview_cache_key(path, 12_345, mtime, &spec);

		assert_ne!(base_key, changed_key);
	}

	#[test]
	fn trim_change_produces_different_key() {
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);
		let mut spec = sample_spec();
		let base_key = preview_cache_key(path, 12_345, mtime, &spec);

		spec.trim = Some(Trim {
			start: 2.0,
			end: 6.0,
		});
		let changed_key = preview_cache_key(path, 12_345, mtime, &spec);

		assert_ne!(base_key, changed_key);
	}

	#[test]
	fn trim_removed_produces_different_key() {
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);
		let mut spec = sample_spec();
		let base_key = preview_cache_key(path, 12_345, mtime, &spec);

		spec.trim = None;
		let changed_key = preview_cache_key(path, 12_345, mtime, &spec);

		assert_ne!(base_key, changed_key);
	}

	#[test]
	fn crop_change_produces_different_key() {
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);
		let mut spec = sample_spec();
		let base_key = preview_cache_key(path, 12_345, mtime, &spec);

		spec.crop = Some(CropRect {
			x: 0.2,
			y: 0.0,
			width: 0.6,
			height: 1.0,
		});
		let changed_key = preview_cache_key(path, 12_345, mtime, &spec);

		assert_ne!(base_key, changed_key);
	}

	#[test]
	fn mtime_change_produces_different_key() {
		let spec = sample_spec();
		let path = Path::new("/tmp/input.mp4");

		let key1 = preview_cache_key(path, 12_345, epoch_plus(1_700_000_000), &spec);
		let key2 = preview_cache_key(path, 12_345, epoch_plus(1_700_000_001), &spec);

		assert_ne!(key1, key2);
	}

	#[test]
	fn size_change_produces_different_key() {
		let spec = sample_spec();
		let path = Path::new("/tmp/input.mp4");
		let mtime = epoch_plus(1_700_000_000);

		let key1 = preview_cache_key(path, 12_345, mtime, &spec);
		let key2 = preview_cache_key(path, 12_346, mtime, &spec);

		assert_ne!(key1, key2);
	}

	#[test]
	fn input_path_change_produces_different_key() {
		let spec = sample_spec();
		let mtime = epoch_plus(1_700_000_000);

		let key1 = preview_cache_key(Path::new("/tmp/a.mp4"), 12_345, mtime, &spec);
		let key2 = preview_cache_key(Path::new("/tmp/b.mp4"), 12_345, mtime, &spec);

		assert_ne!(key1, key2);
	}

	#[test]
	fn field_boundary_ambiguity_does_not_collide() {
		// FIELD_SEPARATOR がなければ path="a" size=1 と path="a1" size=(空) が
		// 衝突しうる、という単純連結の落とし穴を再現できないことを確認する
		// (区切り文字を挟むことで path 側に数字が続いても曖昧にならない)。
		let spec = sample_spec();
		let mtime = epoch_plus(0);

		let key1 = preview_cache_key(Path::new("/tmp/a"), 1, mtime, &spec);
		let key2 = preview_cache_key(Path::new("/tmp/a1"), 0, mtime, &spec);

		assert_ne!(key1, key2);
	}

	#[test]
	fn cache_file_path_uses_key_and_mp4_extension() {
		let dir = Path::new("/cache");
		let path = cache_file_path(dir, "abcdef0123456789");
		assert_eq!(path, PathBuf::from("/cache/abcdef0123456789.mp4"));
	}
}
