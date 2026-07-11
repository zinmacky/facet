//! スパイク(`spikes/libav-reframe/src/reframe.rs`)相当の手動検証用 CLI。
//! 実機検証(Windows h264_amf/h264_mf、mac h264_videotoolbox)と、後続ウェーブの
//! 回帰確認に使う。`media-core` の公開 API(`media_core::reframe`)をそのまま叩く
//! 薄いラッパで、パイプライン本体のロジックはここには置かない。
//!
//! 使い方:
//!   cargo run --example reframe -- <input> <output> <blur-pad|crop> <target_w> <target_h> [encoder] [cancel_after_frames]
//!
//! `cancel_after_frames` を指定すると、そのフレーム数を送出した時点で進捗コールバックが
//! `CancelToken::cancel()` を呼ぶ(キャンセルフックの動作確認用)。
//! 例: `... h264_amf 30` → 30 フレーム目で中断し、一時出力が残らないことを確認できる。

use std::path::PathBuf;

use ffmpeg_next::Dictionary;

use media_core::spec::{FitMode, Preset};
use media_core::{encode, fit, pipeline, reframe, CancelToken, MediaError, ReframeOptions};

fn main() {
	if let Err(err) = run() {
		eprintln!("error: {err}");
		std::process::exit(1);
	}
}

fn run() -> Result<(), MediaError> {
	let args: Vec<String> = std::env::args().collect();
	if args.len() < 6 {
		eprintln!(
            "usage: reframe <input> <output> <blur-pad|crop> <target_w> <target_h> [encoder] [cancel_after_frames]"
        );
		std::process::exit(2);
	}

	let input = PathBuf::from(&args[1]);
	let output = PathBuf::from(&args[2]);
	let fit_mode = parse_fit(&args[3]);
	let width: u32 = parse_u32(&args[4], "target_w");
	let height: u32 = parse_u32(&args[5], "target_h");
	let encoder_name = args
		.get(6)
		.cloned()
		.unwrap_or_else(|| "h264_videotoolbox".to_string());
	let cancel_after_frames: Option<u64> = args.get(7).and_then(|s| s.parse().ok());

	let preset = Preset {
		name: "cli".to_string(),
		width,
		height,
		fit: fit_mode,
	};

	// h264_mf は既定 -hw_encoding=false のためソフトウェア MFT へ静かにフォールバックする
	// (docs/phase2-0-windows-setup.md §7.2 の実機検証済み挙動)。プラットフォーム別の
	// エンコーダ選択・オプション決定は Wave 2 の `encoder_select` の責務だが、この CLI は
	// スパイク同様この 1 エンコーダのみ暫定的に特別扱いする。
	let mut encoder_options = Dictionary::new();
	if encoder_name == "h264_mf" {
		encoder_options.set("hw_encoding", "1");
	}

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
				"frame={} total={:?} percent={:.1}%",
				progress.frame, progress.total_frames, percent
			),
			None => println!("frame={} total=unknown", progress.frame),
		}
	};

	println!(
		"fit={} target={width}x{height} encoder={encoder_name}",
		fit_label(&preset.fit)
	);

	let options = ReframeOptions {
		preset: &preset,
		sigma: fit::DEFAULT_SIGMA,
		// TODO(Wave 2): trim.rs / crop.rs 接続後、CLI 引数から渡せるようにする。
		pre_crop: None,
		trim: None,
		encoder_name: &encoder_name,
		encoder_options,
		bit_rate: encode::DEFAULT_BITRATE,
		cancel: &cancel_token,
		on_progress: &on_progress,
	};

	reframe(&input, &output, options)?;
	println!("done -> {}", output.display());
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

fn fit_label(fit: &FitMode) -> &'static str {
	match fit {
		FitMode::BlurPad => "blur-pad",
		FitMode::Crop => "crop",
	}
}
