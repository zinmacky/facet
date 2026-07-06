import type { CropRect } from "../types.js";

/** yuv420p は幅・高さが偶数である必要があるため 2 の倍数に丸める。 */
export function toEven(n: number): number {
	return Math.max(2, Math.floor(n / 2) * 2);
}

/**
 * 正規化 CropRect を実ピクセルの crop フィルタに変換する。
 * ソース側の事前クロップ(手動枠)に使う。
 */
export function cropFilter(
	rect: CropRect,
	source: { width: number; height: number },
): string {
	const w = toEven(rect.width * source.width);
	const h = toEven(rect.height * source.height);
	// x/y は偶数丸めしつつフレーム内に収める
	const x = clamp(Math.round(rect.x * source.width), 0, source.width - w);
	const y = clamp(Math.round(rect.y * source.height), 0, source.height - h);
	return `crop=${w}:${h}:${x}:${y}`;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(Math.max(n, lo), hi);
}
