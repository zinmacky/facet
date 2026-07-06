import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** probe が返す正規化済みメディア情報。 */
export interface ProbeResult {
	/** 尺(秒)。 */
	duration: number;
	/** 映像の幅(ピクセル)。 */
	width: number;
	/** 映像の高さ(ピクセル)。 */
	height: number;
	/** サンプルアスペクト比(例 "1:1")。不明なら "1:1"。 */
	sar: string;
	/** 表示アスペクト比(例 "16:9")。無ければ width:height から計算。 */
	dar: string;
	/** フレームレート(fps)。r_frame_rate を評価した値。 */
	fps: number;
	/** 音声ストリームの有無。 */
	hasAudio: boolean;
	/** 映像コーデック名(例 "h264")。 */
	codec: string;
}

/** ffprobe JSON の必要部分だけを表す最小型。 */
interface FfprobeStream {
	codec_type?: string;
	codec_name?: string;
	width?: number;
	height?: number;
	sample_aspect_ratio?: string;
	display_aspect_ratio?: string;
	r_frame_rate?: string;
	duration?: string;
}

interface FfprobeFormat {
	duration?: string;
}

interface FfprobeOutput {
	streams?: FfprobeStream[];
	format?: FfprobeFormat;
}

/** "30000/1001" や "30/1" 形式の分数文字列を fps に評価する。0 除算・不正時は 0。 */
function parseFrameRate(value: string | undefined): number {
	if (!value) return 0;
	const parts = value.split("/");
	const num = Number(parts[0]);
	const den = parts.length > 1 ? Number(parts[1]) : 1;
	if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
	return num / den;
}

/** 2 数の最大公約数(dar 計算用)。 */
function gcd(a: number, b: number): number {
	let x = Math.abs(Math.trunc(a));
	let y = Math.abs(Math.trunc(b));
	while (y !== 0) {
		[x, y] = [y, x % y];
	}
	return x;
}

/** width/height から表示アスペクト比文字列("16:9"形式)を導く。 */
function computeDar(width: number, height: number): string {
	if (width <= 0 || height <= 0) return "1:1";
	const g = gcd(width, height) || 1;
	return `${width / g}:${height / g}`;
}

/**
 * ffprobe を実行して入力メディアを解析する。
 * ffprobe が無い/失敗した場合や映像ストリームが無い場合は明確なエラーを投げる。
 */
export async function probe(inputPath: string): Promise<ProbeResult> {
	let stdout: string;
	try {
		const result = await execFileAsync("ffprobe", [
			"-v",
			"error",
			"-print_format",
			"json",
			"-show_streams",
			"-show_format",
			inputPath,
		]);
		stdout = result.stdout;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`ffprobe の実行に失敗しました (${inputPath}): ${message}`);
	}

	let parsed: FfprobeOutput;
	try {
		parsed = JSON.parse(stdout) as FfprobeOutput;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`ffprobe 出力の JSON パースに失敗しました: ${message}`);
	}

	const streams = parsed.streams ?? [];
	const video = streams.find((s) => s.codec_type === "video");
	if (!video) {
		throw new Error(`映像ストリームが見つかりません (${inputPath})`);
	}
	const hasAudio = streams.some((s) => s.codec_type === "audio");

	const width = video.width ?? 0;
	const height = video.height ?? 0;
	if (width <= 0 || height <= 0) {
		throw new Error(`映像の寸法を取得できません (${inputPath})`);
	}

	const codec = video.codec_name ?? "unknown";
	const fps = parseFrameRate(video.r_frame_rate);
	const sar = video.sample_aspect_ratio ?? "1:1";
	const dar = video.display_aspect_ratio ?? computeDar(width, height);

	// 尺は format を優先し、無ければ video ストリームの duration を使う。
	const durationStr = parsed.format?.duration ?? video.duration;
	const duration = durationStr !== undefined ? Number(durationStr) : NaN;

	return {
		duration: Number.isFinite(duration) ? duration : 0,
		width,
		height,
		sar,
		dar,
		fps,
		hasAudio,
		codec,
	};
}
