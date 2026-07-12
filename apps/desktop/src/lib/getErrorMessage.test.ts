import { describe, expect, it } from "vitest";
import { getErrorMessage } from "./getErrorMessage";

describe("getErrorMessage", () => {
	it("Error インスタンスなら message を返す", () => {
		expect(getErrorMessage(new Error("boom"))).toBe("boom");
	});

	it("Error のサブクラスでも message を返す", () => {
		class MyError extends Error {}
		expect(getErrorMessage(new MyError("custom"))).toBe("custom");
	});

	it("Error でない値は String() にフォールバックする", () => {
		expect(getErrorMessage("plain string")).toBe("plain string");
		expect(getErrorMessage(42)).toBe("42");
		expect(getErrorMessage(null)).toBe("null");
		expect(getErrorMessage(undefined)).toBe("undefined");
	});

	it("Error でないオブジェクトは String() の既定表現になる", () => {
		expect(getErrorMessage({ code: 1 })).toBe("[object Object]");
	});
});
