import { describe, it, expect } from "vitest";
import { jobManifest, jobStatus } from "./job-manifest.js";

const valid = {
	idempotencyKey: "3f0e6c2a-1b2c-4d5e-8f90-1a2b3c4d5e6f",
	platform: "instagram" as const,
	r2Key: "posts/2026-07-10/reel.mp4",
	mediaType: "REELS" as const,
	caption: "hello",
	publishAt: 1_752_000_000_000,
};

describe("jobManifest", () => {
	it("正当なマニフェストを通す", () => {
		expect(jobManifest.parse(valid)).toEqual(valid);
	});

	it("idempotencyKey が UUID でなければ弾く", () => {
		expect(
			jobManifest.safeParse({ ...valid, idempotencyKey: "not-a-uuid" }).success,
		).toBe(false);
	});

	it("caption 2200 文字超を弾く", () => {
		expect(
			jobManifest.safeParse({ ...valid, caption: "x".repeat(2201) }).success,
		).toBe(false);
	});

	it("platform は instagram 固定(youtube は経路が別なので不可)", () => {
		expect(
			jobManifest.safeParse({ ...valid, platform: "youtube" }).success,
		).toBe(false);
	});

	it("publishAt は正の整数のみ", () => {
		expect(jobManifest.safeParse({ ...valid, publishAt: -1 }).success).toBe(
			false,
		);
		expect(jobManifest.safeParse({ ...valid, publishAt: 1.5 }).success).toBe(
			false,
		);
	});
});

describe("jobStatus", () => {
	it("ステートマシンの全状態を列挙する", () => {
		expect(jobStatus.options).toEqual([
			"pending",
			"creating",
			"processing",
			"publishing",
			"published",
			"failed",
		]);
	});
});
