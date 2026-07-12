//! 同時エンコード数の制御(HW エンコーダのセッション枯渇対策)。
//!
//! macOS の VideoToolbox は同時に開けるハードウェアエンコードセッション数が
//! 非常に少なく、多数の書き出しを同時起動すると "Error while opening encoder"
//! (err=-12903) で失敗する。`apps/studio/server/src/services/encode.ts` はこれを
//! 「同時実行数を `MAX_CONCURRENT`(既定 2、env で変更可)に制限するセマフォ」で
//! 防いでいる。
//!
//! **2026-07-12 実測(RX 9070 XT)**: AMF/MF ともハードなセッション上限なし(N=8 まで
//! 成功)、ただし video codec engine は N=2〜4 で飽和しスループットは N=2 で頭打ちの
//! ため既定値 2 を維持する(macOS VideoToolbox のようなハード上限による失敗こそ
//! 起きないが、それ以上並列度を上げてもスループット向上に寄与しない)。
//!
//! ## セマフォ([`EncodeSlots`])
//!
//! - `std::sync::{Mutex, Condvar}` ベースのカウンティングセマフォ。media-core は
//!   同期クレートであり、tokio は導入しない。
//! - 上限は既定 [`DEFAULT_MAX_CONCURRENT_ENCODES`](= 2)。環境変数
//!   [`MAX_CONCURRENT_ENCODES_ENV`] で上書きできる。この env 名は
//!   `apps/studio/server/src/services/encode.ts` の `MAX_CONCURRENT_ENCODES` と
//!   意図的に揃えている(`FACET_` プレフィックスなし)。
//! - [`EncodeSlots::global`] でプロセス全体共有のインスタンスを取得できる
//!   (`OnceLock`)。Tauri コマンドが複数ジョブを並行起動する場合、ジョブ間で
//!   同じ上限を共有するために使う想定。
//!
//! ## リトライ([`retry_on_encoder_open`])
//!
//! `encode.ts` は VideoToolbox 起動失敗時に libx264 へ「フォールバック」するが、
//! Phase 2 の media-core は SW フォールバックを行わない方針
//! (docs/desktop-migration-plan.md §11-2、`encoder_select` モジュール参照)。
//! そのため media-core 側は「フォールバック」ではなく「少し待って同じ候補で
//! 再試行する」待機リトライを提供する(セッション枯渇は他ジョブの完了を待てば
//! 解消することが多いため)。
//!
//! -12903 は VideoToolbox 固有のエラーコードであり、`ffmpeg_next::Error` は
//! HW セッション枯渇と他の open 失敗(パラメータ不正等)を区別する手段を
//! 持たない。そのため判定は [`MediaError::EncoderOpen`] 全般を対象にする
//! 汎用設計とし、リトライ回数は控えめ(既定 3 回・指数バックオフ)にしている。
//! 将来 macOS 側で -12903 相当を判別できるようになった場合は、
//! `retry_on_encoder_open` の判定条件をここで絞り込む形で拡張できる。
//!
//! ## pipeline.rs への推奨配線(統合担当向け。本コミットでは配線しない)
//!
//! `reframe()` の冒頭で以下のようにスロットを取得し、ガードを関数末尾まで
//! スコープに保持する(RAII で `reframe` 終了時に自動解放される)。
//! エンコーダ候補ループ(`encoder_select::select()`)の各 open 呼び出しを
//! `retry_on_encoder_open` でラップし、`MediaError::EncoderOpen` はリトライ後も
//! 次候補へ進む形にする。
//!
//! ```ignore
//! // reframe() 冒頭。関数末尾までドロップしないこと。
//! let _slot = concurrency::EncodeSlots::global().acquire();
//!
//! let retry_config = concurrency::RetryConfig::default();
//! let mut last_err = None;
//! let opened = 'select: {
//!     for choice in encoder_select::select()? {
//!         let result = concurrency::retry_on_encoder_open(
//!             &retry_config,
//!             &|duration| std::thread::sleep(duration),
//!             || {
//!                 encode::open_encoder(&mut octx, EncoderSpec {
//!                     name: choice.name,
//!                     options: choice.to_dictionary(),
//!                     // ... width/height/time_base/frame_rate/bit_rate/global_header
//!                 })
//!             },
//!         );
//!         match result {
//!             Ok(opened) => break 'select Ok(opened),
//!             Err(err @ MediaError::EncoderOpen { .. }) => last_err = Some(err),
//!             Err(err) => break 'select Err(err),
//!         }
//!     }
//!     Err(last_err.unwrap_or(MediaError::NoEncoderCandidate { .. }))
//! }?;
//! ```

use std::env;
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use crate::cancel::CancelToken;
use crate::error::{MediaError, Result};

/// [`EncodeSlots::acquire_cancellable`] がキャンセルを確認する周期。
///
/// `Condvar` はトークン(`AtomicBool`)自体をウェイクの条件にできないため、
/// `wait_timeout` で短時間だけブロックし、タイムアウトのたびに
/// `cancel.is_cancelled()` をポーリングする以外に能動的な方法がない。詰まっている
/// ジョブへの応答性(P1-3 の「スロット待機中キャンセル即応」要件)と、無駄な
/// ウェイクアップによる CPU 消費のバランスを見て 50ms とした。
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 同時エンコード数上限の既定値。
///
/// `apps/studio/server/src/services/encode.ts` の `MAX_CONCURRENT`(既定 2)と揃えて
/// いる。2026-07-12 実測(RX 9070 XT)では Windows の AMF/MF ともハードなセッション
/// 上限は無いが、video codec engine が N=2〜4 で飽和しスループットは N=2 で頭打ちの
/// ため、この値をそのまま採用する(モジュール冒頭コメント参照)。
pub const DEFAULT_MAX_CONCURRENT_ENCODES: usize = 2;

/// 上限を上書きする環境変数名。
///
/// `apps/studio/server/src/services/encode.ts` の `MAX_CONCURRENT_ENCODES` と同名
/// (`FACET_` プレフィックスなし)に意図的に揃えている。
pub const MAX_CONCURRENT_ENCODES_ENV: &str = "MAX_CONCURRENT_ENCODES";

/// 同時エンコード数を制限するカウンティングセマフォ。
///
/// `std::sync::{Mutex, Condvar}` による最小実装(tokio は導入しない。モジュール
/// 冒頭コメント参照)。`acquire`/`try_acquire` が返す [`SlotGuard`] が drop される
/// と自動的にスロットが解放される。
pub struct EncodeSlots {
	max: usize,
	active: Mutex<usize>,
	available: Condvar,
}

impl EncodeSlots {
	/// `max` 個までの同時取得を許可するセマフォを作る。
	///
	/// `max == 0` は 1 に切り上げる(0 のままだと誰も取得できず [`acquire`]
	/// が永久にブロックしてしまうため)。
	///
	/// [`acquire`]: EncodeSlots::acquire
	pub fn new(max: usize) -> Self {
		EncodeSlots {
			max: max.max(1),
			active: Mutex::new(0),
			available: Condvar::new(),
		}
	}

	/// 環境変数 [`MAX_CONCURRENT_ENCODES_ENV`] から上限を読んで構築する。
	///
	/// 未設定・数値としてパース不能・0 以下のいずれの場合も
	/// [`DEFAULT_MAX_CONCURRENT_ENCODES`] にフォールバックする
	/// (`encode.ts` の `Math.max(1, Number(...) || 2)` と同等の意味論)。
	pub fn from_env() -> Self {
		let max = env::var(MAX_CONCURRENT_ENCODES_ENV)
			.ok()
			.and_then(|raw| raw.trim().parse::<usize>().ok())
			.filter(|&max| max > 0)
			.unwrap_or(DEFAULT_MAX_CONCURRENT_ENCODES);
		EncodeSlots::new(max)
	}

	/// プロセス全体で共有するインスタンス。
	///
	/// 初回アクセス時に [`from_env`](EncodeSlots::from_env) で構築される
	/// (`OnceLock`。以降の呼び出しは同じインスタンスを返す)。Tauri コマンドが
	/// 複数ジョブを並行起動する場合、ジョブ間で同じ上限を共有するために使う想定。
	pub fn global() -> &'static EncodeSlots {
		static INSTANCE: OnceLock<EncodeSlots> = OnceLock::new();
		INSTANCE.get_or_init(EncodeSlots::from_env)
	}

	/// このセマフォの上限。
	pub fn max(&self) -> usize {
		self.max
	}

	/// 現在アクティブなスロット数(テスト・診断用)。
	pub fn active_count(&self) -> usize {
		*lock_or_recover(&self.active)
	}

	/// 空きスロットができるまでブロックして 1 つ取得する。
	///
	/// 戻り値の [`SlotGuard`] が drop されると自動的に解放される(RAII)。
	pub fn acquire(&self) -> SlotGuard<'_> {
		let mut active = lock_or_recover(&self.active);
		while *active >= self.max {
			active = wait_or_recover(&self.available, active);
		}
		*active += 1;
		SlotGuard { slots: self }
	}

	/// 空きスロットができるまでブロックして 1 つ取得するが、`cancel` が待機中に
	/// キャンセルされた場合は取得を諦めて `None` を返す(P1-3: スロット待機中の
	/// キャンセル即応)。
	///
	/// [`acquire`](Self::acquire) は無条件にブロックし続けるため、スロットが
	/// 埋まっている間にジョブがキャンセルされても待機が終わるまで検知できない
	/// (=キャンセルの反映がスロット解放まで遅延する)問題があった。本メソッドは
	/// `Condvar::wait_timeout` を [`CANCEL_POLL_INTERVAL`] 周期でポーリングし、
	/// タイムアウトのたびに `cancel.is_cancelled()` を確認することでこれを解消する。
	///
	/// 既存の [`acquire`](Self::acquire) はキャンセル非対応の呼び出し元(テスト等)との
	/// 互換のためそのまま残す。
	pub fn acquire_cancellable(&self, cancel: &CancelToken) -> Option<SlotGuard<'_>> {
		if cancel.is_cancelled() {
			return None;
		}
		let mut active = lock_or_recover(&self.active);
		loop {
			if *active < self.max {
				*active += 1;
				return Some(SlotGuard { slots: self });
			}
			if cancel.is_cancelled() {
				return None;
			}
			active = wait_timeout_or_recover(&self.available, active, CANCEL_POLL_INTERVAL);
		}
	}

	/// ブロックせずに取得を試みる。空きがなければ `None` を返す。
	pub fn try_acquire(&self) -> Option<SlotGuard<'_>> {
		let mut active = lock_or_recover(&self.active);
		if *active >= self.max {
			return None;
		}
		*active += 1;
		Some(SlotGuard { slots: self })
	}

	fn release(&self) {
		let mut active = lock_or_recover(&self.active);
		*active = active.saturating_sub(1);
		drop(active);
		// 待機中スレッドを 1 つ起こす。公平性は保証しない(std::sync::Condvar の仕様通り)。
		self.available.notify_one();
	}
}

/// [`EncodeSlots::acquire`]/[`EncodeSlots::try_acquire`] が返す RAII ガード。
/// drop 時にスロットを解放する。
pub struct SlotGuard<'a> {
	slots: &'a EncodeSlots,
}

impl Drop for SlotGuard<'_> {
	fn drop(&mut self) {
		self.slots.release();
	}
}

/// `Mutex` の poisoning(内部でパニックが起きた状態)を明示的に復旧して中身を取り出す。
///
/// 設計判断: このモジュールがロックを保持している間に行う処理は整数の
/// インクリメント/デクリメントのみで、パニックしうる操作を含まない。そのため
/// poisoning が起きるとすれば呼び出し側([`SlotGuard`] の `Drop` 実行中に外的要因で
/// パニックする等)であり、カウンタ自体の不変条件が壊れる心配はない。よって
/// `unwrap`/`expect` でセマフォごとパニックさせて可用性を落とすより、
/// `into_inner()` で中身を取り出して処理を継続する方を選ぶ。
fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
	mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// [`Condvar::wait`] を poisoning 復旧つきで呼ぶ(理由は [`lock_or_recover`] と同じ)。
fn wait_or_recover<'a, T>(condvar: &Condvar, guard: MutexGuard<'a, T>) -> MutexGuard<'a, T> {
	condvar.wait(guard).unwrap_or_else(PoisonError::into_inner)
}

/// [`Condvar::wait_timeout`] を poisoning 復旧つきで呼ぶ(理由は [`lock_or_recover`] と同じ)。
/// タイムアウトしたかどうかは呼び出し側([`EncodeSlots::acquire_cancellable`])が
/// 毎ループ `cancel.is_cancelled()` を再確認するため、ここでは戻り値のガードのみ返す。
fn wait_timeout_or_recover<'a, T>(
	condvar: &Condvar,
	guard: MutexGuard<'a, T>,
	timeout: Duration,
) -> MutexGuard<'a, T> {
	condvar
		.wait_timeout(guard, timeout)
		.unwrap_or_else(PoisonError::into_inner)
		.0
}

/// [`retry_on_encoder_open`] の挙動を設定する。
#[derive(Debug, Clone, Copy)]
pub struct RetryConfig {
	/// 初回試行が失敗したあとの追加リトライ回数(合計試行回数は `max_retries + 1`)。
	pub max_retries: u32,
	/// 最初のリトライ前に待つ時間。以降は `backoff_multiplier` 倍ずつ伸ばす
	/// (指数バックオフ)。
	pub initial_backoff: Duration,
	/// バックオフの倍率。
	pub backoff_multiplier: u32,
}

impl Default for RetryConfig {
	/// 既定: 追加 3 回・初回待機 200ms・倍率 2(200ms → 400ms → 800ms)。
	///
	/// -12903 相当のセッション枯渇は一時的な状態であり、他ジョブがスロットを
	/// 解放すれば通常は数百 ms〜数秒で成功する想定。`encode.ts` 側は明示的な
	/// リトライを持たず `MAX_CONCURRENT` の制限のみで緩和しているが、media-core は
	/// HW open 失敗の判別粒度が粗い(`MediaError::EncoderOpen` 全般)ため、
	/// リトライ回数を少なめに抑えて安全側に倒している。
	fn default() -> Self {
		RetryConfig {
			max_retries: 3,
			initial_backoff: Duration::from_millis(200),
			backoff_multiplier: 2,
		}
	}
}

/// `attempt` を実行し、[`MediaError::EncoderOpen`] で失敗した場合のみ `config` に
/// 従って待機リトライする(HW エンコーダの一時的なセッション枯渇対策。モジュール
/// 冒頭コメント参照)。それ以外のエラーは即座に伝搬する(リトライしない)。
///
/// `sleep` を引数として受け取ることで実時間の待機をテストから排除できる
/// (単体テストでは呼び出し回数・待機時間だけを記録するダブルを渡す)。実運用では
/// `&|duration| std::thread::sleep(duration)` を渡す想定。
pub fn retry_on_encoder_open<T>(
	config: &RetryConfig,
	sleep: &dyn Fn(Duration),
	mut attempt: impl FnMut() -> Result<T>,
) -> Result<T> {
	let mut backoff = config.initial_backoff;
	let mut retries_done = 0u32;
	loop {
		match attempt() {
			Ok(value) => return Ok(value),
			Err(err @ MediaError::EncoderOpen { .. }) => {
				if retries_done >= config.max_retries {
					return Err(err);
				}
				sleep(backoff);
				backoff = backoff.saturating_mul(config.backoff_multiplier);
				retries_done += 1;
			}
			Err(other) => return Err(other),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::cell::RefCell;
	use std::sync::mpsc;
	use std::sync::Arc;
	use std::thread;

	// MAX_CONCURRENT_ENCODES_ENV は process 全体で共有される状態のため、これを
	// 読み書きするテスト同士が並行実行(cargo test の既定挙動)されると競合する。
	// このロックで直列化する。
	static ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

	fn with_env_lock<R>(f: impl FnOnce() -> R) -> R {
		let _guard = ENV_TEST_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
		f()
	}

	#[test]
	fn third_acquire_blocks_until_a_slot_is_released() {
		let slots = Arc::new(EncodeSlots::new(2));
		let (acquired_tx, acquired_rx) = mpsc::channel::<()>();
		let (release1_tx, release1_rx) = mpsc::channel::<()>();
		let (release2_tx, release2_rx) = mpsc::channel::<()>();

		let holder1 = {
			let slots = Arc::clone(&slots);
			let acquired_tx = acquired_tx.clone();
			thread::spawn(move || {
				let _guard = slots.acquire();
				acquired_tx.send(()).expect("send acquired1");
				release1_rx.recv().expect("recv release1");
			})
		};
		let holder2 = {
			let slots = Arc::clone(&slots);
			thread::spawn(move || {
				let _guard = slots.acquire();
				acquired_tx.send(()).expect("send acquired2");
				release2_rx.recv().expect("recv release2");
			})
		};

		acquired_rx.recv().expect("holder1 acquired");
		acquired_rx.recv().expect("holder2 acquired");
		assert_eq!(slots.active_count(), 2);

		let (third_acquired_tx, third_acquired_rx) = mpsc::channel::<()>();
		let third = {
			let slots = Arc::clone(&slots);
			thread::spawn(move || {
				let _guard = slots.acquire();
				third_acquired_tx.send(()).expect("send third acquired");
			})
		};

		// まだスロットが空いていないので、短時間待っても third は取得できていないはず。
		let still_blocked = third_acquired_rx.recv_timeout(std::time::Duration::from_millis(200));
		assert!(
			still_blocked.is_err(),
			"third acquire should still be blocked"
		);

		// 1 つ解放すると third が取得できるようになる。
		release1_tx.send(()).expect("send release1");
		third_acquired_rx
			.recv_timeout(std::time::Duration::from_secs(5))
			.expect("third should acquire after a slot is released");

		release2_tx.send(()).expect("send release2");
		holder1.join().expect("join holder1");
		holder2.join().expect("join holder2");
		third.join().expect("join third");
	}

	#[test]
	fn guard_releases_slot_on_drop() {
		let slots = EncodeSlots::new(1);
		assert_eq!(slots.active_count(), 0);
		{
			let _guard = slots.acquire();
			assert_eq!(slots.active_count(), 1);
		}
		assert_eq!(slots.active_count(), 0);
	}

	#[test]
	fn acquire_cancellable_returns_none_when_cancelled_while_waiting() {
		let slots = Arc::new(EncodeSlots::new(1));
		// 唯一のスロットを埋めて、後続の acquire_cancellable が待機せざるを得ない状態にする。
		let _held = slots.acquire();

		let cancel = CancelToken::new();
		let cancel_for_waiter = cancel.clone();
		let slots_for_waiter = Arc::clone(&slots);
		let (waited_tx, waited_rx) = mpsc::channel::<bool>();
		let waiter = thread::spawn(move || {
			let result = slots_for_waiter.acquire_cancellable(&cancel_for_waiter);
			waited_tx
				.send(result.is_none())
				.expect("send whether acquire_cancellable returned None");
		});

		// waiter がポーリングループに入るのを軽く待ってからキャンセルする
		// (先にキャンセルしても acquire_cancellable 冒頭のチェックで即 None になるだけで、
		// このテストが検証したい「待機中の」キャンセル反映も別途カバーされる)。
		thread::sleep(Duration::from_millis(120));
		cancel.cancel();

		let returned_none = waited_rx
			.recv_timeout(Duration::from_secs(5))
			.expect("waiter should observe cancellation and return promptly");
		assert!(
			returned_none,
			"acquire_cancellable should return None once cancelled while waiting for a slot"
		);

		waiter.join().expect("join waiter");
		// スロット自体はキャンセルされた待機者に渡らず、依然として _held が保持している。
		assert_eq!(slots.active_count(), 1);
	}

	#[test]
	fn acquire_cancellable_returns_none_immediately_if_already_cancelled() {
		let slots = EncodeSlots::new(1);
		let cancel = CancelToken::new();
		cancel.cancel();

		assert!(slots.acquire_cancellable(&cancel).is_none());
		assert_eq!(slots.active_count(), 0);
	}

	#[test]
	fn acquire_cancellable_succeeds_immediately_when_slot_available() {
		let slots = EncodeSlots::new(1);
		let cancel = CancelToken::new();

		let guard = slots
			.acquire_cancellable(&cancel)
			.expect("slot should be available");
		assert_eq!(slots.active_count(), 1);
		drop(guard);
		assert_eq!(slots.active_count(), 0);
	}

	#[test]
	fn try_acquire_returns_none_when_full_then_some_after_release() {
		let slots = EncodeSlots::new(1);
		let guard = slots
			.try_acquire()
			.expect("first try_acquire should succeed");
		assert!(slots.try_acquire().is_none());
		drop(guard);
		assert!(slots.try_acquire().is_some());
	}

	#[test]
	fn new_clamps_zero_to_one() {
		let slots = EncodeSlots::new(0);
		assert_eq!(slots.max(), 1);
	}

	#[test]
	fn from_env_overrides_default_max() {
		with_env_lock(|| {
			let previous = env::var(MAX_CONCURRENT_ENCODES_ENV).ok();
			env::set_var(MAX_CONCURRENT_ENCODES_ENV, "5");

			assert_eq!(EncodeSlots::from_env().max(), 5);

			restore_env(previous);
		});
	}

	#[test]
	fn from_env_falls_back_to_default_when_unset_or_invalid() {
		with_env_lock(|| {
			let previous = env::var(MAX_CONCURRENT_ENCODES_ENV).ok();

			env::remove_var(MAX_CONCURRENT_ENCODES_ENV);
			assert_eq!(
				EncodeSlots::from_env().max(),
				DEFAULT_MAX_CONCURRENT_ENCODES
			);

			env::set_var(MAX_CONCURRENT_ENCODES_ENV, "not-a-number");
			assert_eq!(
				EncodeSlots::from_env().max(),
				DEFAULT_MAX_CONCURRENT_ENCODES
			);

			env::set_var(MAX_CONCURRENT_ENCODES_ENV, "0");
			assert_eq!(
				EncodeSlots::from_env().max(),
				DEFAULT_MAX_CONCURRENT_ENCODES
			);

			restore_env(previous);
		});
	}

	fn restore_env(previous: Option<String>) {
		match previous {
			Some(value) => env::set_var(MAX_CONCURRENT_ENCODES_ENV, value),
			None => env::remove_var(MAX_CONCURRENT_ENCODES_ENV),
		}
	}

	fn dummy_encoder_open_error() -> MediaError {
		MediaError::EncoderOpen {
			name: "h264_amf".to_string(),
			source: ffmpeg_next::Error::Bug,
		}
	}

	#[test]
	fn retry_on_encoder_open_retries_until_success() {
		let config = RetryConfig {
			max_retries: 3,
			initial_backoff: Duration::from_millis(10),
			backoff_multiplier: 2,
		};
		let sleeps: RefCell<Vec<Duration>> = RefCell::new(Vec::new());
		let sleep = |duration: Duration| sleeps.borrow_mut().push(duration);
		let attempt_count = RefCell::new(0u32);

		let result = retry_on_encoder_open(&config, &sleep, || {
			*attempt_count.borrow_mut() += 1;
			if *attempt_count.borrow() < 3 {
				Err(dummy_encoder_open_error())
			} else {
				Ok(42)
			}
		});

		assert_eq!(result.expect("should eventually succeed"), 42);
		assert_eq!(*attempt_count.borrow(), 3);
		assert_eq!(
			sleeps.borrow().as_slice(),
			&[Duration::from_millis(10), Duration::from_millis(20)]
		);
	}

	#[test]
	fn retry_on_encoder_open_stops_after_max_retries_exhausted() {
		let config = RetryConfig {
			max_retries: 2,
			initial_backoff: Duration::from_millis(5),
			backoff_multiplier: 3,
		};
		let sleeps: RefCell<Vec<Duration>> = RefCell::new(Vec::new());
		let sleep = |duration: Duration| sleeps.borrow_mut().push(duration);
		let attempt_count = RefCell::new(0u32);

		let result: Result<()> = retry_on_encoder_open(&config, &sleep, || {
			*attempt_count.borrow_mut() += 1;
			Err(dummy_encoder_open_error())
		});

		assert!(matches!(result, Err(MediaError::EncoderOpen { .. })));
		assert_eq!(*attempt_count.borrow(), 3); // 初回 + リトライ2回
		assert_eq!(
			sleeps.borrow().as_slice(),
			&[Duration::from_millis(5), Duration::from_millis(15)]
		);
	}

	#[test]
	fn retry_on_encoder_open_does_not_retry_other_errors() {
		let config = RetryConfig::default();
		let sleeps: RefCell<Vec<Duration>> = RefCell::new(Vec::new());
		let sleep = |duration: Duration| sleeps.borrow_mut().push(duration);
		let attempt_count = RefCell::new(0u32);

		let result: Result<()> = retry_on_encoder_open(&config, &sleep, || {
			*attempt_count.borrow_mut() += 1;
			Err(MediaError::EncoderNotFound {
				name: "h264_amf".to_string(),
			})
		});

		assert!(matches!(result, Err(MediaError::EncoderNotFound { .. })));
		assert_eq!(*attempt_count.borrow(), 1);
		assert!(sleeps.borrow().is_empty());
	}
}
