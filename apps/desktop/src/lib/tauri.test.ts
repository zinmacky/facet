import { describe, expect, it } from "vitest";
import { sanitizeFileName } from "./tauri";

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
