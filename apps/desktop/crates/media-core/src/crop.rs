//! 事前クロップ(手動枠)のフィルタ文字列生成。
//!
//! TS 版(`packages/core/src/filtergraph/crop.ts`)の `cropFilter`/`toEven`/`clamp` の
//! 移植。正規化 [`CropRect`](crate::spec::CropRect)(0..1)を実ピクセルの `crop=` フィルタに
//! 変換する。生成した文字列は [`crate::fit::FilterGraphSpec::pre_crop`] にそのまま渡せる。
//!
//! ## TS からの意図的な差分(型で不正状態を防ぐ)
//! TS 版は `number` を素通しするため、`crop` 矩形がソースより大きい/オフセットが負など
//! 契約外の入力(`CropRect` は本来 0..1 に正規化されている前提)を与えると、
//! `x`/`y` に負値が出力されうる(`crop=w:h:-5:0` のような無効な ffmpeg フィルタになる)。
//! media-core では `x`/`y`/`w`/`h` の戻り値型を `u32` にし、そのような負の中間値は
//! `0` へ飽和させる(Rust の float→int キャストは Rust 1.45 以降 saturating であり
//! `unwrap`/`expect`/panic を経由しない)。契約内の入力(0..1 正規化)では TS 版と
//! 出力文字列が完全一致する(下のユニットテスト参照)。

use crate::spec::{CropRect, SourceDimensions};

/// yuv420p は幅・高さが偶数である必要があるため 2 の倍数に丸める。
///
/// TS 版 `toEven`(`Math.max(2, Math.floor(n / 2) * 2)`)の移植。
/// 非有限値(NaN/Infinity。通常は JSON デシリアライズの時点で弾かれるため到達しない想定)は
/// `0` として扱い、最終的に最小値 `2` へ丸める(panic しない)。
pub fn to_even(n: f64) -> u32 {
	let n = if n.is_finite() { n } else { 0.0 };
	let evened = (n / 2.0).floor() * 2.0;
	// f64 → u32 の `as` キャストは saturating(範囲外は 0 または u32::MAX に飽和)なので
	// evened が負になっても panic せず 0 側に飽和する。その後 max(2.0) で下限を保証する。
	evened.max(2.0) as u32
}

/// `n` を `[lo, hi]` にクランプする。TS 版 `clamp`(`Math.min(Math.max(n, lo), hi)`)の移植。
///
/// `hi < lo` の場合(契約外の入力で crop 矩形がソースより大きい等)は TS 版と同じく
/// `hi` を返す(`max` を先に適用してから `min` するため)。
pub fn clamp(n: f64, lo: f64, hi: f64) -> f64 {
	n.max(lo).min(hi)
}

/// TS 版 `Math.round` 相当(四捨五入。半分は +Infinity 方向へ丸める)。
/// Rust の `f64::round` は「0 から遠い方向」へ丸めるため負数境界で JS と流儀が異なり、
/// そのままでは使えない(`clamp` で下限 0 にまとめられる現実装では観測されないが、
/// 意味論を JS に厳密に合わせるためこちらを使う)。
fn round_half_up(n: f64) -> f64 {
	if !n.is_finite() {
		return 0.0;
	}
	(n + 0.5).floor()
}

/// 正規化 [`CropRect`](crate::spec::CropRect) を実ピクセルの `crop` フィルタに変換する。
/// ソース側の事前クロップ(手動枠)に使う。TS 版 `cropFilter` の移植。
///
/// `rect` の値が契約(0..1 正規化)を満たす限り、TS 版と出力文字列が完全一致する。
pub fn crop_filter(rect: CropRect, source: SourceDimensions) -> String {
	let sw = source.width as f64;
	let sh = source.height as f64;

	let w = to_even(rect.width * sw);
	let h = to_even(rect.height * sh);
	// x/y は偶数丸めしつつフレーム内に収める。
	let x = clamp(round_half_up(rect.x * sw), 0.0, sw - w as f64) as u32;
	let y = clamp(round_half_up(rect.y * sh), 0.0, sh - h as f64) as u32;

	format!("crop={w}:{h}:{x}:{y}")
}

#[cfg(test)]
mod tests {
	use super::*;

	fn source(width: u32, height: u32) -> SourceDimensions {
		SourceDimensions { width, height }
	}

	fn rect(x: f64, y: f64, width: f64, height: f64) -> CropRect {
		CropRect {
			x,
			y,
			width,
			height,
		}
	}

	// TS 版 compose.test.ts の `describe("toEven", ...)` と同一の入出力。
	#[test]
	fn to_even_matches_ts_test_cases() {
		assert_eq!(to_even(961.0), 960);
		assert_eq!(to_even(1.0), 2);
		assert_eq!(to_even(0.0), 2);
	}

	#[test]
	fn to_even_keeps_already_even_values() {
		assert_eq!(to_even(1920.0), 1920);
		assert_eq!(to_even(2.0), 2);
	}

	#[test]
	fn clamp_passes_through_in_range_value() {
		assert_eq!(clamp(5.0, 0.0, 10.0), 5.0);
	}

	#[test]
	fn clamp_clamps_below_lo_and_above_hi() {
		assert_eq!(clamp(-5.0, 0.0, 10.0), 0.0);
		assert_eq!(clamp(50.0, 0.0, 10.0), 10.0);
	}

	// TS 版 compose.test.ts: "事前クロップ指定で [pre] ノードが前段に入る" が使う
	// cropFilter の入出力そのもの(0.5 * 1920 = 960(偶数), 1 * 1080 = 1080,
	// x = 0.25 * 1920 = 480)。fit.rs の `pre_crop_inserts_pre_node_matching_ts_compose_test`
	// が期待する文字列 "crop=960:1080:480:0" と一致する。
	#[test]
	fn crop_filter_matches_ts_compose_test_case() {
		let result = crop_filter(rect(0.25, 0.0, 0.5, 1.0), source(1920, 1080));
		assert_eq!(result, "crop=960:1080:480:0");
	}

	// フル画面クロップ(矩形全体を指定): x/y は 0、w/h はソースそのまま(偶数なので丸めなし)。
	#[test]
	fn crop_filter_full_frame() {
		let result = crop_filter(rect(0.0, 0.0, 1.0, 1.0), source(1920, 1080));
		assert_eq!(result, "crop=1920:1080:0:0");
	}

	// 奇数寸法のソースに対するフル画面クロップ: w/h は toEven で 1 減る(切り下げ)。
	// x/y は残り 1px の範囲内でクランプされ 0 のまま。
	#[test]
	fn crop_filter_full_frame_odd_source_rounds_down_to_even() {
		let result = crop_filter(rect(0.0, 0.0, 1.0, 1.0), source(1279, 719));
		assert_eq!(result, "crop=1278:718:0:0");
	}

	// 範囲外オフセット: 矩形がフレーム右下へはみ出す場合、x/y はフレーム内に収まるよう
	// クランプされる(TS 版 cropFilter の x/y クランプ仕様どおり)。
	#[test]
	fn crop_filter_clamps_offset_within_frame() {
		// w = toEven(0.5*1920=960) = 960, h = toEven(0.5*1080=540) = 540
		// x_raw = round(0.9*1920=1728) → clamp(.., 0, 1920-960=960) = 960
		// y_raw = round(0.9*1080=972)  → clamp(.., 0, 1080-540=540) = 540
		let result = crop_filter(rect(0.9, 0.9, 0.5, 0.5), source(1920, 1080));
		assert_eq!(result, "crop=960:540:960:540");
	}

	// 0 サイズの crop 矩形: toEven の下限保証により最小 2x2 になる。
	#[test]
	fn crop_filter_zero_size_rect_clamps_to_minimum_two() {
		// w = toEven(0) = 2, h = toEven(0) = 2
		// x = round(0.5*1920=960) → clamp(.., 0, 1920-2=1918) = 960
		// y = round(0.5*1080=540) → clamp(.., 0, 1080-2=1078) = 540
		let result = crop_filter(rect(0.5, 0.5, 0.0, 0.0), source(1920, 1080));
		assert_eq!(result, "crop=2:2:960:540");
	}

	// 契約外(負のオフセット)入力: TS 版なら Math.round → clamp で 0 未満にはならない
	// (clamp の下限が 0 のため)。media-core も同じく 0 にクランプされる。
	#[test]
	fn crop_filter_negative_offset_clamps_to_zero() {
		let result = crop_filter(rect(-0.1, -0.2, 0.5, 0.5), source(1920, 1080));
		assert_eq!(result, "crop=960:540:0:0");
	}

	// 契約外(矩形がソースより大きい)入力: hi(= sw - w) が負になり得るケース。
	// TS 版はここで負の x/y を数値として出力しうるが、media-core は戻り値型を
	// `u32` にしているため saturating キャストで 0 に飽和する(モジュール冒頭コメント参照)。
	#[test]
	fn crop_filter_oversized_rect_saturates_offset_to_zero_instead_of_negative() {
		let result = crop_filter(rect(0.0, 0.0, 1.5, 1.5), source(1920, 1080));
		// w = toEven(1.5*1920=2880) = 2880, h = toEven(1.5*1080=1620) = 1620
		// hi_x = 1920 - 2880 = -960 → clamp(round(0),0,-960) = -960 → saturate to 0
		assert_eq!(result, "crop=2880:1620:0:0");
	}
}
