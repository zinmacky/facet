import { describe, expect, it } from "vitest";
import { uniqueBaseNames } from "./uniqueBaseName";

describe("uniqueBaseNames", () => {
	it("重複しないベース名はそのまま返す", () => {
		const items = ["a", "b", "c"];
		const result = uniqueBaseNames(items, (x) => x);
		expect(result.get("a")).toBe("a");
		expect(result.get("b")).toBe("b");
		expect(result.get("c")).toBe("c");
	});

	it("同じベース名が複数あれば出現順に -2, -3, … を付与する", () => {
		// Map<T, string> で結果を返すため、items は一意な参照(オブジェクト)である
		// 必要がある(実際の呼び出し元(clip オブジェクト・task オブジェクト)も常に
		// 一意な参照)。プリミティブの重複値は Map キーとして衝突するため、ここでは
		// 明示的に別オブジェクトにする。
		const items = [{ base: "x" }, { base: "x" }, { base: "x" }, { base: "y" }];
		const result = uniqueBaseNames(items, (i) => i.base);
		const values = items.map((item) => result.get(item));
		expect(values).toEqual(["x", "x-2", "x-3", "y"]);
	});

	it("参照が異なるオブジェクトはそれぞれ独立したキーとして扱われる", () => {
		const first = { name: "dup" };
		const second = { name: "dup" };
		const result = uniqueBaseNames([first, second], (o) => o.name);
		expect(result.get(first)).toBe("dup");
		expect(result.get(second)).toBe("dup-2");
	});

	it("同じ入力から再計算しても常に同じ結果になる(安定・状態を持ち越さない)", () => {
		const items = ["clipA", "clipA", "clipB"];
		const first = uniqueBaseNames(items, (x) => x);
		const second = uniqueBaseNames(items, (x) => x);
		expect(items.map((i) => first.get(i))).toEqual(
			items.map((i) => second.get(i)),
		);
	});
});
