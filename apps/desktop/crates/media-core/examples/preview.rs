//! `media_core::preview::render_preview` の手動検証用 CLI。
//! 同じ `<input> <cache_dir>` を 2 回実行し、1 回目はプレビュー生成(キャッシュミス)、
//! 2 回目は再エンコードなしの即時ヒットになることを確認する用途を想定する
//! (`examples/reframe.rs`/`examples/probe.rs` と同じく薄いラッパ)。
//!
//! 使い方:
//!   cargo run --example preview -- <input> <cache_dir> <blur-pad|crop> <target_w> <target_h>
//!
//! 実行時間を出力するので、1 回目(生成)と 2 回目(キャッシュヒット)を見比べれば
//! 「2 回目が明らかに速い(実質 I/O のみ)」ことを目視確認できる。キャッシュヒット時は
//! 内部で `pipeline::reframe` を呼ばないため、進捗コールバックも一切発火しない
//! (このログの有無自体もヒット/ミスの判別材料になる)。

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use media_core::spec::{EditSpec, FitMode, Preset, SourceDimensions};
use media_core::{preview, probe, CancelToken, MediaError};

fn main() -> ExitCode {
	match run() {
		Ok(()) => ExitCode::SUCCESS,
		Err(err) => {
			eprintln!("error: {err}");
			ExitCode::FAILURE
		}
	}
}

fn run() -> Result<(), MediaError> {
	let args: Vec<String> = std::env::args().skip(1).collect();
	if args.len() < 5 {
		eprintln!("usage: preview <input> <cache_dir> <blur-pad|crop> <target_w> <target_h>");
		std::process::exit(2);
	}

	let input = PathBuf::from(&args[0]);
	let cache_dir = PathBuf::from(&args[1]);
	let fit_mode = match args[2].as_str() {
		"blur-pad" => FitMode::BlurPad,
		"crop" | "crop-cover" => FitMode::Crop,
		other => {
			eprintln!("unknown fit: {other} (expected blur-pad|crop)");
			std::process::exit(2);
		}
	};
	let width: u32 = args[3].parse().unwrap_or_else(|_| {
		eprintln!("invalid target_w: {}", args[3]);
		std::process::exit(2);
	});
	let height: u32 = args[4].parse().unwrap_or_else(|_| {
		eprintln!("invalid target_h: {}", args[4]);
		std::process::exit(2);
	});

	// crop は使わないので source は probe で実寸を拾っておく(preview_cache_key の
	// 決定性には影響しないが、EditSpec.source は必須フィールドなので埋める)。
	let info = probe::probe(&input)?;
	let spec = EditSpec {
		source: SourceDimensions {
			width: info.width,
			height: info.height,
		},
		trim: None,
		crop: None,
		preset: Preset {
			name: "preview-cli".to_string(),
			width,
			height,
			fit: fit_mode,
		},
	};

	println!(
		"input={} cache_dir={} target={width}x{height}",
		input.display(),
		cache_dir.display()
	);

	// 1 回目: キャッシュミストなら生成、既にあればヒット(この例を単独で複数回
	// 実行してヒットを確認することもできる)。
	run_once(&input, &spec, &cache_dir, 1)?;
	// 2 回目: 同じ spec で呼び直す。ここは常にキャッシュヒットになるはず
	// (同一プロセス内なので入力ファイルの mtime/size も変わらない)。
	run_once(&input, &spec, &cache_dir, 2)?;

	Ok(())
}

fn run_once(
	input: &Path,
	spec: &EditSpec,
	cache_dir: &Path,
	attempt: u32,
) -> Result<(), MediaError> {
	let cancel_token = CancelToken::new();
	let on_progress = |progress: media_core::Progress| {
		println!(
			"  [attempt {attempt}] frame={} out_time={:.2}s",
			progress.frame, progress.out_time_secs
		);
	};

	let start = Instant::now();
	let output = preview::render_preview(input, spec, cache_dir, &cancel_token, &on_progress)?;
	let elapsed = start.elapsed();

	println!(
		"attempt {attempt}: -> {} ({:.3}s elapsed)",
		output.display(),
		elapsed.as_secs_f64()
	);
	Ok(())
}
