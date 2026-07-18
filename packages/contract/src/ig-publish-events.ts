import { z } from "zod";

/**
 * `apps/desktop/src-tauri/src/commands/publish/ig.rs` が
 * `ig_publish://progress|done|error/{jobId}` として発火する Tauri イベントペイロードの
 * 契約。`packages/contract/src/job-manifest.ts` が studio(desktop)⇄ scheduler の
 * HTTP 境界であるのに対し、こちらは Rust(desktop バックエンド)⇄ renderer(desktop
 * フロントエンド)の同一プロセス内境界。POST /jobs の HTTP レスポンスそのものでは
 * ないため `job-manifest.ts` とは別ファイルに定義する。
 *
 * Rust 側は internally-tagged enum(`#[serde(tag = "...")]`)で実装しているため、
 * ここでも `z.discriminatedUnion` で同じ形(タグ + variant ごとのフィールド)を表現する。
 */

/** `ig_publish://progress/{jobId}` イベントのペイロード。 */
export const igPublishProgress = z.discriminatedUnion("phase", [
	z.object({
		phase: z.literal("uploading"),
		bytesSent: z.number().int().nonnegative(),
		totalBytes: z.number().int().nonnegative(),
		percent: z.number(),
	}),
	z.object({
		phase: z.literal("enqueuing"),
	}),
]);
export type IgPublishProgress = z.infer<typeof igPublishProgress>;

/**
 * `ig_publish://done/{jobId}` イベントのペイロード。
 *
 * `status` は `jobStatus`(`job-manifest.ts`)ではなく敢えて `z.string()` にしている。
 * Rust 側の `IgPublishDone.status` は scheduler の `JobCreateResponse.status` を
 * そのまま転送したもので、scheduler 側が新しい status 値を追加しても desktop の
 * デシリアライズが壊れないよう意図的に enum 化していない
 * (`apps/desktop/crates/contract-rs/build.rs` 冒頭コメント参照)。ここで `jobStatus`
 * enum を使うと契約側だけが scheduler より厳しい制約を課すことになり、Rust 実装の
 * 意図と矛盾してしまう。
 */
export const igPublishDone = z.object({
	schedulerJobId: z.string(),
	status: z.string(),
});
export type IgPublishDone = z.infer<typeof igPublishDone>;

/** `ig_publish://error/{jobId}` イベントのペイロード。 */
export const igPublishRuntimeError = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("upload_failed"), detail: z.string() }),
	z.object({ kind: z.literal("enqueue_unauthorized") }),
	z.object({ kind: z.literal("enqueue_service_unavailable") }),
	z.object({ kind: z.literal("enqueue_rejected"), detail: z.string() }),
	z.object({ kind: z.literal("network"), detail: z.string() }),
	z.object({ kind: z.literal("cancelled") }),
	z.object({ kind: z.literal("internal"), detail: z.string() }),
]);
export type IgPublishRuntimeError = z.infer<typeof igPublishRuntimeError>;
