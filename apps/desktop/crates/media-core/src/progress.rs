//! パイプラインの進捗集計とスロットリング通知。
//!
//! `Progress` はもともと `pipeline.rs` にあったフレーム数ベースの最小構造体
//! (Wave 1)を本モジュールへ移し、旧 `packages/ffmpeg-runner/src/runner.ts`
//! (削除済み)の `Progress`(`-progress` パース結果)相当のフィールドへ拡張したもの。
//! Tauri イベントとして UI(desktop の renderer)へそのまま JSON 化して渡す前提のため
//! `Serialize` を実装し、フィールド名は runner.ts の JSON 形(camelCase)に合わせている。
//!
//! フィールド対応(runner.ts `Progress` → 本モジュール):
//! - `frame` → `frame`(そのまま)
//! - `fps` → `fps`(そのまま。処理速度 = フレーム/実時間秒)
//! - `speed` → `speed`(そのまま。実時間比。1.0 = 等速、runner.ts は ffmpeg の
//!   `speed=1.23x` を数値化したもの、本モジュールは
//!   `frame_pts_secs / 実経過秒` で同義の値を自前計算する)
//! - `outTimeMs`(runner.ts) → `out_time_secs`(本モジュール。単位のみ秒に変更。
//!   libav の pts は秒単位に変換する方が自然なため ms ではなく秒を採用)
//! - `percent` → `percent`(0.0..=100.0、見積り不能なら `None`。runner.ts は
//!   `totalDurationMs` 既知の場合のみ設定する optional フィールドだが、本モジュールは
//!   `total_frames` 既知時のみ設定する点は Wave 1 から変更なし)
//! - `total_frames` は runner.ts に対応物なし(libav 側でコンテナが総フレーム数を
//!   申告する場合のみ得られる Rust 側固有のフィールド。Wave 1 から継続)

use std::time::{Duration, Instant};

use serde::Serialize;

/// パイプライン進捗。Tauri イベントとして UI へそのまま渡せるよう `Serialize` を実装する
/// (フィールド対応はモジュール冒頭コメント参照)。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
	/// これまでにエンコーダへ送出したフレーム数。
	pub frame: u64,
	/// コンテナ申告値等から見積もった総フレーム数(不明なら `None`)。
	pub total_frames: Option<u64>,
	/// 0.0〜100.0(見積り不能なら `None`)。
	pub percent: Option<f64>,
	/// 出力済みの尺(秒)。フィルタ後フレームの pts をタイムベースで秒へ変換した値。
	pub out_time_secs: f64,
	/// 処理速度(フレーム/実経過秒)。
	pub fps: f64,
	/// 実時間比(1.0 = 等速)。`out_time_secs` の増分 / 実経過秒。
	pub speed: f64,
}

/// [`ProgressTracker::update`] を呼ぶたびに毎回コールバックを発火すると
/// (デコード/エンコードは 1 秒間に数十〜数百フレーム処理しうるため)通知が過剰になる。
/// この間隔(ミリ秒)以上経過した場合のみ実際に発火する。
pub const DEFAULT_THROTTLE_INTERVAL: Duration = Duration::from_millis(200);

/// フレームループから `Progress` を算出し、[`DEFAULT_THROTTLE_INTERVAL`] でスロットリング
/// して `on_progress` コールバックへ通知する薄いラッパ。
///
/// 時刻取得は型パラメータ `F: Fn() -> Instant` として注入可能にしてあり、
/// テストでは `Cell<Instant>` 等を使った擬似クロックを渡せる
/// (本番は [`ProgressTracker::new`] が `Instant::now` を使う)。
pub struct ProgressTracker<'a, F = fn() -> Instant>
where
	F: Fn() -> Instant,
{
	start: Instant,
	last_notified: Option<Instant>,
	throttle: Duration,
	total_frames: Option<u64>,
	now_fn: F,
	on_progress: &'a dyn Fn(Progress),
}

impl<'a> ProgressTracker<'a, fn() -> Instant> {
	/// 実時計(`Instant::now`)・既定スロットリング間隔([`DEFAULT_THROTTLE_INTERVAL`])で
	/// トラッカーを構築する。
	pub fn new(total_frames: Option<u64>, on_progress: &'a dyn Fn(Progress)) -> Self {
		Self::with_clock(
			total_frames,
			DEFAULT_THROTTLE_INTERVAL,
			Instant::now,
			on_progress,
		)
	}
}

impl<'a, F: Fn() -> Instant> ProgressTracker<'a, F> {
	/// 時刻取得関数とスロットリング間隔を注入できるコンストラクタ(主にテスト用)。
	pub fn with_clock(
		total_frames: Option<u64>,
		throttle: Duration,
		now_fn: F,
		on_progress: &'a dyn Fn(Progress),
	) -> Self {
		let start = now_fn();
		ProgressTracker {
			start,
			last_notified: None,
			throttle,
			total_frames,
			now_fn,
			on_progress,
		}
	}

	/// フレーム送出のたびに呼ぶ。前回通知から `throttle` 未満しか経過していない場合は
	/// 計算のみ行いコールバックは発火しない。
	///
	/// `frame_pts_secs` はここまでにエンコーダへ送出したフレームの pts を秒に変換した値
	/// (= `Progress.out_time_secs` になる値)。
	pub fn update(&mut self, frame: u64, frame_pts_secs: f64) {
		self.notify(frame, frame_pts_secs, false);
	}

	/// パイプライン完了時に 1 回だけ呼ぶ。スロットリング間隔に関わらず必ずコールバックを
	/// 発火する(直前の `update` が間引かれていても、最終進捗を UI が確実に受け取れるように
	/// するため)。
	pub fn finish(&mut self, frame: u64, frame_pts_secs: f64) {
		self.notify(frame, frame_pts_secs, true);
	}

	fn notify(&mut self, frame: u64, frame_pts_secs: f64, finished: bool) {
		let now = (self.now_fn)();
		let should_notify = finished
			|| match self.last_notified {
				None => true,
				Some(last) => now.duration_since(last) >= self.throttle,
			};
		if !should_notify {
			return;
		}
		self.last_notified = Some(now);

		let elapsed_secs = now.duration_since(self.start).as_secs_f64();
		let fps = if elapsed_secs > 0.0 {
			frame as f64 / elapsed_secs
		} else {
			0.0
		};
		let speed = if elapsed_secs > 0.0 {
			frame_pts_secs / elapsed_secs
		} else {
			0.0
		};
		let percent = self
			.total_frames
			.filter(|&total| total > 0)
			.map(|total| (frame as f64 / total as f64 * 100.0).min(100.0));

		(self.on_progress)(Progress {
			frame,
			total_frames: self.total_frames,
			percent,
			out_time_secs: frame_pts_secs,
			fps,
			speed,
		});
	}
}

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::*;

	/// `Cell<Instant>` を経由した擬似クロック。テストごとに時刻を明示的に進める。
	struct FakeClock {
		now: Cell<Instant>,
	}

	impl FakeClock {
		fn new(start: Instant) -> Self {
			FakeClock {
				now: Cell::new(start),
			}
		}

		fn advance(&self, duration: Duration) {
			self.now.set(self.now.get() + duration);
		}

		fn get(&self) -> Instant {
			self.now.get()
		}
	}

	#[test]
	fn percent_and_fps_and_speed_are_calculated_from_clock() {
		let clock = FakeClock::new(Instant::now());
		let events: Cell<Vec<Progress>> = Cell::new(Vec::new());
		let on_progress = |p: Progress| {
			let mut v = events.take();
			v.push(p);
			events.set(v);
		};
		let mut tracker = ProgressTracker::with_clock(
			Some(100),
			DEFAULT_THROTTLE_INTERVAL,
			|| clock.get(),
			&on_progress,
		);

		// 2 秒経過時点でフレーム 10、出力済み尺 4.0 秒 →
		// fps = 10 / 2 = 5.0、speed = 4.0 / 2 = 2.0(2 倍速相当)、percent = 10.0。
		clock.advance(Duration::from_secs(2));
		tracker.update(10, 4.0);

		let v = events.take();
		assert_eq!(v.len(), 1);
		let p = v[0];
		assert_eq!(p.frame, 10);
		assert_eq!(p.total_frames, Some(100));
		assert_eq!(p.percent, Some(10.0));
		assert_eq!(p.out_time_secs, 4.0);
		assert_eq!(p.fps, 5.0);
		assert_eq!(p.speed, 2.0);
	}

	#[test]
	fn percent_is_none_when_total_frames_unknown() {
		let clock = FakeClock::new(Instant::now());
		let events: Cell<Vec<Progress>> = Cell::new(Vec::new());
		let on_progress = |p: Progress| {
			let mut v = events.take();
			v.push(p);
			events.set(v);
		};
		let mut tracker = ProgressTracker::with_clock(
			None,
			DEFAULT_THROTTLE_INTERVAL,
			|| clock.get(),
			&on_progress,
		);

		clock.advance(Duration::from_secs(1));
		tracker.update(5, 1.0);

		let v = events.take();
		assert_eq!(v.len(), 1);
		assert_eq!(v[0].percent, None);
		assert_eq!(v[0].total_frames, None);
	}

	#[test]
	fn throttles_updates_within_interval() {
		let clock = FakeClock::new(Instant::now());
		let events: Cell<Vec<Progress>> = Cell::new(Vec::new());
		let on_progress = |p: Progress| {
			let mut v = events.take();
			v.push(p);
			events.set(v);
		};
		let mut tracker = ProgressTracker::with_clock(
			Some(100),
			DEFAULT_THROTTLE_INTERVAL,
			|| clock.get(),
			&on_progress,
		);

		// 1 回目: 常に発火する(初回)。
		tracker.update(1, 0.1);
		assert_eq!(events.take().len(), 1);

		// 199ms 後: 200ms 未満なので発火しない。
		clock.advance(Duration::from_millis(199));
		tracker.update(2, 0.2);
		assert_eq!(events.take().len(), 0);

		// さらに進めて累計 200ms 以上経過: 発火する。
		clock.advance(Duration::from_millis(1));
		tracker.update(3, 0.3);
		let v = events.take();
		assert_eq!(v.len(), 1);
		assert_eq!(v[0].frame, 3);
	}

	#[test]
	fn finish_always_notifies_even_within_throttle_interval() {
		let clock = FakeClock::new(Instant::now());
		let events: Cell<Vec<Progress>> = Cell::new(Vec::new());
		let on_progress = |p: Progress| {
			let mut v = events.take();
			v.push(p);
			events.set(v);
		};
		let mut tracker = ProgressTracker::with_clock(
			Some(10),
			DEFAULT_THROTTLE_INTERVAL,
			|| clock.get(),
			&on_progress,
		);

		tracker.update(1, 0.1);
		assert_eq!(events.take().len(), 1);

		// 50ms しか経っていない(スロットリング区間内)が、finish は必ず発火する。
		clock.advance(Duration::from_millis(50));
		tracker.finish(10, 1.0);
		let v = events.take();
		assert_eq!(v.len(), 1);
		assert_eq!(v[0].frame, 10);
		assert_eq!(v[0].percent, Some(100.0));
	}

	#[test]
	fn new_uses_real_clock_without_panicking() {
		let on_progress = |_: Progress| {};
		let mut tracker = ProgressTracker::new(Some(1), &on_progress);
		tracker.update(1, 1.0);
		tracker.finish(1, 1.0);
	}
}
