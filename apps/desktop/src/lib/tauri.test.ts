import type { EditSpec } from "@facet/core";
import { describe, expect, it, vi } from "vitest";
import {
	mockDialogOpen,
	mockDocumentDir,
	mockEventListenerCount,
	mockListen,
} from "../test/tauri-mock";
import {
	pickExportDirectory,
	sanitizeFileName,
	startPreview,
	startReframe,
} from "./tauri";

const SPEC: EditSpec = {
	source: { width: 1920, height: 1080 },
	preset: { name: "free", width: 1080, height: 1920, fit: "crop" },
};

describe("sanitizeFileName", () => {
	it("Windows で無効な文字を _ に置換する", () => {
		expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe(
			"a_b_c_d_e_f_g_h_i_j",
		);
	});

	it("前後の空白を trim する", () => {
		expect(sanitizeFileName("  clip name  ")).toBe("clip name");
	});

	it("有効な文字はそのまま通す(日本語含む)", () => {
		expect(sanitizeFileName("元動画_切り抜き1")).toBe("元動画_切り抜き1");
	});

	it("空文字・空白のみの場合は既定値 'clip' を返す(置換は 1:1 なので文字自体は消えない)", () => {
		expect(sanitizeFileName("")).toBe("clip");
		expect(sanitizeFileName("   ")).toBe("clip");
	});

	it("禁止文字のみの入力は置換後に非空になるため 'clip' にはフォールバックしない", () => {
		expect(sanitizeFileName("///")).toBe("___");
	});
});

describe("pickExportDirectory", () => {
	it("preferredDefaultPath があればそれを defaultPath として渡す(documentDir は呼ばない)", async () => {
		mockDialogOpen.mockImplementationOnce(async () => "/picked/dir");

		const result = await pickExportDirectory("タイトル", "/last/exported/dir");

		expect(result).toBe("/picked/dir");
		expect(mockDialogOpen).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "タイトル",
				directory: true,
				defaultPath: "/last/exported/dir",
			}),
		);
		expect(mockDocumentDir).not.toHaveBeenCalled();
	});

	it("preferredDefaultPath が無ければ documentDir() の結果を defaultPath として渡す", async () => {
		mockDocumentDir.mockImplementationOnce(async () => "/mock/Documents");
		mockDialogOpen.mockImplementationOnce(async () => "/picked/dir");

		await pickExportDirectory();

		expect(mockDocumentDir).toHaveBeenCalledOnce();
		expect(mockDialogOpen).toHaveBeenCalledWith(
			expect.objectContaining({ defaultPath: "/mock/Documents" }),
		);
	});

	it("preferredDefaultPath が null でも documentDir() へフォールバックする", async () => {
		mockDocumentDir.mockImplementationOnce(async () => "/mock/Documents");
		mockDialogOpen.mockImplementationOnce(async () => "/picked/dir");

		await pickExportDirectory("タイトル", null);

		expect(mockDocumentDir).toHaveBeenCalledOnce();
	});

	it("preferredDefaultPath が空文字列でも documentDir() へフォールバックする(壊れた永続化値対策)", async () => {
		mockDocumentDir.mockImplementationOnce(async () => "/mock/Documents");
		mockDialogOpen.mockImplementationOnce(async () => "/picked/dir");

		await pickExportDirectory("タイトル", "");

		expect(mockDocumentDir).toHaveBeenCalledOnce();
		expect(mockDialogOpen).toHaveBeenCalledWith(
			expect.objectContaining({ defaultPath: "/mock/Documents" }),
		);
	});

	it("documentDir() が失敗したら defaultPath を渡さない(現状挙動へフォールバック)", async () => {
		mockDocumentDir.mockImplementationOnce(async () => {
			throw new Error("documentDir 未対応環境");
		});
		mockDialogOpen.mockImplementationOnce(async () => "/picked/dir");

		await pickExportDirectory();

		const [opts] = mockDialogOpen.mock.calls.at(-1) as [
			Record<string, unknown>,
		];
		expect(opts).not.toHaveProperty("defaultPath");
	});

	it("ダイアログがキャンセルされたら null を返す", async () => {
		mockDialogOpen.mockImplementationOnce(async () => null);

		const result = await pickExportDirectory();

		expect(result).toBeNull();
	});
});

describe("listen() の部分失敗時のクリーンアップ", () => {
	// `startReframe`/`startPreview` はいずれも progress/done/error の3つを
	// `listen()` で並行購読してから invoke する。3つのうち1つでも reject したら、
	// 既に登録済み(resolve 済み)の listener の unlisten を必ず呼ぶこと
	// (呼ばないと Tauri 側に購読が残ったままリークする)を検証する。

	it("startReframe: done の listen() が reject したら、先に成功した progress/error の unlisten を呼ぶ", async () => {
		const progressUnlisten = vi.fn();
		const errorUnlisten = vi.fn();
		mockListen
			.mockImplementationOnce(async () => progressUnlisten) // reframe://progress/*
			.mockImplementationOnce(async () => {
				throw new Error("listen 失敗(done)");
			}) // reframe://done/*
			.mockImplementationOnce(async () => errorUnlisten); // reframe://error/*

		await expect(
			startReframe("in.mp4", "out.mp4", SPEC, {}),
		).rejects.toThrow("listen 失敗(done)");

		expect(progressUnlisten).toHaveBeenCalledTimes(1);
		expect(errorUnlisten).toHaveBeenCalledTimes(1);
	});

	it("startPreview: progress の listen() が reject したら、先に成功した done/error の unlisten を呼ぶ", async () => {
		const doneUnlisten = vi.fn();
		const errorUnlisten = vi.fn();
		mockListen
			.mockImplementationOnce(async () => {
				throw new Error("listen 失敗(progress)");
			}) // preview://progress/*
			.mockImplementationOnce(async () => doneUnlisten) // preview://done/*
			.mockImplementationOnce(async () => errorUnlisten); // preview://error/*

		await expect(startPreview("in.mp4", SPEC, {})).rejects.toThrow(
			"listen 失敗(progress)",
		);

		expect(doneUnlisten).toHaveBeenCalledTimes(1);
		expect(errorUnlisten).toHaveBeenCalledTimes(1);
	});

	it("startReframe: すべての listen() が成功すれば正常に JobHandle を返す(回帰確認)", async () => {
		await expect(
			startReframe("in.mp4", "out.mp4", SPEC, {}),
		).resolves.toMatchObject({ jobId: expect.any(String) });
		expect(mockEventListenerCount("reframe://progress/job-1")).toBe(1);
	});
});
