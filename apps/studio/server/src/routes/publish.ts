import { Hono } from "hono";
import { z } from "zod";
import { mediaType } from "@facet/contract";
import { uploadWithSchedule } from "../services/youtube.js";
import { uploadToR2AndEnqueue } from "../services/scheduler-client.js";

/**
 * 公開ルート。YouTube は直投稿、Instagram は R2 アップロード + scheduler 登録。
 */
export const publish = new Hono();

const youtubeBody = z.object({
  /** 書き出し済み出力ファイルの絶対パス。 */
  outputPath: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  /** 公開予約時刻(unix ms)。未指定なら即時公開。 */
  publishAt: z.number().int().positive().optional(),
  privacyStatus: z.enum(["private", "unlisted", "public"]).optional(),
});

publish.post("/publish/youtube", async (c) => {
  const parsed = youtubeBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const { outputPath, title, description, publishAt, privacyStatus } = parsed.data;
  try {
    const result = await uploadWithSchedule({
      videoPath: outputPath,
      title,
      ...(description !== undefined ? { description } : {}),
      // ms → ISO 8601 に変換して YouTube に渡す。
      ...(publishAt !== undefined ? { publishAt: new Date(publishAt).toISOString() } : {}),
      ...(privacyStatus !== undefined ? { privacyStatus } : {}),
    });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

const instagramBody = z.object({
  /** 書き出し済み出力ファイルの絶対パス。 */
  outputPath: z.string().min(1),
  caption: z.string().max(2200),
  mediaType,
  /** 公開時刻(unix ms)。 */
  publishAt: z.number().int().positive(),
});

publish.post("/publish/instagram", async (c) => {
  const parsed = instagramBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const { outputPath, caption, mediaType: mt, publishAt } = parsed.data;
  try {
    const result = await uploadToR2AndEnqueue({
      videoPath: outputPath,
      caption,
      mediaType: mt,
      publishAt,
    });
    // web は JobCreateResponse({ id, status })を期待する。r2Key も参考に付す。
    return c.json({ id: result.jobId, status: result.status, r2Key: result.r2Key });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});
