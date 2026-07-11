//! セマフォ(`concurrency::EncodeSlots`)を実際の `media_core::reframe()` 経由で検証する
//! 統合テスト。
//!
//! `concurrency.rs` のユニットテストはセマフォ自体(取得/解放/リトライ)のロジックのみを
//! ダミーで検証するため、ここでは同一プロセス内の複数スレッドから本物の `reframe()` を
//! 同時に呼び出し、`EncodeSlots::global().active_count()` が既定上限(2、env で上書きされて
//! いなければ)を一度も超えないこと、かつ 3 本とも正常完走することを確認する
//! (`EncodeSlots` はプロセス全体で共有される `OnceLock` のため、複数プロセスを起動する
//! 方式では検証できない — `concurrency.rs` モジュール冒頭コメント参照)。
//!
//! 実 ffmpeg・実 GPU 環境が必要なため `#[ignore]`。実行するには音声・映像付きの入力
//! ファイルの絶対パスを環境変数 `MEDIA_CORE_CONCURRENCY_TEST_INPUT` に設定した上で:
//!
//! ```text
//! cargo test -p media-core --test concurrency_reframe -- --ignored --nocapture
//! ```

use std::env;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use media_core::concurrency::EncodeSlots;
use media_core::spec::{FitMode, Preset, SourceDimensions, Trim};
use media_core::{encode, fit, reframe, CancelToken, EncoderSelection, Progress, ReframeOptions};

#[test]
#[ignore = "実 ffmpeg / 実 GPU 環境が必要。MEDIA_CORE_CONCURRENCY_TEST_INPUT に入力パスを設定して手動実行する"]
fn three_concurrent_reframes_are_capped_at_configured_limit_and_all_complete() {
	let input = match env::var("MEDIA_CORE_CONCURRENCY_TEST_INPUT") {
		Ok(path) => PathBuf::from(path),
		Err(_) => {
			eprintln!("skip: MEDIA_CORE_CONCURRENCY_TEST_INPUT が未設定のためスキップします");
			return;
		}
	};
	let out_dir = env::temp_dir();

	// `EncodeSlots::global()` は初回アクセス時に env(`MAX_CONCURRENT_ENCODES`)を読んで
	// 構築される(`OnceLock`)。ここで一度触れて上限を確定させ、以降の
	// `active_count()` 監視・アサーションで同じ値を使う。
	let configured_max = EncodeSlots::global().max();

	let max_observed = Arc::new(AtomicUsize::new(0));
	let stop = Arc::new(AtomicBool::new(false));

	// 監視スレッド: ワーカースレッドが reframe() を実行している間、
	// active_count() を定期的にサンプリングして観測された最大値を記録する。
	let monitor_max = Arc::clone(&max_observed);
	let monitor_stop = Arc::clone(&stop);
	let monitor = thread::spawn(move || {
		while !monitor_stop.load(Ordering::SeqCst) {
			let active = EncodeSlots::global().active_count();
			monitor_max.fetch_max(active, Ordering::SeqCst);
			thread::sleep(Duration::from_millis(5));
		}
	});

	let results = Arc::new(Mutex::new(Vec::new()));
	let handles: Vec<_> = (0..3)
		.map(|i| {
			let input = input.clone();
			let output = out_dir.join(format!("media_core_concurrency_test_{i}.mp4"));
			let results = Arc::clone(&results);
			thread::spawn(move || {
				let preset = Preset {
					name: "concurrency-test".to_string(),
					width: 1080,
					height: 1920,
					fit: FitMode::BlurPad,
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
					// 短い区間に trim してテストを高速に保つ。
					trim: Some(Trim {
						start: 0.0,
						end: 1.0,
					}),
					encoder: EncoderSelection::Auto,
					bit_rate: encode::DEFAULT_BITRATE,
					cancel: &cancel,
					on_progress: &on_progress,
				};
				let result = reframe(&input, &output, options);
				let _ = std::fs::remove_file(&output);
				results
					.lock()
					.unwrap_or_else(|poisoned| poisoned.into_inner())
					.push(result.map_err(|err| err.to_string()));
			})
		})
		.collect();

	for handle in handles {
		handle.join().expect("worker thread should not panic");
	}
	stop.store(true, Ordering::SeqCst);
	monitor.join().expect("monitor thread should not panic");

	let results = results
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner());
	assert_eq!(results.len(), 3, "expected exactly 3 worker results");
	for result in results.iter() {
		assert!(
			result.is_ok(),
			"all three reframe() calls should succeed, got: {results:?}"
		);
	}

	let max = max_observed.load(Ordering::SeqCst);
	assert!(
		max <= configured_max,
		"observed active_count ({max}) exceeded configured max ({configured_max})"
	);
	assert!(
		max >= 1,
		"monitor should have observed at least one active encode slot"
	);
}
