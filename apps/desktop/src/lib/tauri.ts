import type { EditSpec } from "@facet/core";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { documentDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { newJobId } from "./jobId";
import type { EncoderPreference } from "./settings";

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

/**
 * 書き出し先フォルダを 1 つ選ぶ。キャンセル時は `null`。
 *
 * `preferredDefaultPath`(前回選択したフォルダ等、呼び出し側の永続化値)があれば
 * ダイアログの初期表示先として渡す。無ければ書類フォルダ(`documentDir()`、
 * macOS/Windows どちらも「書類」相当に解決される)を試み、取得に失敗した場合は
 * `defaultPath` を渡さない(OS 既定 = 現状挙動)。
 *
 * `defaultPath` が指す先が既に存在しない場合の扱いは Tauri v2 dialog プラグインの
 * 型定義コメントに準拠する: ディレクトリでなくなっていれば「親フォルダを開いた状態」に
 * 自動でフォールバックする(親フォルダも無い等の極端なケースはネイティブダイアログ
 * 側の実装に委ねる)。フロントエンド側で事前に存在確認はしない。
 */
export async function pickExportDirectory(
	title = "書き出し先フォルダを選択",
	preferredDefaultPath?: string | null,
): Promise<string | null> {
	// `||` で空文字列も「未指定」扱いにする(壊れた/手編集の永続化値が "" の場合、
	// `??` だと documentDir() へのフォールバックが起きず defaultPath 無しに
	// 落ちてしまう — ExportScreen.tsx の `if (preset)` と同じ truthy 判定に揃える)。
	const defaultPath =
		preferredDefaultPath || (await resolveDefaultExportDialogPath());
	const selected = await open({
		multiple: false,
		directory: true,
		title,
		...(defaultPath ? { defaultPath } : {}),
	});
	if (!selected || Array.isArray(selected)) return null;
	return selected;
}

/** `documentDir()` の取得に失敗したら `undefined`(defaultPath 無し)にフォールバックする。 */
async function resolveDefaultExportDialogPath(): Promise<string | undefined> {
	try {
		return await documentDir();
	} catch {
		return undefined;
	}
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

/** ジョブ ID(renderer 側で採番し `reframe_start`/`preview_start` の引数として渡す。`lib/jobId.ts` 参照)。 */
export type JobId = string;

/** `reframe_cancel` を呼ぶ(`preview_start` が返した jobId にも使える。§commands/preview.rs 冒頭コメント)。 */
export function cancelJob(jobId: JobId): Promise<void> {
	return invoke<void>("reframe_cancel", { jobId });
}

/**
 * 複数の `listen()` 登録を並行に行い、1つでも reject したら、既に登録済みの
 * listener をすべて `unlisten()` してから(`factories` の配列順で最初に reject した
 * ものの)エラーで reject し直す。
 *
 * `Promise.all([listen(...), listen(...), ...])` をそのまま使うと、途中の1つが
 * reject した時点で全体が reject するものの、既に resolve 済みだった listen() の
 * unlisten 関数は誰も呼ばない ── 購読が Tauri 側に残ったままリークする
 * (`subscribeReframeEvents`/`startPreview` の双方に同型のバグがあった)。
 * `factories` は呼び出し時点(`.map` 実行時)ですべて同期的に起動するため、並行登録
 * という既存の挙動(listen-before-invoke を素早く終える)は変えない。
 */
async function listenAll(
	factories: Array<() => Promise<UnlistenFn>>,
): Promise<UnlistenFn[]> {
	const results = await Promise.allSettled(factories.map((factory) => factory()));
	const unlisteners: UnlistenFn[] = [];
	let firstError: unknown;
	let hasError = false;
	for (const result of results) {
		if (result.status === "fulfilled") {
			unlisteners.push(result.value);
		} else if (!hasError) {
			hasError = true;
			firstError = result.reason;
		}
	}
	if (hasError) {
		for (const unlisten of unlisteners) unlisten();
		throw firstError;
	}
	return unlisteners;
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
 * `encoder` は省略または `"auto"` なら Rust 側の自動選択に委ねる(invoke へは渡さない —
 * `undefined` もそのまま渡してよいが、キー自体を省略した方が意図が明確なため省く)。
 *
 * jobId はこの関数(renderer 側)で採番し、`listen()` を完了させてから
 * `invoke("reframe_start", …)` を呼ぶ(取りこぼし対策。理由は
 * `src-tauri/src/commands/reframe.rs` 冒頭コメント「jobId 採番をフロントエンドへ移した
 * 理由」参照)。Rust 側はジョブ登録直後(`spawn_blocking` 後すぐ)に進捗/完了/失敗を
 * emit しうるため、購読を先に確立しておかないとイベントを丸ごと取りこぼす。
 */
export async function startReframe(
	input: string,
	output: string,
	spec: EditSpec,
	handlers: ReframeHandlers,
	encoder?: EncoderPreference,
): Promise<JobHandle> {
	const jobId: JobId = newJobId();
	const handle = await subscribeReframeEvents(jobId, handlers);
	try {
		await invoke<void>("reframe_start", {
			jobId,
			input,
			output,
			spec,
			...(encoder && encoder !== "auto" ? { encoder } : {}),
		});
	} catch (err) {
		handle.unsubscribe();
		throw err;
	}
	return handle;
}

/**
 * `reframe://{progress,done,error}/${jobId}` を購読し、`JobHandle` を返す。
 * done/error はジョブの終端イベントなので、発火した時点でこの関数が自ら購読解除する
 * (呼び出し側の `handle` 変数の代入タイミングに依存させない — invoke() より先に
 * listen() する設計上、done/error が invoke() の resolve より先に発火しうるため、
 * 呼び出し側で `handle` を参照する形の自己クリーンアップは間に合わない可能性がある)。
 */
async function subscribeReframeEvents(
	jobId: JobId,
	handlers: ReframeHandlers,
): Promise<JobHandle> {
	let unlisteners: UnlistenFn[] = [];
	const unsubscribe = () => {
		for (const unlisten of unlisteners) unlisten();
		unlisteners = [];
	};
	unlisteners = await listenAll([
		() =>
			listen<Progress>(`reframe://progress/${jobId}`, (event) => {
				handlers.onProgress?.(event.payload);
			}),
		() =>
			listen<{ encoder: string }>(`reframe://done/${jobId}`, (event) => {
				unsubscribe();
				handlers.onDone?.(event.payload.encoder);
			}),
		() =>
			listen<{ message: string }>(`reframe://error/${jobId}`, (event) => {
				unsubscribe();
				handlers.onError?.(event.payload.message);
			}),
	]);
	return { jobId, unsubscribe, cancel: () => cancelJob(jobId) };
}

// ---- preview(キャッシュ付きレンダリング。既定は低ビットレート) -------------

export interface PreviewHandlers {
	onProgress?: (progress: Progress) => void;
	/** 生成(またはキャッシュヒット)したプレビューファイルの絶対パス。 */
	onDone?: (path: string) => void;
	onError?: (message: string) => void;
}

/**
 * キャッシュ付きレンダリングの品質。
 * - `"preview"`(既定): 低ビットレート(2Mbps)・`preview-cache`。目視確認用。
 * - `"publish"`: 本書き出しと同一品質(8Mbps)・`publish-cache`。IG 等への投稿用
 *   (投稿される実体がプレビュー品質にならないようにする。
 *   `src-tauri/src/commands/preview.rs` の `RenderQuality` と対応)。
 */
export type RenderQuality = "preview" | "publish";

/**
 * `input` を `spec` の指定形状へキャッシュ付きでレンダリングする
 * (`reframe_start` と同じジョブ ID 空間。キャンセルは `cancelJob` を使う)。
 * 品質は `quality` で選ぶ(省略時はプレビュー品質)。
 * done イベントの絶対パスは `convertFileSrc` を通してから `<video>` の `src` に使う。
 *
 * jobId 採番・listen-before-invoke の理由は `startReframe` と同じ(取りこぼし対策。
 * `src-tauri/src/commands/reframe.rs` 冒頭コメント参照)。
 */
export async function startPreview(
	input: string,
	spec: EditSpec,
	handlers: PreviewHandlers,
	quality?: RenderQuality,
): Promise<JobHandle> {
	const jobId: JobId = newJobId();
	let unlisteners: UnlistenFn[] = [];
	const unsubscribe = () => {
		for (const unlisten of unlisteners) unlisten();
		unlisteners = [];
	};
	unlisteners = await listenAll([
		() =>
			listen<Progress>(`preview://progress/${jobId}`, (event) => {
				handlers.onProgress?.(event.payload);
			}),
		() =>
			listen<{ path: string }>(`preview://done/${jobId}`, (event) => {
				unsubscribe();
				handlers.onDone?.(event.payload.path);
			}),
		() =>
			listen<{ message: string }>(`preview://error/${jobId}`, (event) => {
				unsubscribe();
				handlers.onError?.(event.payload.message);
			}),
	]);
	const handle: JobHandle = { jobId, unsubscribe, cancel: () => cancelJob(jobId) };
	try {
		// 既定品質("preview")ではキー自体を省略する(Rust 側 Option の既定に委ねる —
		// 既存呼び出しのペイロード形を変えないため)。
		await invoke<void>("preview_start", {
			jobId,
			input,
			spec,
			...(quality && quality !== "preview" ? { quality } : {}),
		});
	} catch (err) {
		unsubscribe();
		throw err;
	}
	return handle;
}

// ---- エンコード設定 ---------------------------------------------------------

/** 同時実行できるエンコードジョブ数の上限(1〜4)を設定する。 */
export function setMaxConcurrentEncodes(max: number): Promise<void> {
	return invoke<void>("set_max_concurrent_encodes", { max });
}

// ---- ユーティリティ --------------------------------------------------------

/** Windows で無効な文字を含むファイル名を安全な形へ置換する(clip.name は自由入力のため)。 */
export function sanitizeFileName(name: string): string {
	const cleaned = name.replace(/[<>:"/\\|?*]/g, "_").trim();
	return cleaned.length > 0 ? cleaned : "clip";
}
