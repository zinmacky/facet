import { describe, expect, it } from "vitest";
import { decideNext } from "./publish-do.js";

/**
 * decideNext の純粋テスト。Worker ランタイム不要。
 * status_code と attempts から次アクションが正しく決まることを検証する。
 */
describe("decideNext", () => {
	const MAX = 5;

	it("FINISHED は publish", () => {
		expect(decideNext("FINISHED", 0, MAX).action).toBe("publish");
	});

	it("IN_PROGRESS は reArm", () => {
		expect(decideNext("IN_PROGRESS", 0, MAX).action).toBe("reArm");
	});

	it("ERROR は fail", () => {
		const r = decideNext("ERROR", 0, MAX);
		expect(r.action).toBe("fail");
		expect(r.reason).toBeDefined();
	});

	it("EXPIRED は fail", () => {
		const r = decideNext("EXPIRED", 0, MAX);
		expect(r.action).toBe("fail");
		expect(r.reason).toBeDefined();
	});

	it("attempts が max 到達なら status に関わらず fail", () => {
		expect(decideNext("FINISHED", MAX, MAX).action).toBe("fail");
		expect(decideNext("IN_PROGRESS", MAX, MAX).action).toBe("fail");
		expect(decideNext("IN_PROGRESS", MAX + 1, MAX).action).toBe("fail");
	});

	it("attempts が max 未満なら通常判定", () => {
		expect(decideNext("IN_PROGRESS", MAX - 1, MAX).action).toBe("reArm");
		expect(decideNext("FINISHED", MAX - 1, MAX).action).toBe("publish");
	});
});
