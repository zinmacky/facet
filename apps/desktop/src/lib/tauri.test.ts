import { describe, expect, it } from "vitest";
import { mockDialogOpen, mockDocumentDir } from "../test/tauri-mock";
import { pickExportDirectory, sanitizeFileName } from "./tauri";

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
