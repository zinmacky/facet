import { describe, it, expect } from "vitest";
import { buildR2Key } from "./scheduler-client.js";

describe("buildR2Key", () => {
  it("posts/<YYYY-MM-DD>/<uuid>.mp4 の形になる(日付は UTC 基準)", () => {
    // 2026-07-10T12:34:56Z の unix ms
    const publishAtMs = Date.UTC(2026, 6, 10, 12, 34, 56);
    const uuid = "11111111-2222-3333-4444-555555555555";
    expect(buildR2Key(publishAtMs, uuid)).toBe(`posts/2026-07-10/${uuid}.mp4`);
  });

  it("UTC 日付の境界を跨ぐローカル時刻でも UTC の日付を使う", () => {
    // UTC では 2026-07-10 00:30、多くのローカルタイムゾーンでは前日夜になる時刻。
    const publishAtMs = Date.UTC(2026, 6, 10, 0, 30, 0);
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(buildR2Key(publishAtMs, uuid)).toBe(`posts/2026-07-10/${uuid}.mp4`);
  });
});
