//! P1-3(スロット待機中キャンセル即応)・P1-2(同一 output_path 競合)を、実際の
//! `media_core::reframe()` 経由で検証する統合テスト。
//!
//! `EncodeSlots::global()` / 本 crate 内の出力先レジストリ(`pipeline::reframe` 冒頭)は
//! いずれもプロセス全体で共有される `OnceLock` のため、`concurrency_reframe.rs` と同様
//! 「同一プロセス内の複数スレッドから本物の `reframe()` を同時に呼ぶ」形でしか実効的に
//! 検証できない(別プロセスの `cargo run --example reframe` を 2 回起動しても、それぞれが
//! 独立した `OnceLock` を持つため競合しない)。
//!
//! 実 ffmpeg・実 GPU 環境が必要なため `#[ignore]`。リポジトリにコミットされた小さな
//! fixture(`apps/desktop/src-tauri/tests/fixtures/input_test.mp4`)を使うため、追加の
//! 環境変数は不要:
//!
//! ```text
//! cargo test -p media-core --test cancellation_and_output_busy_reframe -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use media_core::concurrency::EncodeSlots;
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

#[test]
#[ignore = "実 ffmpeg / 実 GPU 環境が必要。手動実行する(P1-2/P1-3 の実機検証)"]
fn slot_wait_cancellation_and_output_path_collision_via_real_reframe() {
	let input = fixture_input();
	assert!(
		input.exists(),
		"fixture not found at {} (see apps/desktop/src-tauri/tests/fixtures/README.md)",
		input.display()
	);
	let out_dir = std::env::temp_dir();

	// --- P1-3: スロット待機中のキャンセル即応 -------------------------------------
	//
	// `EncodeSlots::global()` は初回アクセス時に env を読んで確定する(`OnceLock`)。
	// このプロセス内での最初のアクセスがここになるよう、モジュール冒頭で他のテストを
	// 定義していない(1 ファイル 1 テストにしている理由)。上限を 1 に固定して、
	// 2 本目が確実にスロット待ちに入るようにする。
	std::env::set_var("MAX_CONCURRENT_ENCODES", "1");
	assert_eq!(
		EncodeSlots::global().max(),
		1,
		"MAX_CONCURRENT_ENCODES=1 が反映されていること"
	);

	let holder_output = out_dir.join("media_core_cancel_test_holder.mp4");
	let holder_cancel = CancelToken::new();
	let holder_started = Arc::new(AtomicBool::new(false));
	let holder_started_writer = Arc::clone(&holder_started);
	let holder_input = input.clone();
	let holder_output_for_thread = holder_output.clone();
	let holder = thread::spawn(move || {
		let preset = test_preset("cancel-holder");
		let on_progress = move |_p: Progress| {
			holder_started_writer.store(true, Ordering::SeqCst);
		};
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
			cancel: &holder_cancel,
			on_progress: &on_progress,
			staging_dir: None,
		};
		reframe(&holder_input, &holder_output_for_thread, options)
	});

	// holder がスロットを確保して実際にエンコードを始めるまで待つ
	// (`active_count() == 1` で確認)。
	let wait_until = Instant::now() + Duration::from_secs(10);
	while EncodeSlots::global().active_count() == 0 && Instant::now() < wait_until {
		thread::sleep(Duration::from_millis(10));
	}
	assert_eq!(
		EncodeSlots::global().active_count(),
		1,
		"holder should have acquired the single slot"
	);

	// 2 本目: スロットが埋まっているため acquire_cancellable の待機ループに入るはず。
	// 待機開始後すぐに cancel() を呼び、待ち続けずに Cancelled で即座に返ることを確認する。
	let waiter_output = out_dir.join("media_core_cancel_test_waiter.mp4");
	let waiter_cancel = CancelToken::new();
	let waiter_cancel_for_thread = waiter_cancel.clone();
	let waiter_input = input.clone();
	let waiter_output_for_thread = waiter_output.clone();
	let started_at = Instant::now();
	let waiter = thread::spawn(move || {
		let preset = test_preset("cancel-waiter");
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
			cancel: &waiter_cancel_for_thread,
			on_progress: &on_progress,
			staging_dir: None,
		};
		reframe(&waiter_input, &waiter_output_for_thread, options)
	});

	// waiter がスロット待ちのポーリングループに入るのを軽く待ってからキャンセルする。
	thread::sleep(Duration::from_millis(150));
	waiter_cancel.cancel();

	let waiter_result = waiter.join().expect("waiter thread should not panic");
	let cancel_observed_after = started_at.elapsed();
	assert!(
		matches!(waiter_result, Err(MediaError::Cancelled)),
		"waiter should be cancelled while waiting for a slot, got: {waiter_result:?}"
	);
	// P1-3 導入前は holder の完了(数百ms〜数秒)を待たないとキャンセルが反映されな
	// かった。ここでは holder がまだ走っている短時間で cancel が返ることを確認する
	// (holder の完了を待つよりも十分速いことのゆるい上限として 5 秒とした)。
	assert!(
		cancel_observed_after < Duration::from_secs(5),
		"cancellation while waiting for a slot should be prompt, took {cancel_observed_after:?}"
	);
	assert!(
		!waiter_output.exists(),
		"cancelled job must not leave an output file"
	);

	let holder_result = holder.join().expect("holder thread should not panic");
	let _ = std::fs::remove_file(&holder_output);
	let _ = std::fs::remove_file(&waiter_output);
	assert!(
		holder_result.is_ok(),
		"holder should complete normally, got: {holder_result:?}"
	);

	// --- P1-2: 同一 output_path への同時実行競合 -----------------------------------
	//
	// 上のブロックでスロット上限は 1 のままなので、2 本目は「スロット待ち」と
	// 「output busy」のどちらでも失敗しうる。ここでは output busy を確実に観測する
	// ため、まず 1 本目に長めのスロット保持をさせず、先に output_path だけ予約させる
	// のではなく、1 本目のスレッドが `reframe()` に入ってから(=レジストリへ登録済み)
	// 2 本目を始める形にする。
	let shared_output = out_dir.join("media_core_output_busy_test_shared.mp4");
	let _ = std::fs::remove_file(&shared_output);

	let first_cancel = CancelToken::new();
	let first_started = Arc::new(AtomicBool::new(false));
	let first_started_writer = Arc::clone(&first_started);
	let first_input = input.clone();
	let first_output = shared_output.clone();
	let first = thread::spawn(move || {
		let preset = test_preset("output-busy-first");
		let on_progress = move |_p: Progress| {
			first_started_writer.store(true, Ordering::SeqCst);
		};
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
			cancel: &first_cancel,
			on_progress: &on_progress,
			staging_dir: None,
		};
		reframe(&first_input, &first_output, options)
	});

	// 1 本目がスロットを取得しエンコードを始めるまで待つ(= output_path も登録済みのはず)。
	let wait_until = Instant::now() + Duration::from_secs(10);
	while !first_started.load(Ordering::SeqCst) && Instant::now() < wait_until {
		thread::sleep(Duration::from_millis(10));
	}
	assert!(
		first_started.load(Ordering::SeqCst),
		"first job should have started"
	);

	// 2 本目: 同じ output_path。スロット空き有無に関わらず、output busy の
	// レジストリチェックは reframe() 冒頭(スロット取得と同程度に早い段階)で
	// 行われるため、EncoderOpen 等のエラーではなく明確に OutputBusy になることを期待する。
	let second_cancel = CancelToken::new();
	let on_progress = |_p: Progress| {};
	let options = ReframeOptions {
		preset: &test_preset("output-busy-second"),
		sigma: fit::DEFAULT_SIGMA,
		crop: None,
		source: SourceDimensions {
			width: 0,
			height: 0,
		},
		trim: None,
		encoder: EncoderSelection::Auto,
		bit_rate: encode::DEFAULT_BITRATE,
		cancel: &second_cancel,
		on_progress: &on_progress,
		staging_dir: None,
	};
	let second_result = reframe(&input, &shared_output, options);
	assert!(
		matches!(second_result, Err(MediaError::OutputBusy { .. })),
		"second reframe to the same output_path should fail with OutputBusy, got: {second_result:?}"
	);

	let first_result = first.join().expect("first thread should not panic");
	let _ = std::fs::remove_file(&shared_output);
	assert!(
		first_result.is_ok(),
		"first job should complete normally, got: {first_result:?}"
	);

	// 1 本目完了後は同じ output_path へ再度書き出せる(レジストリが解放されている)。
	let third_cancel = CancelToken::new();
	let on_progress = |_p: Progress| {};
	let options = ReframeOptions {
		preset: &test_preset("output-busy-after-release"),
		sigma: fit::DEFAULT_SIGMA,
		crop: None,
		source: SourceDimensions {
			width: 0,
			height: 0,
		},
		trim: None,
		encoder: EncoderSelection::Auto,
		bit_rate: encode::DEFAULT_BITRATE,
		cancel: &third_cancel,
		on_progress: &on_progress,
		staging_dir: None,
	};
	let third_result = reframe(&input, &shared_output, options);
	let _ = std::fs::remove_file(&shared_output);
	assert!(
		third_result.is_ok(),
		"re-running after the first job released the path should succeed, got: {third_result:?}"
	);
}
