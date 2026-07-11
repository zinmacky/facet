//! `media_core::probe::probe` の手動検証用 CLI。パスを受け取り `MediaInfo` を
//! JSON で標準出力へ出す。`examples/reframe.rs` と同じく薄いラッパで、
//! ロジック本体は置かない。
//!
//! 使い方:
//!   cargo run --example probe -- <input>

use std::path::PathBuf;
use std::process::ExitCode;

use media_core::probe;

fn main() -> ExitCode {
	let args: Vec<String> = std::env::args().collect();
	let Some(input) = args.get(1) else {
		eprintln!("usage: probe <input>");
		return ExitCode::from(2);
	};

	let path = PathBuf::from(input);
	match probe::probe(&path) {
		Ok(info) => match serde_json::to_string_pretty(&info) {
			Ok(json) => {
				println!("{json}");
				ExitCode::SUCCESS
			}
			Err(err) => {
				eprintln!("error: JSON への変換に失敗しました ({err})");
				ExitCode::FAILURE
			}
		},
		Err(err) => {
			eprintln!("error: {err}");
			ExitCode::FAILURE
		}
	}
}
