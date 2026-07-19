import { describe, it, expect } from "vitest";
import { editSpec, fitMode } from "./edit-spec.js";

const full = {
	source: { width: 1920, height: 1080 },
	trim: { start: 1.5, end: 9.0 },
	crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
	preset: { name: "9:16", width: 1080, height: 1920, fit: "blur-pad" as const },
};

describe("editSpec", () => {
	it("フル指定(source/trim/crop/preset すべてあり)を通す", () => {
		expect(editSpec.parse(full)).toEqual(full);
	});

	it("最小指定(trim/crop 省略)を通す", () => {
		const minimal = {
			source: { width: 1920, height: 1080 },
			preset: { name: "1:1", width: 1080, height: 1080, fit: "crop" as const },
		};
		expect(editSpec.parse(minimal)).toEqual(minimal);
	});

	it("crop 無し(trim あり)を通す", () => {
		const { crop: _crop, ...withoutCrop } = full;
		expect(editSpec.parse(withoutCrop)).toEqual(withoutCrop);
	});

	it("trim 無し(crop あり)を通す", () => {
		const { trim: _trim, ...withoutTrim } = full;
		expect(editSpec.parse(withoutTrim)).toEqual(withoutTrim);
	});

	it("source が無ければ弾く", () => {
		const { source: _source, ...rest } = full;
		expect(editSpec.safeParse(rest).success).toBe(false);
	});

	it("preset が無ければ弾く", () => {
		const { preset: _preset, ...rest } = full;
		expect(editSpec.safeParse(rest).success).toBe(false);
	});

	it("未知の fit は弾く", () => {
		expect(
			editSpec.safeParse({
				...full,
				preset: { ...full.preset, fit: "stretch" },
			}).success,
		).toBe(false);
	});

	it("未知キーは拒否せず受け入れる(.strict() を使わないため。将来フィールド追加時の後方互換を担保)", () => {
		expect(
			editSpec.parse({ ...full, futureField: 1 } as unknown as typeof full),
		).toEqual(full);
	});

	it("source の寸法は非負整数のみ", () => {
		expect(
			editSpec.safeParse({
				...full,
				source: { width: -1, height: 1080 },
			}).success,
		).toBe(false);
		expect(
			editSpec.safeParse({
				...full,
				source: { width: 1920.5, height: 1080 },
			}).success,
		).toBe(false);
	});
});

describe("fitMode", () => {
	it("blur-pad / crop の2値のみ", () => {
		expect(fitMode.options).toEqual(["blur-pad", "crop"]);
	});
});
