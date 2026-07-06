import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { compose, type EditSpec } from "@facet/core";
import { encode } from "../services/encode.js";
import { config } from "../config.js";

/**
 * プレビュー生成ルート。
 * EditSpec から低ビットレートの短い動画を WORK_DIR に書き出し、
 * その一時ファイルを /files/raw?path= 経由で参照できる URL を返す。
 * 同一 spec はハッシュでキャッシュする(再エンコードを避ける)。
 */
export const preview = new Hono();

/** プレビューの入力元。EditSpec に含まれない実ファイルパスは別途受け取る。 */
interface PreviewBody {
  spec: EditSpec;
  /** 元動画の絶対パス。 */
  input: string;
}

/** spec + input から安定したハッシュを作る(キャッシュキー)。 */
function specHash(body: PreviewBody): string {
  const json = JSON.stringify({ spec: body.spec, input: resolve(body.input) });
  return createHash("sha1").update(json).digest("hex").slice(0, 16);
}

preview.post("/preview", async (c) => {
  const body = (await c.req.json()) as PreviewBody;
  if (!body?.spec || !body?.input) {
    return c.json({ error: "spec と input が必要です" }, 400);
  }

  const workDir = resolve(config.WORK_DIR);
  await mkdir(workDir, { recursive: true });

  const hash = specHash(body);
  const output = join(workDir, `preview-${hash}.mp4`);

  // キャッシュヒット: 既存ファイルをそのまま返す。
  if (!existsSync(output)) {
    const plan = compose(body.spec);
    try {
      await encode(plan, {
        input: resolve(body.input),
        output,
        // プレビューは低ビットレート・高速優先。
        bitrate: "2M",
        overwrite: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  }

  const url = `/files/raw?path=${encodeURIComponent(output)}`;
  return c.json({ url, width: body.spec.preset.width, height: body.spec.preset.height });
});
