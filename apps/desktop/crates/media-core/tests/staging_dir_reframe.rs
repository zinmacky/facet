//! `ReframeOptions.staging_dir` を、実際の `media_core::reframe()` 経由で検証する統合
//! テスト(`pipeline.rs` モジュール冒頭コメント「`ReframeOptions.staging_dir`」参照)。
//!
//! `pipeline.rs` 内の `#[cfg(test)]` ユニットテストは `temp_output_path`/`finalize_output`/
//! `finalize_via_copy` をピュアに(実 ffmpeg なしで)検証するが、ここでは実際に
//! `staging_dir` を渡して `reframe()` を通し、(i) 成功時に staging_dir 配下の一時ファイルが
//! 最終的に `output_path` へ反映され staging_dir が空になること、(ii) `run_pipeline` が
//! staging_dir 内に一時ファイルを作った**後**に失敗した場合、その一時ファイルが
//! 削除されて staging_dir に何も残らないことを確認する。
//!
//! (ii) は `cancel()` によるタイミング依存の中断ではなく、無効なエンコーダ名
//! (`EncoderSelection::Explicit`)による決定的な失敗を使う — `format::output()` は
//! エンコーダを開く**前**に一時ファイルを作成する(`ffmpeg-next` の実装上 `avio_open` が
//! `avformat_alloc_output_context2` 直後に呼ばれるため)ので、無効なエンコーダ名は
//! 「一時ファイル作成後・書き込み前」の失敗を競合レースなしに再現できる。
//!
//! 実 ffmpeg・実 GPU 環境が必要なため `#[ignore]`。リポジトリにコミットされた小さな
//! fixture(`apps/desktop/src-tauri/tests/fixtures/input_test.mp4`)を使うため、追加の
//! 環境変数は不要:
//!
//! ```text
//! cargo test -p media-core --test staging_dir_reframe -- --ignored --nocapture
//! ```

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use ffmpeg_next::Dictionary;
use media_core::spec::{FitMode, Preset, SourceDimensions};
use media_core::{
	encode, fit, reframe, CancelToken, EncoderSelection, MediaError, Progress, ReframeOptions,
};

fn fixture_input() -> PathBuf {
	// このファイル(`crates/media-core/tests/...`)から見て
	// `apps/desktop/src-tauri/tests/fixtures/input_test.mp4`。
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("..")
		.join("..")
		.join("src-tauri")
		.join("tests")
		.join("fixtures")
		.join("input_test.mp4")
}

fn test_preset(name: &str) -> Preset {
	Preset {
		name: name.to_string(),
		width: 320,
		height: 568,
		fit: FitMode::BlurPad,
	}
}

/// 呼び出しごとに一意な一時ディレクトリを作って返す(他テスト・他プロセスとの干渉を
/// 避けるため `name` + 現在時刻ナノ秒を組み合わせる。`preview.rs::unique_test_dir` と
/// 同じ流儀)。
fn unique_test_dir(name: &str) -> PathBuf {
	let nanos = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_nanos())
		.unwrap_or(0);
	let dir = std::env::temp_dir().join(format!("facet-staging-dir-reframe-test-{name}-{nanos}"));
	fs::create_dir_all(&dir).expect("create unique test dir");
	dir
}

fn dir_is_empty(dir: &std::path::Path) -> bool {
	fs::read_dir(dir)
		.expect("read staging dir")
		.next()
		.is_none()
}

#[test]
#[ignore = "実 ffmpeg / 実 GPU 環境が必要。手動実行する(staging_dir 実機検証)"]
fn staging_dir_success_places_final_file_at_output_and_empties_staging_dir() {
	let input = fixture_input();
	assert!(
		input.exists(),
		"fixture not found at {} (see apps/desktop/src-tauri/tests/fixtures/README.md)",
		input.display()
	);

	let staging_dir = unique_test_dir("success-staging");
	let output_dir = unique_test_dir("success-output");
	let output_path = output_dir.join("out.mp4");

	let preset = test_preset("staging-success");
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
		encoder: EncoderSelection::Auto,
		bit_rate: encode::DEFAULT_BITRATE,
		cancel: &cancel,
		on_progress: &on_progress,
		staging_dir: Some(staging_dir.clone()),
	};

	let result = reframe(&input, &output_path, options);

	assert!(result.is_ok(), "expected Ok, got {result:?}");
	assert!(
		output_path.exists(),
		"final output should exist at output_path after success"
	);
	assert!(
		dir_is_empty(&staging_dir),
		"staging_dir should be empty after the tmp file is finalized to output_path"
	);

	let _ = fs::remove_dir_all(&staging_dir);
	let _ = fs::remove_dir_all(&output_dir);
}

#[test]
#[ignore = "実 ffmpeg / 実 GPU 環境が必要。手動実行する(staging_dir 実機検証)"]
fn staging_dir_tmp_created_then_pipeline_failure_leaves_staging_dir_empty() {
	let input = fixture_input();
	assert!(
		input.exists(),
		"fixture not found at {} (see apps/desktop/src-tauri/tests/fixtures/README.md)",
		input.display()
	);

	let staging_dir = unique_test_dir("failure-staging");
	let output_dir = unique_test_dir("failure-output");
	let output_path = output_dir.join("out.mp4");

	let preset = test_preset("staging-failure");
	let cancel = CancelToken::new();
	let on_progress = |_p: Progress| {};
	// 一時ファイル(`format::output(tmp_output_path)`)はエンコーダを開く前に作られるため、
	// 存在しないエンコーダ名を指定すると「一時ファイル作成後・書き込み前」の失敗を
	// タイミング依存なしに再現できる(モジュール冒頭コメント参照)。
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
			name: "facet-test-nonexistent-encoder-xyz",
			options: Dictionary::new(),
		},
		bit_rate: encode::DEFAULT_BITRATE,
		cancel: &cancel,
		on_progress: &on_progress,
		staging_dir: Some(staging_dir.clone()),
	};

	let result = reframe(&input, &output_path, options);

	assert!(
		matches!(result, Err(MediaError::EncoderNotFound { .. })),
		"expected EncoderNotFound, got {result:?}"
	);
	assert!(
		!output_path.exists(),
		"output_path must not exist after a failed reframe"
	);
	assert!(
		dir_is_empty(&staging_dir),
		"staging_dir must not retain the tmp file after a failed reframe"
	);

	let _ = fs::remove_dir_all(&staging_dir);
	let _ = fs::remove_dir_all(&output_dir);
}
