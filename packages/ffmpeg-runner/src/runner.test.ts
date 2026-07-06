import { describe, expect, it } from "vitest";
import type { FilterPlan } from "@facet/core";
import { buildFfmpegArgs } from "./runner.js";

/** テスト用のダミー FilterPlan。 */
const plan: FilterPlan = {
	seekArgs: ["-ss", "1.500"],
	durationArgs: ["-t", "7.500"],
	filterComplex: "[0:v]scale=1080:1080[out]",
	outLabel: "[out]",
};

describe("buildFfmpegArgs", () => {
	it("既定値でエンコード引数を組み立てる", () => {
		const args = buildFfmpegArgs(plan, { input: "in.mp4", output: "out.mp4" });

		// 既定 encoder は h264_videotoolbox。
		const vIdx = args.indexOf("-c:v");
		expect(vIdx).toBeGreaterThanOrEqual(0);
		expect(args[vIdx + 1]).toBe("h264_videotoolbox");

		// filter_complex とグラフ文字列。
		const fcIdx = args.indexOf("-filter_complex");
		expect(fcIdx).toBeGreaterThanOrEqual(0);
		expect(args[fcIdx + 1]).toBe("[0:v]scale=1080:1080[out]");

		// 出力ラベルを -map している。
		const mapIdx = args.indexOf("-map");
		expect(args[mapIdx + 1]).toBe("[out]");

		// faststart が含まれる。
		const mfIdx = args.indexOf("-movflags");
		expect(args[mfIdx + 1]).toBe("+faststart");

		// -ss は -i より前、-t は -i より後。
		const inputIdx = args.indexOf("-i");
		expect(args.indexOf("-ss")).toBeLessThan(inputIdx);
		expect(args.indexOf("-t")).toBeGreaterThan(inputIdx);

		// 既定ビットレート。
		expect(args[args.indexOf("-b:v") + 1]).toBe("8M");
		expect(args[args.indexOf("-b:a") + 1]).toBe("128k");

		// 既定では -y を付けない。
		expect(args).not.toContain("-y");

		// 出力パスは末尾。
		expect(args[args.length - 1]).toBe("out.mp4");
	});

	it("encoder 上書きと overwrite フラグを反映する", () => {
		const args = buildFfmpegArgs(plan, {
			input: "in.mp4",
			output: "out.mp4",
			encoder: "libx264",
			overwrite: true,
			bitrate: "12M",
			audioBitrate: "192k",
		});

		expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
		expect(args).toContain("-y");
		// -y は入力より前。
		expect(args.indexOf("-y")).toBeLessThan(args.indexOf("-i"));
		expect(args[args.indexOf("-b:v") + 1]).toBe("12M");
		expect(args[args.indexOf("-b:a") + 1]).toBe("192k");
	});
});
