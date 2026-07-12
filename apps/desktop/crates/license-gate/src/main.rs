//! license-gate: 配布用 FFmpeg(LGPL 構成)のライセンス適合を実行時に検査するバイナリ。
//!
//! Phase 4 Wave B。目的は「配布ビルドが実際にリンクする FFmpeg 共有ライブラリが
//! LGPL 構成であり、GPL 専用コンポーネント(libx264 等)を含んでいないこと」を
//! 機械的に保証すること。`cargo deny check` は Rust クレートのライセンスしか
//! 判定できず(deny.toml 冒頭コメント参照)、FFmpeg 共有ライブラリの実行時リンク先
//! はその対象外のため、本クレートで別途検査する。
//!
//! 検査項目:
//! 1. `avutil_license()` が "LGPL" で始まる。
//! 2. `avcodec_configuration()` に `--enable-gpl` 等の禁止フラグが含まれない。
//! 3. `libx264` / `libx264rgb` / `libx265` / `libxvid` が未登録(GPL 専用エンコーダ)。
//! 4. `h264_amf` / `h264_mf` が登録済み(LGPL 構成でも収録される Windows HW エンコーダ)。
//! 5. 検査に使った DLL のフルパスをログ出力する(Windows のみ)。
//!
//! いずれか1つでも不合格なら非ゼロで終了する(exit code 1)。
//!
//! 実行方法: `scripts/run-license-gate.ps1` 経由(PATH を検査対象のステージング先
//! ディレクトリ(既定は `src-tauri/ffmpeg-dist`)に絞ってから `cargo run -p
//! license-gate --release` する)。単独で `cargo run -p license-gate` する場合は、
//! 検査対象の DLL のみが PATH 上で解決される状態にしてから実行すること
//! (システムにインストール済みの別の FFmpeg が優先されると誤判定する)。

use std::process::ExitCode;

mod checks;
#[cfg(windows)]
mod module_path;

use checks::{CheckOutcome, CheckResult};

fn main() -> ExitCode {
	println!("=== license-gate: FFmpeg ライセンス適合検査(Phase 4 Wave B) ===\n");

	// avformat/avdevice 等の登録。license/configuration の読み出しや
	// encoder::find_by_name の解決に必須ではないが、media-core(decode.rs)と同じ
	// 初期化経路を通すことで実運用時のリンク状態に近づける。
	if let Err(err) = ffmpeg_next::init() {
		eprintln!("[license-gate] FFmpeg の初期化に失敗しました: {err}");
		eprintln!(
			"[license-gate] PATH 上に検査対象の FFmpeg 共有ライブラリ(DLL)が \
			 見つからない可能性があります。scripts/run-license-gate.ps1 の使い方を \
			 確認してください。"
		);
		return ExitCode::FAILURE;
	}

	let license = ffmpeg_next::util::license();
	let configuration = ffmpeg_next::codec::configuration();

	let mut results = vec![
		checks::check_license(license),
		checks::check_configuration(configuration),
	];
	for name in checks::FORBIDDEN_ENCODERS {
		let found = ffmpeg_next::encoder::find_by_name(name).is_some();
		results.push(checks::check_encoder_absent(name, found));
	}
	for name in checks::REQUIRED_HW_ENCODERS {
		let found = ffmpeg_next::encoder::find_by_name(name).is_some();
		results.push(checks::check_encoder_present(name, found));
	}

	print_report(&results);
	log_inspected_dll_paths();

	if results.iter().all(|r| r.outcome == CheckOutcome::Pass) {
		println!("\n[license-gate] 合格: 配布可能な LGPL 構成であることを確認しました。");
		ExitCode::SUCCESS
	} else {
		eprintln!(
			"\n[license-gate] 不合格: GPL 系コンポーネントの混入、または想定と異なる \
			 FFmpeg がリンクされています。上記の NG 項目を確認してください。"
		);
		eprintln!(
			"[license-gate] PATH に配布用ステージング(ffmpeg-dist)以外の FFmpeg が \
			 混在していないか確認してください。"
		);
		ExitCode::FAILURE
	}
}

fn print_report(results: &[CheckResult]) {
	for r in results {
		let mark = match r.outcome {
			CheckOutcome::Pass => "OK",
			CheckOutcome::Fail => "NG",
		};
		println!("[{mark}] {}", r.label);
		println!("     {}", r.detail);
	}
}

#[cfg(windows)]
fn log_inspected_dll_paths() {
	println!("\n検査対象 DLL:");
	println!(
		"  avutil : {}",
		module_path::find_loaded_module_path("avutil")
	);
	println!(
		"  avcodec: {}",
		module_path::find_loaded_module_path("avcodec")
	);
}

#[cfg(not(windows))]
fn log_inspected_dll_paths() {
	println!("\n検査対象 DLL: (Windows 以外のためパス解決をスキップします)");
}
