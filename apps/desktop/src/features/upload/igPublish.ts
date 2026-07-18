import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
	IgPublishDone as ContractIgPublishDone,
	IgPublishProgress as ContractIgPublishProgress,
	IgPublishRuntimeError as ContractIgPublishRuntimeError,
	JobRecord,
} from "@facet/contract";
import { newJobId } from "../../lib/jobId";

/**
 * `ig_publish_start`/`ig_publish_cancel`(`apps/desktop/src-tauri/src/commands/publish/ig.rs`)
 * の renderer 側ラッパ。`lib/tauri.ts` の `startReframe`/`startPreview` と同じ
 * listen-before-invoke パターン(PR #63)を踏襲する — jobId をここで採番し、
 * `listen()` を完了させてから `invoke()` する(ジョブがどれだけ早く失敗しても
 * 取りこぼさないため。理由は `src-tauri/src/commands/reframe.rs` 冒頭コメント
 * 「jobId 採番をフロントエンドへ移した理由」参照)。
 *
 * イベントペイロードの型は `@facet/contract`(`ig-publish-events.ts`)の zod スキーマから
 * `z.infer` で導出する(Issue #93 パート B: 契約と Rust 実装の形状一致を型レベルでも
 * 保証する)。型名はこのモジュールの既存の呼び出し側を変えないため維持する。
 */

/** Rust 側 `IgPublishProgress`(`phase` タグの internally-tagged enum)と同形。 */
export type IgPublishProgress = ContractIgPublishProgress;

/** Rust 側 `IgPublishDone` と同形。 */
export type IgPublishDone = ContractIgPublishDone;

/** Rust 側 `IgPublishRuntimeError`(`kind` タグの internally-tagged enum)と同形。 */
export type IgPublishRuntimeError = ContractIgPublishRuntimeError;

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
 * Rust 側 `IgJobStatusOutcome`(`outcome` タグの internally-tagged enum)と同形。
 * `found` の場合のみ `JobRecord`(`@facet/contract` の `jobRecord` から `z.infer`)の
 * フィールドがタグと並んでフラットに乗る(Rust 側の newtype variant の serde 表現)。
 *
 * `not_found`(404)と `unauthorized`/`service_unavailable`/`network`(一過性)を型上も
 * 区別する — レビュー指摘対応: 当初は成功時の `JobRecord` のみを返し、失敗は
 * すべて `invoke()` の reject に一律まとめていたが、それだと 404(scheduler 側で
 * ジョブが見つからない、恒久的に回復しない事象)と一過性エラー(ネットワーク瞬断・
 * 401・503、再試行で回復しうる)を呼び出し側が区別できず、404 でもポーリングを
 * 永久に続けてしまっていた(`usePublishExtras.tsx` の `pollIgJobStatus` 参照)。
 */
export type IgJobStatusOutcome =
	| ({ outcome: "found" } & JobRecord)
	| { outcome: "not_found" }
	| { outcome: "unauthorized" }
	| { outcome: "service_unavailable" }
	| { outcome: "network"; detail: string };

/**
 * `ig_job_status` を呼び、scheduler 側の現在のジョブ状態を取得する。
 *
 * アーキテクチャレビュー指摘対応: `startIgPublish` の `onDone` は「scheduler がジョブ
 * 登録を受理した」ことしか意味せず、実際の IG 側公開成否(`published`/`failed`)は
 * 別途この関数で確認する必要がある(`usePublishExtras.tsx` がポーリング/手動更新の
 * 両方からこれを呼ぶ)。
 *
 * scheduler URL/トークン未設定等の想定外ケースのみ `invoke()` の reject(Error)として
 * 返る(`commands/publish/ig.rs` の `IgJobStatusOutcome`/`job_status_impl` 冒頭コメント
 * 参照)。401/503/404/ネットワークエラーは reject ではなく `IgJobStatusOutcome` の
 * タグ付き variant として解決する。
 */
export function fetchIgJobStatus(
	schedulerJobId: string,
): Promise<IgJobStatusOutcome> {
	return invoke<IgJobStatusOutcome>("ig_job_status", { schedulerJobId });
}

/**
 * `JobRecord.status`(終端に達していない途中経過)を日本語の短い説明へ変換する。
 * `published`/`failed`(終端)は呼び出し側(`usePublishExtras.tsx`)が
 * success/error として個別に扱うため、ここでは非終端の値のみを主に想定するが、
 * 呼び出し側の分岐漏れに備えて全 variant を網羅する。
 *
 * scheduler(`packages/contract` の `jobStatus`)が将来値を追加した場合に備え、
 * 網羅性チェック(`never` アサーション)はせず `default` でそのまま返す
 * (`describeIgPublishError` と異なり、`JobRecord.status` は Rust 側で意図的に
 * `String` として扱う値 — `crates/contract-rs/build.rs` 冒頭コメント参照 — のため、
 * 型上の網羅集合と実際に届きうる値の集合が一致する保証がない)。
 */
export function describeIgJobStatus(status: JobRecord["status"]): string {
	switch (status) {
		case "pending":
			return "公開時刻を待機中…";
		case "creating":
			return "投稿コンテナを生成中…";
		case "processing":
			return "処理完了を確認中…";
		case "publishing":
			return "公開処理を実行中…";
		case "published":
			return "公開完了";
		case "failed":
			return "公開に失敗しました";
		default:
			return status;
	}
}

/**
 * IG(Instagram)への予約公開ジョブを開始する。
 *
 * `inputPath` は書き出し済みの mp4 の絶対パス、`publishAt` は unix ms。scheduler の
 * 送信先(scheduler_url)はここでは渡さない — Rust 側がキーチェーンの保存値から読む
 * (GHSA-j74q-9v5x-87w3 対応: renderer が任意の送信先を指定できると、WebView 侵害時に
 * Bearer トークンを任意ホストへ流出させられるため。`schedulerUrlStore.ts`/
 * `commands/publish/ig.rs` 冒頭コメント参照)。
 * バリデーション(ファイルサイズ・尺・キャプション長)・R2/scheduler の資格情報・URL
 * 未設定は `invoke()` 自体の reject(Err(String))として返る(ジョブは開始されない、
 * `commands/publish/ig.rs` 冒頭コメント参照)。R2 アップロード/scheduler 登録開始後の
 * 失敗(ネットワーク・401・503・キャンセル)は `onError` ハンドラに構造化 enum で届く。
 *
 * `params.jobId` は省略可能(省略時は従来どおり `newJobId()` で新規採番)。
 * 呼び出し側(`usePublishExtras.tsx`)が output ごとに安定な jobId を再利用して渡すと、
 * Rust 側(並行実装中)が jobId から idempotency_key を決定的に導出できるようになり、
 * 同一 output の再投稿(リトライ)が同一キーになって二重公開を防げる
 * (Issue #95 と対になる Rust 側変更)。再利用する場合、呼び出し側は「前回の試行が
 * 終了(done/error)している」ことを保証する責任を負う — Rust 側は実行中の同一
 * jobId を拒否する予定のため。
 */
export async function startIgPublish(
	params: {
		inputPath: string;
		caption: string;
		publishAt: number;
		jobId?: string;
	},
	handlers: IgPublishHandlers,
): Promise<IgPublishHandle> {
	const jobId = params.jobId ?? newJobId();

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
		});
	} catch (err) {
		unsubscribe();
		throw err;
	}
	return handle;
}
