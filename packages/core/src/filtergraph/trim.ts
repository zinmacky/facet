import type { Trim } from "../types.js";

/**
 * イン/アウト点を ffmpeg のシーク引数に変換する。
 * -ss を入力より前に置くと高速なキーフレームシークになる。
 * -to は「-ss 起点からの相対尺」として扱うため end-start を渡す。
 */
export function trimArgs(trim: Trim | undefined): {
	seekArgs: string[];
	durationArgs: string[];
} {
	if (!trim) return { seekArgs: [], durationArgs: [] };
	const start = Math.max(0, trim.start);
	const dur = Math.max(0, trim.end - start);
	const seekArgs = start > 0 ? ["-ss", fmt(start)] : [];
	const durationArgs = dur > 0 ? ["-t", fmt(dur)] : [];
	return { seekArgs, durationArgs };
}

function fmt(seconds: number): string {
	// ミリ秒精度で十分。指数表記を避ける。
	return seconds.toFixed(3);
}
