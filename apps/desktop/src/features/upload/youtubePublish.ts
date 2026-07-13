import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { newJobId } from "../../lib/jobId";

/**
 * `youtube_publish_start`/`youtube_publish_cancel`
 * (`apps/desktop/src-tauri/src/commands/publish/youtube.rs`)の renderer 側ラッパ。
 * `igPublish.ts` と同じ listen-before-invoke パターン(PR #63)を踏襲する — jobId を
 * ここで採番し、`listen()` を完了させてから `invoke()` する(ジョブがどれだけ早く
 * 失敗しても取りこぼさないため)。
 *
 * private エディション専用(`usePublishExtras.tsx` からのみ import される。
 * §エディション分離、entry.public.ts)。
 */

/** Rust 側 `YoutubePublishProgress`(`phase` タグの internally-tagged enum)と同形。 */
export type YoutubePublishProgress = {
	phase: "uploading";
	bytesSent: number;
	totalBytes: number;
	percent: number;
};

/** Rust 側 `YoutubePublishDone` と同形。 */
export interface YoutubePublishDone {
	videoId: string;
	/** publishAt 指定時は "scheduled"、それ以外は実際の privacyStatus。 */
	status: string;
}

/** Rust 側 `YoutubePublishRuntimeError`(`kind` タグの internally-tagged enum)と同形。 */
export type YoutubePublishRuntimeError =
	| { kind: "not_authorized" }
	| { kind: "quota_or_forbidden"; detail: string }
	| { kind: "network"; detail: string }
	| { kind: "api"; detail: string }
	| { kind: "cancelled" }
	| { kind: "internal"; detail: string };

/** `YoutubePublishRuntimeError` を日本語のユーザー向けメッセージへ変換する。 */
export function describeYoutubePublishError(
	error: YoutubePublishRuntimeError,
): string {
	switch (error.kind) {
		case "not_authorized":
			return "YouTube の認可が無効です。設定画面から「Google と接続」をやり直してください。";
		case "quota_or_forbidden":
			return `YouTube API に拒否されました(quota 超過または権限不足): ${error.detail}`;
		case "network":
			return `通信に失敗しました: ${error.detail}`;
		case "api":
			return `YouTube API エラー: ${error.detail}`;
		case "cancelled":
			return "キャンセルされました。";
		case "internal":
			return `内部エラーが発生しました: ${error.detail}`;
		default: {
			// 型の網羅性チェック(将来 Rust 側に variant が追加されたら型エラーで気付ける)。
			const exhaustive: never = error;
			return `不明なエラーです: ${JSON.stringify(exhaustive)}`;
		}
	}
}

export interface YoutubePublishHandlers {
	onProgress?: (progress: YoutubePublishProgress) => void;
	onDone?: (done: YoutubePublishDone) => void;
	onError?: (error: YoutubePublishRuntimeError) => void;
}

export interface YoutubePublishHandle {
	jobId: string;
	/** 購読を解除する(コンポーネントの unmount/再実行時に呼ぶ)。 */
	unsubscribe: () => void;
	/** このジョブをキャンセルする(`youtube_publish_cancel` のラッパ)。 */
	cancel: () => Promise<void>;
}

/** `youtube_publish_cancel` を呼ぶ。 */
export function cancelYoutubePublishJob(jobId: string): Promise<void> {
	return invoke<void>("youtube_publish_cancel", { jobId });
}

/**
 * YouTube への動画アップロード(+ publishAt 指定時は予約公開)を開始する。
 *
 * `inputPath` は書き出し済み mp4 の絶対パス(8Mbps の publish 品質、
 * §usePublishExtras の `ensurePublishRendered`)、`publishAt` は unix ms(未指定なら
 * 即時アップロードで privacyStatus は Rust 側の既定 = private)。OAuth 未接続・
 * タイトル未入力などジョブ開始前に判明する失敗は `invoke()` 自体の reject
 * (Err(String))として返る。アップロード開始後の失敗(401・quota・ネットワーク・
 * キャンセル)は `onError` ハンドラに構造化 enum で届く。
 */
export async function startYoutubePublish(
	params: {
		inputPath: string;
		title: string;
		description: string;
		publishAt?: number;
	},
	handlers: YoutubePublishHandlers,
): Promise<YoutubePublishHandle> {
	const jobId = newJobId();

	let unlisteners: UnlistenFn[] = [];
	const unsubscribe = () => {
		for (const unlisten of unlisteners) unlisten();
		unlisteners = [];
	};
	unlisteners = await Promise.all([
		listen<YoutubePublishProgress>(
			`youtube_publish://progress/${jobId}`,
			(event) => {
				handlers.onProgress?.(event.payload);
			},
		),
		listen<YoutubePublishDone>(`youtube_publish://done/${jobId}`, (event) => {
			unsubscribe();
			handlers.onDone?.(event.payload);
		}),
		listen<YoutubePublishRuntimeError>(
			`youtube_publish://error/${jobId}`,
			(event) => {
				unsubscribe();
				handlers.onError?.(event.payload);
			},
		),
	]);

	const handle: YoutubePublishHandle = {
		jobId,
		unsubscribe,
		cancel: () => cancelYoutubePublishJob(jobId),
	};

	try {
		await invoke<void>("youtube_publish_start", {
			jobId,
			inputPath: params.inputPath,
			title: params.title,
			description: params.description,
			publishAt: params.publishAt ?? null,
			// 常に null(= Rust 側の既定 private)を送る意図的な固定。予約公開は private が
			// YouTube 側の必須要件で、即時アップロードも §12.2 の未監査 private ロックを
			// 考慮し private を既定とする(公開への切り替えは YouTube Studio 側で行う)。
			// Rust の `privacy_status` 引数は旧 TS 実装(publish.ts の privacyStatus)との
			// 対応を保つため残しており、UI から公開範囲を選ばせる場合はここを配線する。
			privacyStatus: null,
		});
	} catch (err) {
		unsubscribe();
		throw err;
	}
	return handle;
}
