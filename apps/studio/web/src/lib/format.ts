/** 秒を mm:ss.cs 表記にする(タイムライン/再生位置表示用)。 */
export function formatTime(seconds: number): string {
	const s = Math.max(0, seconds);
	const m = Math.floor(s / 60);
	const rest = s - m * 60;
	const whole = Math.floor(rest);
	const cs = Math.floor((rest - whole) * 100);
	return `${m}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** 値を [min, max] に丸める。 */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
