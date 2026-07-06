import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { probe } from "@reframe/ffmpeg-runner";

/**
 * ローカルファイル関連のルート。
 * ローカルツール前提のため、パスは WORK_DIR 外の絶対パスも許可する。
 * ただし path.resolve で ".." を正規化してから使う。
 */
export const files = new Hono();

/** GET /files/probe?path=<abs> : ffprobe の生メタを返す。 */
files.get("/files/probe", async (c) => {
  const raw = c.req.query("path");
  if (!raw) {
    return c.json({ error: "path クエリが必要です" }, 400);
  }
  const path = resolve(raw);
  try {
    const result = await probe(path);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /probe { path } : web が使う契約。
 * probe 結果に <video> 用の配信 URL(/files/raw?path=)を足して返す。
 */
files.post("/probe", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { path?: string } | null;
  const raw = body?.path;
  if (!raw) {
    return c.json({ error: "path が必要です" }, 400);
  }
  const path = resolve(raw);
  try {
    const p = await probe(path);
    return c.json({
      url: `/files/raw?path=${encodeURIComponent(path)}`,
      width: p.width,
      height: p.height,
      duration: p.duration,
      codec: p.codec,
      fps: p.fps,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/** Range ヘッダ("bytes=start-end")を解釈する。無効/未指定なら undefined。 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const startStr = m[1] ?? "";
  const endStr = m[2] ?? "";

  let start: number;
  let end: number;
  if (startStr === "") {
    // 末尾 N バイト("bytes=-500")。
    if (endStr === "") return undefined;
    const suffix = Number(endStr);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Number(endStr);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (start > end || start < 0 || start >= size) return undefined;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * GET /files/raw?path=<abs> : ローカル動画を Range 対応で返す。
 * <video> 要素からのシーク付き再生に使う。
 */
files.get("/files/raw", async (c) => {
  const raw = c.req.query("path");
  if (!raw) {
    return c.json({ error: "path クエリが必要です" }, 400);
  }
  const path = resolve(raw);

  let size: number;
  try {
    const s = await stat(path);
    if (!s.isFile()) {
      return c.json({ error: "ファイルではありません" }, 400);
    }
    size = s.size;
  } catch {
    return c.json({ error: "ファイルが見つかりません" }, 404);
  }

  const contentType = "video/mp4";
  const range = parseRange(c.req.header("range"), size);

  if (range) {
    const { start, end } = range;
    const nodeStream = createReadStream(path, { start, end });
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;
    return new Response(webStream, {
      status: 206,
      headers: {
        "content-type": contentType,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
      },
    });
  }

  const nodeStream = createReadStream(path);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;
  return new Response(webStream, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(size),
      "accept-ranges": "bytes",
    },
  });
});
