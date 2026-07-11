//! イン/アウト点(trim)の秒 → タイムスタンプ変換・フレーム分類・出力尺見積り。
//!
//! TS 版(`packages/core/src/filtergraph/trim.ts`)の `trimArgs` は ffmpeg CLI の
//! シーク引数(`-ss`/`-t`)を組み立てる。ここでの移植方針は次の通り:
//!
//! - `-ss <start>` は**入力オプション**として置かれる(`buildFfmpegArgs` 参照)ため、
//!   demuxer レベルの高速シーク + ffmpeg CLI 既定の "accurate seek"(キーフレームから
//!   目標時刻までのフレームを捨てる)が働く。media-core では demuxer シーク自体は
//!   pipeline.rs 側の責務だが、"目標時刻までのフレームを捨てる" 判定はここで提供する
//!   ([`TrimWindow::classify`])。
//! - `-t <end-start>` は**出力オプション**(`-i` の後・他の出力オプションより前)として
//!   置かれるため、「`-ss` で移動した地点からの相対尺」として解釈される。TS 側は
//!   `dur = Math.max(0, trim.end - trim.start)` が 0 以下なら `-t` 自体を渡さない
//!   (=尺無制限、EOF まで処理)。この「0 以下なら無制限」という意味論を
//!   [`TrimWindow`] / [`trim_range`] の両方で厳密に再現する。
//! - **出力タイムスタンプの再基準化**: ffmpeg CLI は `buildFfmpegArgs` に `-copyts` を
//!   一切渡していない。`-copyts` 無しの既定挙動は、入力コンテキストの
//!   `start_time`(`-ss` でシークした地点)を基準に出力タイムスタンプを 0 付近へ
//!   シフトする。つまり **trim 後の最初のフレームは出力上 pts=0 として扱われる**。
//!   [`TrimWindow::rebase`] はこれを明示的に再現する
//!   (`pts_out = pts_in - start_ts`)。trim なし(`start == 0`)の場合は `start_ts == 0`
//!   となり恒等変換になるため、ffmpeg CLI が `-ss` 無指定時にシフトしない挙動とも一致する。
//!
//! 統合ガイド(pipeline.rs 側、Wave 2 では未接続 — `ReframeOptions.trim` 参照):
//!
//! 1. `open_input` 直後に `TrimWindow::new(trim, trim::AV_TIME_BASE)` で得た
//!    `start_ts()` を `input.seek(start_ts, ..)` に渡し、demuxer をシークする
//!    (`start_ts == 0` ならシーク自体を省略してよい)。
//! 2. デコードループ内では別途 `TrimWindow::new(trim, ist_time_base)`(ストリームの
//!    タイムベース)を構築し、`decoded.timestamp()` を [`TrimWindow::classify`] へ渡す。
//!    `Skip` ならフィルタ/エンコーダへ送らず次のフレームへ、`Stop` ならデコードループを
//!    抜けて flush 処理(スパイク同様の 3 段 flush)へ進む、`Keep` ならフィルタ/エンコーダへ
//!    渡す直前に `decoded.set_pts(window.rebase(pts))` でタイムスタンプを再基準化する
//!    (`-copyts` 無し挙動の再現、上記参照)。
//! 3. 進捗の `total_frames` は、probe 済みの総尺(秒)と `effective_duration_secs` を
//!    使って `estimate_total_frames(effective_duration_secs(trim, source_duration_secs),
//!    decoder.frame_rate())` を `pipeline::Progress` の `total_frames` に渡す形にする。

use ffmpeg_next::Rational;

use crate::spec::Trim;

/// `format::context::Input::seek` が要求するタイムベース(`avformat_seek_file` の
/// `stream_index = -1` 呼び出しは常に `AV_TIME_BASE`(マイクロ秒)単位を期待する)。
/// デコード対象ストリームのタイムベースとは別物であることに注意
/// (統合ガイド 1. 参照)。
pub const AV_TIME_BASE: Rational = Rational(1, 1_000_000);

/// 秒を指定タイムベースの整数タイムスタンプへ変換する。
///
/// 四捨五入(タイは 0 から遠い方へ、`f64::round` の挙動)する。ミリ秒精度で十分な
/// TS 版(`fmt()` が `toFixed(3)`)と異なり、こちらは任意の分解能のタイムベースに
/// 対応する必要があるため、丸めは最終ステップの整数化のみで行う。
///
/// 負の秒・不正なタイムベース(分母が 0 以下)は 0 にクランプする(呼び出し側で
/// panic させないための防御。実運用のストリームタイムベースは常に正の分母を持つ)。
pub fn seconds_to_timestamp(seconds: f64, time_base: Rational) -> i64 {
	let seconds = seconds.max(0.0);
	let num = f64::from(time_base.numerator());
	let den = f64::from(time_base.denominator());
	if num <= 0.0 || den <= 0.0 {
		return 0;
	}
	(seconds * den / num).round() as i64
}

/// 指定タイムベースの整数タイムスタンプを秒へ変換する(`seconds_to_timestamp` の逆)。
pub fn timestamp_to_seconds(ts: i64, time_base: Rational) -> f64 {
	let num = f64::from(time_base.numerator());
	let den = f64::from(time_base.denominator());
	if num <= 0.0 || den <= 0.0 {
		return 0.0;
	}
	ts as f64 * num / den
}

/// `trim` から「開始秒(0 以上にクランプ済み)」と「尺(秒、0 以下なら無制限 = `None`)」を
/// 導出する共通ロジック。[`trim_range`] と [`TrimWindow::new`] の両方から使う
/// (定義がずれると TS 版との同値性が壊れるため一箇所に集約する)。
fn effective_start_and_duration(trim: Option<&Trim>) -> (f64, Option<f64>) {
	match trim {
		None => (0.0, None),
		Some(t) => {
			let start = t.start.max(0.0);
			let dur = (t.end - start).max(0.0);
			(start, if dur > 0.0 { Some(dur) } else { None })
		}
	}
}

/// TS 版 `trimArgs` の値レベル版。文字列の CLI 引数ではなく、決定済みの秒数を返す
/// (ffmpeg CLI 対応: `seek_seconds` が `Some` なら `-ss <seek_seconds>` 相当、
/// `duration_seconds` が `Some` なら `-t <duration_seconds>` 相当)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrimRange {
	/// `None` は「シーク不要(先頭から)」。TS 版が `start <= 0` で `seekArgs` を
	/// 空にするのと同じ判断。
	pub seek_seconds: Option<f64>,
	/// `None` は「尺無制限(EOF まで)」。TS 版が `dur <= 0` で `durationArgs` を
	/// 空にするのと同じ判断。
	pub duration_seconds: Option<f64>,
}

/// `Trim` を [`TrimRange`] へ変換する(TS 版 `trimArgs` と同値)。`trim` が `None`
/// なら両方 `None`(TS 版が `trim` 未指定で `{ seekArgs: [], durationArgs: [] }` を
/// 返すのと同じ)。
pub fn trim_range(trim: Option<&Trim>) -> TrimRange {
	let (start, duration_seconds) = effective_start_and_duration(trim);
	TrimRange {
		seek_seconds: if start > 0.0 { Some(start) } else { None },
		duration_seconds,
	}
}

/// デコード済みフレームの pts が trim 範囲に対してどこに位置するかの判定結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrimDecision {
	/// まだ start に達していない: このフレームは破棄し、デコードを継続する
	/// (ffmpeg CLI の "accurate seek" 既定挙動 — キーフレームから目標時刻までの
	/// フレームを捨てる — に相当)。
	Skip,
	/// trim 範囲内: 通常どおりフィルタ/エンコーダへ処理を進める。
	Keep,
	/// end に到達または超過した: デコードループを打ち切り、flush 処理へ進んでよい。
	/// `duration_seconds` が `None`(尺無制限)の場合はこの判定は発生しない
	/// (EOF まで常に `Keep`)。
	Stop,
}

/// trim(秒)をあるタイムベース上のタイムスタンプへ事前変換し、デコードループから
/// フレーム単位で問い合わせられるようにしたもの。
///
/// **タイムベースは呼び出し側の用途に応じて使い分ける**(統合ガイド参照):
/// - demuxer シーク用の絶対タイムスタンプが欲しい場合は `time_base = trim::AV_TIME_BASE`。
/// - デコードループ内でフレーム pts(ストリームのタイムベース)を分類・再基準化する
///   場合は `time_base = ist_time_base`(`decode::DecodeContext::time_base`)。
#[derive(Debug, Clone, Copy)]
pub struct TrimWindow {
	start_ts: i64,
	end_ts: Option<i64>,
}

impl TrimWindow {
	/// `trim` が `None` の場合は「常に `Keep`・再基準化は恒等変換」の no-op window。
	pub fn new(trim: Option<&Trim>, time_base: Rational) -> Self {
		let (start, duration_seconds) = effective_start_and_duration(trim);
		let start_ts = seconds_to_timestamp(start, time_base);
		let end_ts = duration_seconds.map(|dur| start_ts + seconds_to_timestamp(dur, time_base));
		TrimWindow { start_ts, end_ts }
	}

	/// trim 開始点のタイムスタンプ(構築時に渡したタイムベース単位)。
	/// demuxer シークの目標値、または `rebase` の基準値として使う。
	pub fn start_ts(&self) -> i64 {
		self.start_ts
	}

	/// trim 終了点のタイムスタンプ(尺無制限なら `None`)。
	pub fn end_ts(&self) -> Option<i64> {
		self.end_ts
	}

	/// デコード済みフレームの pts(構築時と同じタイムベース単位)を分類する。
	pub fn classify(&self, pts: i64) -> TrimDecision {
		if pts < self.start_ts {
			TrimDecision::Skip
		} else if self.end_ts.is_some_and(|end_ts| pts >= end_ts) {
			TrimDecision::Stop
		} else {
			TrimDecision::Keep
		}
	}

	/// 出力側のタイムスタンプ再基準化: `start_ts` を 0 に合わせる
	/// (モジュール冒頭の設計判断コメント参照 — ffmpeg CLI の `-copyts` 無し既定挙動と
	/// 同じにするため)。`Keep` と判定された pts に対してのみ呼ぶ契約
	/// (`Skip` 判定の pts に対して呼ぶ意味はない)。理論上 `pts < start_ts` の入力が
	/// 来ても負値を muxer へ渡さないよう 0 にクランプする。
	pub fn rebase(&self, pts: i64) -> i64 {
		(pts - self.start_ts).max(0)
	}
}

/// trim 適用後の実効尺(秒)を見積もる。`source_duration_secs` はコンテナ申告の
/// 総尺(probe 等から得る想定、Wave 2 の `probe.rs` 参照)。
///
/// `trim.end` がソース尺を超える場合はソース尺でクランプする(ffmpeg CLI の `-t` が
/// ストリーム終端で自然に打ち切られるのと同じ挙動 — "end が尺超過" のケース)。
/// `trim` が `None` なら `source_duration_secs` をそのまま返す。
pub fn effective_duration_secs(trim: Option<&Trim>, source_duration_secs: f64) -> f64 {
	let source_duration_secs = source_duration_secs.max(0.0);
	let (start, duration_seconds) = effective_start_and_duration(trim);
	let start = start.min(source_duration_secs);
	let remaining = (source_duration_secs - start).max(0.0);
	match duration_seconds {
		Some(dur) => dur.min(remaining),
		None => remaining,
	}
}

/// 実効尺(秒)とフレームレートから、trim 適用後の総フレーム数を見積もる
/// (`pipeline::Progress.total_frames` に渡す想定。四捨五入)。
/// フレームレートが不正(分子・分母が 0 以下)、または尺が 0 以下の場合は `None`
/// (見積り不能)を返す。
pub fn estimate_total_frames(duration_secs: f64, frame_rate: Rational) -> Option<u64> {
	if frame_rate.numerator() <= 0 || frame_rate.denominator() <= 0 || duration_secs <= 0.0 {
		return None;
	}
	let fps = f64::from(frame_rate.numerator()) / f64::from(frame_rate.denominator());
	Some((duration_secs * fps).round() as u64)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn trim(start: f64, end: f64) -> Trim {
		Trim { start, end }
	}

	// --- seconds_to_timestamp / timestamp_to_seconds ---------------------------------

	#[test]
	fn seconds_to_timestamp_rounds_to_nearest() {
		// 1/1000(ミリ秒)タイムベース。1.5s -> 1500, 端数は四捨五入。
		let tb = Rational(1, 1000);
		assert_eq!(seconds_to_timestamp(1.5, tb), 1500);
		assert_eq!(seconds_to_timestamp(0.0, tb), 0);
		// 0.0005s -> 0.5ms は 0 から遠い方(1)へ丸める。
		assert_eq!(seconds_to_timestamp(0.0005, tb), 1);
		// 30fps 相当のフレームタイムベース(1/30000)でも整合すること。
		let frame_tb = Rational(1, 30000);
		assert_eq!(seconds_to_timestamp(1.0, frame_tb), 30000);
	}

	#[test]
	fn seconds_to_timestamp_clamps_negative_seconds() {
		let tb = Rational(1, 1000);
		assert_eq!(seconds_to_timestamp(-5.0, tb), 0);
	}

	#[test]
	fn timestamp_to_seconds_round_trips() {
		let tb = Rational(1, 1000);
		assert_eq!(timestamp_to_seconds(1500, tb), 1.5);
	}

	// --- trim_range (TS 版 trimArgs との同値性) ---------------------------------------

	#[test]
	fn trim_range_none_is_unbounded() {
		let range = trim_range(None);
		assert_eq!(range.seek_seconds, None);
		assert_eq!(range.duration_seconds, None);
	}

	#[test]
	fn trim_range_start_zero_has_no_seek() {
		// TS: trim.ts `start > 0 ? [...] : []`。start=0 は seekArgs 無し。
		let t = trim(0.0, 5.0);
		let range = trim_range(Some(&t));
		assert_eq!(range.seek_seconds, None);
		assert_eq!(range.duration_seconds, Some(5.0));
	}

	#[test]
	fn trim_range_start_and_end() {
		// TS 版 spec.rs の round_trip_full_spec と同じ値(start=1.5, end=9.0)。
		let t = trim(1.5, 9.0);
		let range = trim_range(Some(&t));
		assert_eq!(range.seek_seconds, Some(1.5));
		assert_eq!(range.duration_seconds, Some(7.5));
	}

	#[test]
	fn trim_range_end_not_after_start_is_unbounded_duration() {
		// TS: dur = Math.max(0, end - start) が 0 なら durationArgs は空(= 無制限)。
		let t = trim(2.0, 2.0);
		let range = trim_range(Some(&t));
		assert_eq!(range.seek_seconds, Some(2.0));
		assert_eq!(range.duration_seconds, None);

		let t2 = trim(3.0, 1.0);
		let range2 = trim_range(Some(&t2));
		assert_eq!(range2.seek_seconds, Some(3.0));
		assert_eq!(range2.duration_seconds, None);
	}

	#[test]
	fn trim_range_negative_start_is_clamped() {
		// TS: start = Math.max(0, trim.start)。
		let t = trim(-2.0, 3.0);
		let range = trim_range(Some(&t));
		assert_eq!(range.seek_seconds, None);
		assert_eq!(range.duration_seconds, Some(3.0));
	}

	// --- TrimWindow::classify / rebase -------------------------------------------------

	#[test]
	fn trim_window_none_keeps_everything_and_identity_rebase() {
		let tb = Rational(1, 1000);
		let window = TrimWindow::new(None, tb);
		assert_eq!(window.start_ts(), 0);
		assert_eq!(window.end_ts(), None);
		assert_eq!(window.classify(0), TrimDecision::Keep);
		assert_eq!(window.classify(1_000_000), TrimDecision::Keep);
		assert_eq!(window.rebase(1234), 1234);
	}

	#[test]
	fn trim_window_start_only_never_stops() {
		// end <= start: 無制限(Stop が発生しない)。
		let t = trim(1.0, 1.0);
		let tb = Rational(1, 1000);
		let window = TrimWindow::new(Some(&t), tb);
		assert_eq!(window.start_ts(), 1000);
		assert_eq!(window.end_ts(), None);
		assert_eq!(window.classify(500), TrimDecision::Skip);
		assert_eq!(window.classify(1000), TrimDecision::Keep);
		assert_eq!(window.classify(1_000_000_000), TrimDecision::Keep);
	}

	#[test]
	fn trim_window_start_and_end_classifies_three_regions() {
		let t = trim(1.0, 3.0);
		let tb = Rational(1, 1000);
		let window = TrimWindow::new(Some(&t), tb);
		assert_eq!(window.start_ts(), 1000);
		assert_eq!(window.end_ts(), Some(3000));

		assert_eq!(window.classify(0), TrimDecision::Skip);
		assert_eq!(window.classify(999), TrimDecision::Skip);
		assert_eq!(window.classify(1000), TrimDecision::Keep);
		assert_eq!(window.classify(2999), TrimDecision::Keep);
		assert_eq!(window.classify(3000), TrimDecision::Stop);
		assert_eq!(window.classify(10_000), TrimDecision::Stop);

		// 出力再基準化: start_ts を 0 に合わせる。
		assert_eq!(window.rebase(1000), 0);
		assert_eq!(window.rebase(1500), 500);
		assert_eq!(window.rebase(2999), 1999);
	}

	#[test]
	fn trim_window_start_zero_is_identity_rebase() {
		// start=0 は ffmpeg CLI が -ss を渡さないケースに対応し、シフトが起きない。
		let t = trim(0.0, 5.0);
		let tb = Rational(1, 1000);
		let window = TrimWindow::new(Some(&t), tb);
		assert_eq!(window.start_ts(), 0);
		assert_eq!(window.rebase(2500), 2500);
		assert_eq!(window.classify(2500), TrimDecision::Keep);
		assert_eq!(window.classify(5000), TrimDecision::Stop);
	}

	#[test]
	fn trim_window_rebase_clamps_below_start_to_zero() {
		let t = trim(2.0, 5.0);
		let tb = Rational(1, 1000);
		let window = TrimWindow::new(Some(&t), tb);
		// 契約上 Skip 判定の pts に rebase を呼ぶことは想定しないが、防御的に 0 未満には
		// ならないことを確認する。
		assert_eq!(window.rebase(500), 0);
	}

	// --- effective_duration_secs / estimate_total_frames --------------------------------

	#[test]
	fn effective_duration_secs_no_trim_uses_source_duration() {
		assert_eq!(effective_duration_secs(None, 12.5), 12.5);
	}

	#[test]
	fn effective_duration_secs_clamps_end_beyond_source_duration() {
		// end が尺超過: ソース尺でクランプする。
		let t = trim(2.0, 100.0);
		assert_eq!(effective_duration_secs(Some(&t), 10.0), 8.0);
	}

	#[test]
	fn effective_duration_secs_start_beyond_source_duration_is_zero() {
		let t = trim(20.0, 30.0);
		assert_eq!(effective_duration_secs(Some(&t), 10.0), 0.0);
	}

	#[test]
	fn effective_duration_secs_unbounded_end_uses_remaining_source_duration() {
		// end <= start(無制限)の場合、start から尺終端までを見積もる。
		let t = trim(4.0, 1.0);
		assert_eq!(effective_duration_secs(Some(&t), 10.0), 6.0);
	}

	#[test]
	fn estimate_total_frames_rounds_to_nearest() {
		let fps_30 = Rational(30, 1);
		assert_eq!(estimate_total_frames(2.0, fps_30), Some(60));
		// 29.97fps(NTSC)相当。8.0s * 30000/1001 = 239.76... -> 240 に丸め。
		let fps_ntsc = Rational(30000, 1001);
		assert_eq!(estimate_total_frames(8.0, fps_ntsc), Some(240));
	}

	#[test]
	fn estimate_total_frames_invalid_inputs_return_none() {
		let fps_30 = Rational(30, 1);
		assert_eq!(estimate_total_frames(0.0, fps_30), None);
		assert_eq!(estimate_total_frames(-1.0, fps_30), None);
		assert_eq!(estimate_total_frames(5.0, Rational(0, 1)), None);
		assert_eq!(estimate_total_frames(5.0, Rational(30, 0)), None);
	}
}
