//! `probe` コマンド: 入力ファイルのメディア情報(`media_core::probe::MediaInfo`)を返す。
//!
//! ## renderer 向け API
//!
//! ```ts
//! import { invoke } from "@tauri-apps/api/core";
//!
//! type MediaInfo = {
//!   duration: number;
//!   width: number;
//!   height: number;
//!   sar: string;
//!   dar: string;
//!   fps: number;
//!   hasAudio: boolean;
//!   codec: string;
//! };
//!
//! const info = await invoke<MediaInfo>("probe", { path: "/path/to/input.mp4" });
//! ```
//!
//! 失敗時は `invoke` が reject し、エラーメッセージは `media_core::MediaError` の
//! `Display`(日本語メッセージ、`error.rs` 参照)をそのまま文字列化したもの。

use std::path::{Path, PathBuf};

use media_core::probe::{self, MediaInfo};

/// `probe::probe` を呼ぶロジック本体。`#[tauri::command]` から
/// `spawn_blocking` 経由で呼ばれる(libav の同期 I/O をブロッキングスレッドプールへ
/// 逃がすため)。App ハンドルに依存しないので単体テスト可能。
fn probe_blocking(path: &Path) -> Result<MediaInfo, String> {
	probe::probe(path).map_err(|err| err.to_string())
}

/// `path` のメディア情報を取得する。
///
/// libav の同期 API を直接呼ぶため、Tauri の非同期ランタイムをブロックしないよう
/// `tauri::async_runtime::spawn_blocking`(tokio の blocking スレッドプール)上で実行する。
#[tauri::command]
pub async fn probe(path: String) -> Result<MediaInfo, String> {
	let path = PathBuf::from(path);
	tauri::async_runtime::spawn_blocking(move || probe_blocking(&path))
		.await
		.map_err(|join_err| format!("probe タスクが異常終了しました: {join_err}"))?
}

#[cfg(test)]
mod tests {
	use super::*;

	/// 実ファイルで probe が MediaInfo を返すことを確認する
	/// (§検証: 実機/実ファイルでの結合確認の一部をユニットテストとして固定)。
	///
	/// `FACET_DESKTOP_TEST_FIXTURE_MP4` 環境変数でパスを上書きできる(CI 等、開発中の
	/// scratchpad が存在しない環境向け)。未設定時はこの Wave 5 実装時の scratchpad
	/// にあった検証用ファイルにフォールバックする。いずれのパスも存在しない実行環境
	/// (このリポジトリの通常の CI 等、facet-desktop は除外されている)ではスキップする。
	#[test]
	fn probe_blocking_reads_real_file() {
		let fallback = r"C:\Users\zinzo\AppData\Local\Temp\claude\C--Users-zinzo-workspace-facet\dcb872a5-bd39-4a4b-a986-250c389ab11e\scratchpad\input_test_5s.mp4";
		let owned = std::env::var("FACET_DESKTOP_TEST_FIXTURE_MP4")
			.unwrap_or_else(|_| fallback.to_string());
		let path = Path::new(&owned);
		if !path.exists() {
			eprintln!("skip: test fixture not found at {}", path.display());
			return;
		}
		let info = probe_blocking(path).expect("probe should succeed for a valid mp4");
		assert!(info.width > 0);
		assert!(info.height > 0);
		assert!(info.duration > 0.0);
	}

	#[test]
	fn probe_blocking_missing_file_returns_readable_error() {
		let path = Path::new("this-file-should-not-exist-facet-desktop-test.mp4");
		let err = probe_blocking(path).expect_err("missing file must fail");
		assert!(!err.is_empty());
	}
}
