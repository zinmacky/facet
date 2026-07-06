import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EditSpec } from "@facet/core";
import { config } from "../config.js";
import {
	startExportJob,
	subscribeJob,
	abortJob,
	type ExportEvent,
} from "../services/export-jobs.js";

/**
 * 本書き出しルート(2 段)。
 * - POST /export           : 書き出しを受理し jobId を返す。
 * - GET  /export/:id/events : SSE で進捗を配信(EventSource 用に GET・default event)。
 */
export const exportRoute = new Hono();

interface ExportBody {
	spec: EditSpec;
	/** 元動画の絶対パス。 */
	input: string;
	/** 出力ファイル名(WORK_DIR 基準)または絶対パス。 */
	output: string;
}

/** trim から総尺(ms)を求める。無ければ undefined(percent 計算不可)。 */
function totalDurationMs(spec: EditSpec): number | undefined {
	if (!spec.trim) return undefined;
	const sec = spec.trim.end - spec.trim.start;
	return sec > 0 ? sec * 1000 : undefined;
}

exportRoute.post("/export", async (c) => {
	const body = (await c.req.json()) as ExportBody;
	if (!body?.spec || !body?.input || !body?.output) {
		return c.json({ error: "spec / input / output が必要です" }, 400);
	}

	const workDir = resolve(config.WORK_DIR);
	const output = isAbsolute(body.output)
		? body.output
		: join(workDir, body.output);
	await mkdir(dirname(output), { recursive: true });

	const total = totalDurationMs(body.spec);
	const jobId = startExportJob({
		spec: body.spec,
		input: resolve(body.input),
		output,
		...(total !== undefined ? { totalDurationMs: total } : {}),
	});

	return c.json({ jobId });
});

exportRoute.get("/export/:id/events", (c) => {
	const id = c.req.param("id");
	return streamSSE(c, async (stream) => {
		// 逐次書き込みのためイベントをローカルキューに積み、順に flush する。
		const queue: ExportEvent[] = [];
		let finished = false;
		let notify: (() => void) | null = null;
		let aborted = false;

		const unsub = subscribeJob(id, (e) => {
			queue.push(e);
			if (e.type === "done" || e.type === "error") finished = true;
			notify?.();
		});

		if (unsub === null) {
			await stream.writeSSE({
				data: JSON.stringify({ type: "error", message: "不明なジョブです" }),
			});
			return;
		}

		stream.onAbort(() => {
			aborted = true;
			unsub();
			// クライアント切断で書き出しも止める。
			abortJob(id);
			notify?.();
		});

		while (!aborted) {
			while (queue.length > 0) {
				const e = queue.shift();
				if (e) await stream.writeSSE({ data: JSON.stringify(e) });
			}
			if (finished) break;
			await new Promise<void>((r) => {
				notify = r;
			});
			notify = null;
		}
		unsub();
	});
});
