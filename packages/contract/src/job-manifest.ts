import { z } from "zod";

/**
 * ローカル(studio)→ クラウド(scheduler)の唯一の境界。
 * このスキーマを両者が import することで、ジョブ登録の齟齬をコンパイル時に潰す。
 */

/** Instagram の公開種別。1:1 フィード動画は VIDEO、9:16 は REELS。 */
export const mediaType = z.enum(["VIDEO", "REELS"]);
export type MediaType = z.infer<typeof mediaType>;

/** POST /jobs のリクエストボディ。 */
export const jobManifest = z.object({
  /** 二重登録防止。studio 側で発番し、scheduler は同一キーの再送を無視する。 */
  idempotencyKey: z.string().uuid(),
  platform: z.literal("instagram"),
  /** R2 の公開バケット上のキー。例: "posts/2026-07-10/reel.mp4" */
  r2Key: z.string().min(1),
  mediaType,
  caption: z.string().max(2200),
  /** 公開時刻(unix ms)。この時刻以降に scheduler が公開を開始する。 */
  publishAt: z.number().int().positive(),
});
export type JobManifest = z.infer<typeof jobManifest>;

/** ジョブの状態遷移。IG 公開ステートマシンの各段階に対応する。 */
export const jobStatus = z.enum([
  "pending", // 登録済み、公開時刻待ち
  "creating", // /media コンテナ生成中
  "processing", // コンテナの処理完了ポーリング中
  "publishing", // /media_publish 実行中
  "published", // 公開完了
  "failed", // 恒久失敗(attempts 上限 or ERROR/EXPIRED)
]);
export type JobStatus = z.infer<typeof jobStatus>;

/** GET /jobs/:id のレスポンス。 */
export const jobRecord = jobManifest.extend({
  id: z.string(),
  status: jobStatus,
  igContainerId: z.string().nullable(),
  igMediaId: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type JobRecord = z.infer<typeof jobRecord>;

/** POST /jobs のレスポンス。 */
export const jobCreateResponse = z.object({
  id: z.string(),
  status: jobStatus,
});
export type JobCreateResponse = z.infer<typeof jobCreateResponse>;
