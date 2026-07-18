import { describe, it, expect } from "vitest";
import { igPublishDone, igPublishProgress, igPublishRuntimeError } from "./ig-publish-events.js";

describe("igPublishProgress", () => {
	it("uploading フェーズを通す", () => {
		const value = {
			phase: "uploading" as const,
			bytesSent: 100,
			totalBytes: 1000,
			percent: 10,
		};
		expect(igPublishProgress.parse(value)).toEqual(value);
	});

	it("enqueuing フェーズを通す(追加フィールド無し)", () => {
		expect(igPublishProgress.parse({ phase: "enqueuing" })).toEqual({
			phase: "enqueuing",
		});
	});

	it("未知の phase は弾く", () => {
		expect(
			igPublishProgress.safeParse({ phase: "not-a-real-phase" }).success,
		).toBe(false);
	});

	it("uploading に必須フィールドが無ければ弾く", () => {
		expect(
			igPublishProgress.safeParse({ phase: "uploading" }).success,
		).toBe(false);
	});
});

describe("igPublishDone", () => {
	it("正当なペイロードを通す", () => {
		const value = { schedulerJobId: "job-1", status: "pending" };
		expect(igPublishDone.parse(value)).toEqual(value);
	});

	it("契約に無い status 値も通す(scheduler 側の将来拡張を壊さないため意図的に緩い)", () => {
		const value = { schedulerJobId: "job-1", status: "some-future-status" };
		expect(igPublishDone.parse(value)).toEqual(value);
	});

	it("schedulerJobId が無ければ弾く", () => {
		expect(igPublishDone.safeParse({ status: "pending" }).success).toBe(false);
	});
});

describe("igPublishRuntimeError", () => {
	it("detail 付き variant を通す", () => {
		const value = { kind: "network" as const, detail: "boom" };
		expect(igPublishRuntimeError.parse(value)).toEqual(value);
	});

	it("detail 無し variant を通す", () => {
		expect(igPublishRuntimeError.parse({ kind: "cancelled" })).toEqual({
			kind: "cancelled",
		});
	});

	it("全 variant を網羅する(Rust 側 IgPublishRuntimeError と同数)", () => {
		const kinds = [
			{ kind: "upload_failed", detail: "d" },
			{ kind: "enqueue_unauthorized" },
			{ kind: "enqueue_service_unavailable" },
			{ kind: "enqueue_rejected", detail: "d" },
			{ kind: "network", detail: "d" },
			{ kind: "cancelled" },
			{ kind: "internal", detail: "d" },
		];
		for (const value of kinds) {
			expect(() => igPublishRuntimeError.parse(value)).not.toThrow();
		}
	});

	it("未知の kind は弾く", () => {
		expect(
			igPublishRuntimeError.safeParse({ kind: "not-a-real-kind" }).success,
		).toBe(false);
	});
});
