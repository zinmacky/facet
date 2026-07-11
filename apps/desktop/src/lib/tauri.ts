import type { EditSpec } from "@facet/core";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * `apps/desktop/src-tauri/src/commands/{probe,reframe,preview}.rs` の invoke 境界に
 * 薄く対応する renderer 側モジュール。型・イベント名は各 Rust ファイル冒頭の
 * 「renderer 向け API」doc コメントに合わせている。
 *
 * studio(ブラウザ + HTTP、`lib/api.ts`)と desktop(Tauri、本モジュール)は
 * 別アプリとして共存し、desktop の features/ からは本モジュールのみを使う。
 */

export { convertFileSrc };

// ---- probe -------------------------------------------------------------

/**
 * `media_core::probe::MediaInfo` と同形(camelCase)。studio の `ProbeResult` と異なり
 * `url` を持たない(desktop に HTTP 配信は無いため、再生には `convertFileSrc` を使う)。
 */
export interface MediaInfo {
	/** 秒。 */
	duration: number;
	width: number;
	height: number;
	/** 例 "1:1"。 */
	sar: string;
	/** 例 "16:9"。 */
	dar: string;
	fps: number;
	hasAudio: boolean;
	/** 例 "h264"。 */
	codec: string;
}

/** `path` を probe して `MediaInfo` を得る。失敗時は reject する。 */
export function probeFile(path: string): Promise<MediaInfo> {
	return invoke<MediaInfo>("probe", { path });
}

// ---- ファイル選択(ネイティブダイアログ) ------------------------------

export interface PickResult {
	path?: string;
	canceled?: boolean;
}

/** 動画ファイルを 1 つ選ぶ。 */
export async function pickVideoFile(): Promise<PickResult> {
	const selected = await open({
		multiple: false,
		directory: false,
		title: "元動画を選択",
		filters: [
			{
				name: "動画",
				extensions: ["mp4", "mov", "m4v", "webm", "mkv", "avi"],
			},
		],
	});
	if (!selected || Array.isArray(selected)) return { canceled: true };
	return { path: selected };
}

/** 書き出し先フォルダを 1 つ選ぶ。キャンセル時は `null`。 */
export async function pickExportDirectory(
	title = "書き出し先フォルダを選択",
): Promise<string | null> {
	const selected = await open({
		multiple: false,
		directory: true,
		title,
	});
	if (!selected || Array.isArray(selected)) return null;
	return selected;
}

// ---- 進捗(reframe / preview 共通) --------------------------------------

/** `media_core::progress::Progress` と同形(camelCase)。 */
export interface Progress {
	frame: number;
	totalFrames: number | null;
	/** 0.0〜100.0。見積り不能なら `null`。 */
	percent: number | null;
	outTimeSecs: number;
	fps: number;
	speed: number;
}

/** ジョブ ID(`reframe_start`/`preview_start` の戻り値)。 */
export type JobId = string;

/** `reframe_cancel` を呼ぶ(`preview_start` が返した jobId にも使える。§commands/preview.rs 冒頭コメント)。 */
export function cancelJob(jobId: JobId): Promise<void> {
	return invoke<void>("reframe_cancel", { jobId });
}

// ---- reframe(実書き出し) ------------------------------------------------

export interface ReframeHandlers {
	onProgress?: (progress: Progress) => void;
	onDone?: (encoder: string) => void;
	onError?: (message: string) => void;
}

export interface JobHandle {
	jobId: JobId;
	/** 購読を解除する(コンポーネントの unmount/再実行時に呼ぶ)。 */
	unsubscribe: () => void;
	/** このジョブをキャンセルする(`reframe_cancel` のラッパ)。 */
	cancel: () => Promise<void>;
}

/**
 * `input` を `spec` の指定形状へ再フレーミングして `output`(絶対パス)へ書き出す。
 * `output` の親ディレクトリは呼び出し側が事前に存在させておく必要がある
 * (`media_core::reframe` は出力ディレクトリを作成しない)。
 */
export async function startReframe(
	input: string,
	output: string,
	spec: EditSpec,
	handlers: ReframeHandlers,
): Promise<JobHandle> {
	const jobId = await invoke<JobId>("reframe_start", { input, output, spec });
	const unlisteners: UnlistenFn[] = await Promise.all([
		listen<Progress>(`reframe://progress/${jobId}`, (event) => {
			handlers.onProgress?.(event.payload);
		}),
		listen<{ encoder: string }>(`reframe://done/${jobId}`, (event) => {
			handlers.onDone?.(event.payload.encoder);
		}),
		listen<{ message: string }>(`reframe://error/${jobId}`, (event) => {
			handlers.onError?.(event.payload.message);
		}),
	]);
	return {
		jobId,
		unsubscribe: () => {
			for (const unlisten of unlisteners) unlisten();
		},
		cancel: () => cancelJob(jobId),
	};
}

// ---- preview(低ビットレート・キャッシュ付き仮エンコード) -----------------

export interface PreviewHandlers {
	onProgress?: (progress: Progress) => void;
	/** 生成(またはキャッシュヒット)したプレビューファイルの絶対パス。 */
	onDone?: (path: string) => void;
	onError?: (message: string) => void;
}

/**
 * `input` を `spec` の指定形状へ低ビットレートでプレビュー生成する
 * (`reframe_start` と同じジョブ ID 空間。キャンセルは `cancelJob` を使う)。
 * done イベントの絶対パスは `convertFileSrc` を通してから `<video>` の `src` に使う。
 */
export async function startPreview(
	input: string,
	spec: EditSpec,
	handlers: PreviewHandlers,
): Promise<JobHandle> {
	const jobId = await invoke<JobId>("preview_start", { input, spec });
	const unlisteners: UnlistenFn[] = await Promise.all([
		listen<Progress>(`preview://progress/${jobId}`, (event) => {
			handlers.onProgress?.(event.payload);
		}),
		listen<{ path: string }>(`preview://done/${jobId}`, (event) => {
			handlers.onDone?.(event.payload.path);
		}),
		listen<{ message: string }>(`preview://error/${jobId}`, (event) => {
			handlers.onError?.(event.payload.message);
		}),
	]);
	return {
		jobId,
		unsubscribe: () => {
			for (const unlisten of unlisteners) unlisten();
		},
		cancel: () => cancelJob(jobId),
	};
}

// ---- ユーティリティ --------------------------------------------------------

/** Windows で無効な文字を含むファイル名を安全な形へ置換する(clip.name は自由入力のため)。 */
export function sanitizeFileName(name: string): string {
	const cleaned = name.replace(/[<>:"/\\|?*]/g, "_").trim();
	return cleaned.length > 0 ? cleaned : "clip";
}
