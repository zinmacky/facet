//! スパイク(`spikes/libav-reframe/src/reframe.rs`)相当の手動検証用 CLI。
//! 実機検証(Windows h264_amf/h264_mf、mac h264_videotoolbox)と、後続ウェーブの
//! 回帰確認に使う。`media-core` の公開 API(`media_core::reframe`)をそのまま叩く
//! 薄いラッパで、パイプライン本体のロジックはここには置かない。
//!
//! 使い方:
//!   cargo run --example reframe -- <input> <output> <blur-pad|crop> <target_w> <target_h> \
//!       [encoder|auto] [cancel_after_frames] [--trim=<start>:<end>] [--crop=<x>:<y>:<w>:<h>]
//!
//! - `encoder` を省略するか `auto` を指定すると `encoder_select::select()` の
//!   プラットフォーム別候補(Windows: h264_amf → h264_mf、mac: h264_videotoolbox)を
//!   先頭から順に試す(Wave 2 配線)。エンコーダ名を明示すると、そのプラットフォームの
//!   候補テーブルに一致するエントリがあれば同じ追加オプション(例: h264_mf の
//!   `hw_encoding=1`)を再利用する(なければオプションなしで開く)。
//! - `--trim=<start>:<end>`(秒)を指定すると、その区間だけを処理する
//!   (`ReframeOptions.trim`、Wave 2 配線)。
//! - `--crop=<x>:<y>:<w>:<h>`(0..1 正規化)を指定すると、事前クロップを適用する
//!   (`ReframeOptions.crop`)。実ピクセルへの解決に必要な `source` 寸法は
//!   `media_core::probe::probe` で入力ファイルから取得する。
//! - `cancel_after_frames` を指定すると、そのフレーム数を送出した時点で進捗コールバックが
//!   `CancelToken::cancel()` を呼ぶ(キャンセルフックの動作確認用)。
//!   例: `... h264_amf 30` → 30 フレーム目で中断し、一時出力が残らないことを確認できる。

use std::path::PathBuf;

use media_core::encoder_select::{self, Platform};
use media_core::spec::{CropRect, FitMode, Preset, SourceDimensions, Trim};
use media_core::{
	encode, fit, pipeline, probe, reframe, CancelToken, EncoderSelection, MediaError,
	ReframeOptions,
};

fn main() {
	if let Err(err) = run() {
		eprintln!("error: {err}");
		std::process::exit(1);
	}
}

fn run() -> Result<(), MediaError> {
	let raw_args: Vec<String> = std::env::args().skip(1).collect();
	let (flags, positional): (Vec<&str>, Vec<&str>) = raw_args
		.iter()
		.map(|s| s.as_str())
		.partition(|a| a.starts_with("--"));

	if positional.len() < 5 {
		eprintln!(
            "usage: reframe <input> <output> <blur-pad|crop> <target_w> <target_h> [encoder|auto] [cancel_after_frames] [--trim=<start>:<end>] [--crop=<x>:<y>:<w>:<h>]"
        );
		std::process::exit(2);
	}

	let input = PathBuf::from(positional[0]);
	let output = PathBuf::from(positional[1]);
	let fit_mode = parse_fit(positional[2]);
	let width: u32 = parse_u32(positional[3], "target_w");
	let height: u32 = parse_u32(positional[4], "target_h");
	let encoder_arg = positional.get(5).copied();
	let cancel_after_frames: Option<u64> = positional.get(6).and_then(|s| s.parse().ok());

	let trim: Option<Trim> = flags
		.iter()
		.find_map(|f| f.strip_prefix("--trim="))
		.map(parse_trim);
	let crop: Option<CropRect> = flags
		.iter()
		.find_map(|f| f.strip_prefix("--crop="))
		.map(parse_crop);

	// crop 適用時のみ実際のソース寸法が必要(pre_crop 計算用)。probe を使って
	// 手動で寸法を渡す手間をなくす(Tauri コマンドから呼ぶ将来形にも近い)。
	let source = match crop {
		Some(_) => {
			let info = probe::probe(&input)?;
			SourceDimensions {
				width: info.width,
				height: info.height,
			}
		}
		None => SourceDimensions {
			width: 0,
			height: 0,
		},
	};

	let preset = Preset {
		name: "cli".to_string(),
		width,
		height,
		fit: fit_mode,
	};

	// encoder_name を省略(または "auto")すると encoder_select::select() の候補を
	// 順に試す。明示指定時は、現在のプラットフォームの候補テーブルに同名の
	// エントリがあればその追加オプション(hw_encoding=1 等)を再利用する
	// (Wave 1 時点の h264_mf ハードコードの一般化、モジュール冒頭コメント参照)。
	let selection = match encoder_arg {
		None | Some("auto") => EncoderSelection::Auto,
		Some(name) => {
			let options = encoder_select::candidate_table(Platform::current())
				.iter()
				.find(|choice| choice.name == name)
				.map(|choice| choice.to_dictionary())
				.unwrap_or_default();
			EncoderSelection::Explicit { name, options }
		}
	};

	// cancel_after_frames が指定されていれば、進捗コールバック内でフレーム数を見て
	// CancelToken::cancel() を呼ぶ(Tauri 側でも「別経路からの cancel() 呼び出しで
	// 次のループ境界チェックを止める」という同じ形になる想定)。
	let cancel_token = CancelToken::new();
	let on_progress = |progress: pipeline::Progress| {
		if let Some(limit) = cancel_after_frames {
			if progress.frame >= limit {
				cancel_token.cancel();
			}
		}
		match progress.percent {
			Some(percent) => println!(
				"frame={} total={:?} percent={:.1}% out_time={:.2}s fps={:.1} speed={:.2}x",
				progress.frame,
				progress.total_frames,
				percent,
				progress.out_time_secs,
				progress.fps,
				progress.speed
			),
			None => println!(
				"frame={} total=unknown out_time={:.2}s fps={:.1} speed={:.2}x",
				progress.frame, progress.out_time_secs, progress.fps, progress.speed
			),
		}
	};

	println!(
		"fit={} target={width}x{height} encoder={} trim={:?} crop={:?}",
		fit_label(&preset.fit),
		encoder_arg.unwrap_or("auto"),
		trim,
		crop,
	);

	let options = ReframeOptions {
		preset: &preset,
		sigma: fit::DEFAULT_SIGMA,
		crop,
		source,
		trim,
		encoder: selection,
		bit_rate: encode::DEFAULT_BITRATE,
		cancel: &cancel_token,
		on_progress: &on_progress,
		staging_dir: None,
	};

	let encoder_used = reframe(&input, &output, options)?;
	println!("done -> {} (encoder={encoder_used})", output.display());
	Ok(())
}

fn parse_fit(raw: &str) -> FitMode {
	match raw {
		"blur-pad" => FitMode::BlurPad,
		"crop" | "crop-cover" => FitMode::Crop,
		other => {
			eprintln!("unknown fit: {other} (expected blur-pad|crop)");
			std::process::exit(2);
		}
	}
}

fn parse_u32(raw: &str, label: &str) -> u32 {
	raw.parse().unwrap_or_else(|_| {
		eprintln!("invalid {label}: {raw}");
		std::process::exit(2);
	})
}

/// `--trim=<start>:<end>`(秒)をパースする。
fn parse_trim(raw: &str) -> Trim {
	let parts: Vec<&str> = raw.split(':').collect();
	let [start, end] = parts.as_slice() else {
		eprintln!("invalid --trim (expected <start>:<end>): {raw}");
		std::process::exit(2);
	};
	let start: f64 = start.parse().unwrap_or_else(|_| {
		eprintln!("invalid --trim start: {start}");
		std::process::exit(2);
	});
	let end: f64 = end.parse().unwrap_or_else(|_| {
		eprintln!("invalid --trim end: {end}");
		std::process::exit(2);
	});
	Trim { start, end }
}

/// `--crop=<x>:<y>:<w>:<h>`(0..1 正規化)をパースする。
fn parse_crop(raw: &str) -> CropRect {
	let parts: Vec<&str> = raw.split(':').collect();
	let [x, y, w, h] = parts.as_slice() else {
		eprintln!("invalid --crop (expected <x>:<y>:<w>:<h>): {raw}");
		std::process::exit(2);
	};
	let parse_component = |label: &str, value: &str| -> f64 {
		value.parse().unwrap_or_else(|_| {
			eprintln!("invalid --crop {label}: {value}");
			std::process::exit(2);
		})
	};
	CropRect {
		x: parse_component("x", x),
		y: parse_component("y", y),
		width: parse_component("width", w),
		height: parse_component("height", h),
	}
}

fn fit_label(fit: &FitMode) -> &'static str {
	match fit {
		FitMode::BlurPad => "blur-pad",
		FitMode::Crop => "crop",
	}
}
