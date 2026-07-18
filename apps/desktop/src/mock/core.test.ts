import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "./core";
import { mockOn } from "./eventBus";

/**
 * dev:mock(`pnpm --filter @facet/desktop dev:mock`)の `reframe_start`/`preview_start`
 * が renderer 採番の jobId(`lib/tauri.ts` の `startReframe`/`startPreview` が
 * `newJobId()` で採番し、invoke の引数として渡す)をそのまま使って進捗/完了イベントを
 * emit することの回帰テスト(Issue #93 実装内容3)。
 *
 * 過去に `core.ts` が独自採番(`mock-reframe-N`)していたため、emit するイベント名と
 * renderer が listen する UUID が食い違い、dev:mock では進捗・done・cancel が一切
 * 届かなかった不具合があった(コミット af8ff99 で修正済み)。本テストはブラウザでの
 * 目視確認が難しい dev:mock の挙動をユニットテストで固定し、再発を防ぐ。
 */

const RENDERER_JOB_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("mock/core.ts: renderer 採番の jobId 追随", () => {
	it("reframe_start は渡された jobId で reframe://done を emit する", async () => {
		let captured: unknown;
		mockOn(`reframe://done/${RENDERER_JOB_ID}`, (event) => {
			captured = event.payload;
		});

		await invoke("reframe_start", { jobId: RENDERER_JOB_ID });
		vi.advanceTimersByTime(3_000);

		expect(captured).toEqual({ encoder: "libx264" });
	});

	it("preview_start は渡された jobId で preview://done を emit する", async () => {
		let captured: unknown;
		mockOn(`preview://done/${RENDERER_JOB_ID}`, (event) => {
			captured = event.payload;
		});

		await invoke("preview_start", { jobId: RENDERER_JOB_ID });
		vi.advanceTimersByTime(3_000);

		expect(captured).toBeDefined();
	});

	it("jobId 未指定(空文字)では、renderer が listen する jobId 宛にイベントが届かない", async () => {
		let captured: unknown;
		mockOn(`reframe://done/${RENDERER_JOB_ID}`, (event) => {
			captured = event.payload;
		});

		// jobId を渡さない(args?.jobId が undefined → 空文字にフォールバックする経路)。
		// 独自採番していた頃の不具合(emit 先が renderer の listen 先と食い違う)は
		// 上の2件(渡した jobId で正しく届くこと)が主にガードする。本ケースは
		// 「jobId が空でも、無関係な jobId 宛のイベントとして漏れて届かない」ことの確認。
		await invoke("reframe_start", {});
		vi.advanceTimersByTime(3_000);

		expect(captured).toBeUndefined();
	});
});
