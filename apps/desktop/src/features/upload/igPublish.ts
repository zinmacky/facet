import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { newJobId } from "../../lib/jobId";

/**
 * `ig_publish_start`/`ig_publish_cancel`(`apps/desktop/src-tauri/src/commands/publish/ig.rs`)
 * の renderer 側ラッパ。`lib/tauri.ts` の `startReframe`/`startPreview` と同じ
 * listen-before-invoke パターン(PR #63)を踏襲する — jobId をここで採番し、
 * `listen()` を完了させてから `invoke()` する(ジョブがどれだけ早く失敗しても
 * 取りこぼさないため。理由は `src-tauri/src/commands/reframe.rs` 冒頭コメント
 * 「jobId 採番をフロントエンドへ移した理由」参照)。
 */

/** Rust 側 `IgPublishProgress`(`phase` タグの internally-tagged enum)と同形。 */
export type IgPublishProgress =
	| { phase: "uploading"; bytesSent: number; totalBytes: number; percent: number }
	| { phase: "enqueuing" };

/** Rust 側 `IgPublishDone` と同形。 */
export interface IgPublishDone {
	schedulerJobId: string;
	status: string;
}

/** Rust 側 `IgPublishRuntimeError`(`kind` タグの internally-tagged enum)と同形。 */
export type IgPublishRuntimeError =
	| { kind: "upload_failed"; detail: string }
	| { kind: "enqueue_unauthorized" }
	| { kind: "enqueue_service_unavailable" }
	| { kind: "enqueue_rejected"; detail: string }
	| { kind: "network"; detail: string }
	| { kind: "cancelled" }
	| { kind: "internal"; detail: string };

/** `IgPublishRuntimeError` を日本語のユーザー向けメッセージへ変換する。 */
export function describeIgPublishError(error: IgPublishRuntimeError): string {
	switch (error.kind) {
		case "upload_failed":
			return `R2へのアップロードに失敗しました: ${error.detail}`;
		case "enqueue_unauthorized":
			return "scheduler の API トークンが無効です。設定を確認してください。";
		case "enqueue_service_unavailable":
			return "scheduler が未設定です(503)。セルフホスト手順書を確認してください。";
		case "enqueue_rejected":
			return `scheduler にジョブ登録を拒否されました: ${error.detail}`;
		case "network":
			return `通信に失敗しました: ${error.detail}`;
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

export interface IgPublishHandlers {
	onProgress?: (progress: IgPublishProgress) => void;
	onDone?: (done: IgPublishDone) => void;
	onError?: (error: IgPublishRuntimeError) => void;
}

export interface IgPublishHandle {
	jobId: string;
	/** 購読を解除する(コンポーネントの unmount/再実行時に呼ぶ)。 */
	unsubscribe: () => void;
	/** このジョブをキャンセルする(`ig_publish_cancel` のラッパ)。 */
	cancel: () => Promise<void>;
}

/** `ig_publish_cancel` を呼ぶ。 */
export function cancelIgPublishJob(jobId: string): Promise<void> {
	return invoke<void>("ig_publish_cancel", { jobId });
}

/**
 * IG(Instagram)への予約公開ジョブを開始する。
 *
 * `inputPath` は書き出し済みの mp4 の絶対パス、`publishAt` は unix ms、
 * `schedulerUrl` は scheduler のベース URL(`schedulerUrlStore.ts` から読む)。
 * バリデーション(ファイルサイズ・尺・キャプション長)・R2/scheduler の資格情報未設定は
 * `invoke()` 自体の reject(Err(String))として返る(ジョブは開始されない、
 * `commands/publish/ig.rs` 冒頭コメント参照)。R2 アップロード/scheduler 登録開始後の
 * 失敗(ネットワーク・401・503・キャンセル)は `onError` ハンドラに構造化 enum で届く。
 */
export async function startIgPublish(
	params: {
		inputPath: string;
		caption: string;
		publishAt: number;
		schedulerUrl: string;
	},
	handlers: IgPublishHandlers,
): Promise<IgPublishHandle> {
	const jobId = newJobId();

	let unlisteners: UnlistenFn[] = [];
	const unsubscribe = () => {
		for (const unlisten of unlisteners) unlisten();
		unlisteners = [];
	};
	unlisteners = await Promise.all([
		listen<IgPublishProgress>(`ig_publish://progress/${jobId}`, (event) => {
			handlers.onProgress?.(event.payload);
		}),
		listen<IgPublishDone>(`ig_publish://done/${jobId}`, (event) => {
			unsubscribe();
			handlers.onDone?.(event.payload);
		}),
		listen<IgPublishRuntimeError>(`ig_publish://error/${jobId}`, (event) => {
			unsubscribe();
			handlers.onError?.(event.payload);
		}),
	]);

	const handle: IgPublishHandle = {
		jobId,
		unsubscribe,
		cancel: () => cancelIgPublishJob(jobId),
	};

	try {
		await invoke<void>("ig_publish_start", {
			jobId,
			inputPath: params.inputPath,
			caption: params.caption,
			publishAt: params.publishAt,
			schedulerUrl: params.schedulerUrl,
		});
	} catch (err) {
		unsubscribe();
		throw err;
	}
	return handle;
}
