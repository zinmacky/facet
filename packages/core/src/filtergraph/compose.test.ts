import { describe, it, expect } from "vitest";
import { compose } from "./compose.js";
import { getPreset, PRESETS } from "../presets.js";
import { toEven } from "./crop.js";
import { trimArgs } from "./trim.js";
import type { EditSpec } from "../types.js";

const source = { width: 1920, height: 1080 };

describe("compose", () => {
  it("9:16 blur-pad: split/overlay を含み out ラベルで終わる", () => {
    const spec: EditSpec = { source, preset: getPreset("9:16") };
    const plan = compose(spec);
    expect(plan.outLabel).toBe("[out]");
    expect(plan.filterComplex).toContain("split=2");
    expect(plan.filterComplex).toContain("gblur=sigma=20");
    expect(plan.filterComplex).toContain("overlay=(W-w)/2:(H-h)/2");
    expect(plan.filterComplex).toContain("scale=1080:1920");
  });

  it("1:1 crop: crop-cover になり blur を含まない", () => {
    const spec: EditSpec = { source, preset: getPreset("1:1") };
    const plan = compose(spec);
    expect(plan.filterComplex).toContain("scale=1080:1080:force_original_aspect_ratio=increase");
    expect(plan.filterComplex).toContain("crop=1080:1080");
    expect(plan.filterComplex).not.toContain("gblur");
  });

  it("事前クロップ指定で [pre] ノードが前段に入る", () => {
    const spec: EditSpec = {
      source,
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      preset: getPreset("9:16"),
    };
    const plan = compose(spec);
    // 0.5 * 1920 = 960(偶数), 1 * 1080 = 1080, x = 0.25*1920 = 480
    expect(plan.filterComplex).toContain("[0:v]crop=960:1080:480:0[pre]");
    expect(plan.filterComplex).toContain("[pre]");
  });

  it("trim は seek/duration 引数に落ち filtergraph には出ない", () => {
    const spec: EditSpec = { source, trim: { start: 1.5, end: 9 }, preset: getPreset("1:1") };
    const plan = compose(spec);
    expect(plan.seekArgs).toEqual(["-ss", "1.500"]);
    expect(plan.durationArgs).toEqual(["-t", "7.500"]);
    expect(plan.filterComplex).not.toContain("trim");
  });
});

describe("trimArgs", () => {
  it("trim 無しなら空", () => {
    expect(trimArgs(undefined)).toEqual({ seekArgs: [], durationArgs: [] });
  });
  it("start=0 なら -ss を出さない", () => {
    expect(trimArgs({ start: 0, end: 5 })).toEqual({ seekArgs: [], durationArgs: ["-t", "5.000"] });
  });
});

describe("toEven", () => {
  it("奇数を切り下げ、最小 2 を保証する", () => {
    expect(toEven(961)).toBe(960);
    expect(toEven(1)).toBe(2);
    expect(toEven(0)).toBe(2);
  });
});

describe("PRESETS", () => {
  it("3 種すべて 1080 幅を持つ", () => {
    expect(PRESETS["9:16"].width).toBe(1080);
    expect(PRESETS["1:1"].width).toBe(1080);
    expect(PRESETS["4:5"]).toEqual({ name: "4:5", width: 1080, height: 1350, fit: "blur-pad" });
  });
});
