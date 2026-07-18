import { describe, expect, it } from "vitest";
import { resolveEdition } from "./edition.build";

describe("resolveEdition", () => {
	it("mode が private のときのみ private を返す", () => {
		expect(resolveEdition("private")).toBe("private");
	});

	// GHSA-7jjf-233f-jmg8: 無指定の素の `vite build`(mode="production")が
	// 特権的な private を生成する footgun だったため、既定を public に倒した
	// (breaking change)。private 以外は全て public にフォールバックすることを
	// 固定する回帰テスト。
	it("mode が private 以外(無指定の vite build 相当を含む)は public を返す", () => {
		expect(resolveEdition("public")).toBe("public");
		expect(resolveEdition("production")).toBe("public");
		expect(resolveEdition("development")).toBe("public");
		expect(resolveEdition("test")).toBe("public");
		expect(resolveEdition("mock")).toBe("public");
		expect(resolveEdition("")).toBe("public");
	});
});
