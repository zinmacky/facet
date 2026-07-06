import { randomUUID } from "node:crypto";
import { compose, type EditSpec } from "@facet/core";
import type { Progress } from "@facet/ffmpeg-runner";
import { encode } from "./encode.js";

/**
 * 書き出しジョブのインメモリレジストリ。
 *
 * web 側は EventSource(GET 専用)で進捗を購読するため、書き出しは
 * 「POST /export で受理し jobId を返す → GET /export/:id/events で購読」の 2 段になる。
 * POST と GET の間に発生した早期イベントを取りこぼさないよう、各ジョブは
 * イベントをバッファし、購読開始時にリプレイする。
 */

/** web(api.ts)の ExportEvent と一致させる契約。 */
export type ExportEvent =
	| { type: "progress"; ratio: number; fps?: number }
	| { type: "notice"; message: string }
	| { type: "done"; outputPath: string }
	| { type: "error"; message: string };

interface Job {
	events: ExportEvent[];
	finished: boolean;
	listeners: Set<(e: ExportEvent) => void>;
	controller: AbortController;
}

const jobs = new Map<string, Job>();

export interface StartExportParams {
	spec: EditSpec;
	/** 元動画の絶対パス。 */
	input: string;
	/** 出力先の絶対パス。 */
	output: string;
	/** percent 計算用の総尺(ms)。trim があるときのみ。 */
	totalDurationMs?: number;
}

/** 書き出しを起動し jobId を返す。ffmpeg は非同期に走り、進捗を emit する。 */
export function startExportJob(params: StartExportParams): string {
	const jobId = randomUUID();
	const job: Job = {
		events: [],
		finished: false,
		listeners: new Set(),
		controller: new AbortController(),
	};
	jobs.set(jobId, job);

	const emit = (e: ExportEvent) => {
		job.events.push(e);
		if (e.type === "done" || e.type === "error") job.finished = true;
		for (const l of job.listeners) l(e);
	};

	const plan = compose(params.spec);
	// encode がエンコードの同時実行制限と libx264 フォールバックを担う。
	encode(
		plan,
		{
			input: params.input,
			output: params.output,
			overwrite: true,
			...(params.totalDurationMs !== undefined
				? { totalDurationMs: params.totalDurationMs }
				: {}),
		},
		{
			signal: job.controller.signal,
			onProgress: (p: Progress) =>
				emit({
					type: "progress",
					ratio: p.percent !== undefined ? p.percent / 100 : 0,
					fps: p.fps,
				}),
		},
		() =>
			emit({ type: "notice", message: "ソフトウェアエンコードで再試行中…" }),
	)
		.then(() => emit({ type: "done", outputPath: params.output }))
		.catch((err: unknown) =>
			emit({
				type: "error",
				message: err instanceof Error ? err.message : String(err),
			}),
		);

	return jobId;
}

/**
 * ジョブの進捗を購読する。既存イベントをリプレイしてから以後を配信する。
 * 未知の jobId なら null。戻り値は購読解除関数。
 */
export function subscribeJob(
	jobId: string,
	onEvent: (e: ExportEvent) => void,
): (() => void) | null {
	const job = jobs.get(jobId);
	if (!job) return null;
	for (const e of job.events) onEvent(e);
	if (job.finished) return () => {};
	job.listeners.add(onEvent);
	return () => {
		job.listeners.delete(onEvent);
	};
}

/** 進行中の書き出しを中断する(ffmpeg を kill)。 */
export function abortJob(jobId: string): void {
	jobs.get(jobId)?.controller.abort();
}
