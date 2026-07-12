import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SETTINGS,
	SETTINGS_STORAGE_KEY,
	SettingsProvider,
	resolveTheme,
	useSettings,
} from "./settings";

/**
 * 制御可能な matchMedia スタブを window へ差し込む。
 * setDark() で OS 設定(prefers-color-scheme: dark)の変化を模倣し、
 * SettingsProvider が購読している change リスナーへ通知する。
 */
function installMatchMedia(initialDark: boolean) {
	let matches = initialDark;
	const listeners = new Set<(ev: MediaQueryListEvent) => void>();
	const mql = {
		get matches() {
			return matches;
		},
		media: "(prefers-color-scheme: dark)",
		onchange: null,
		addEventListener: (_type: string, cb: (ev: MediaQueryListEvent) => void) => {
			listeners.add(cb);
		},
		removeEventListener: (
			_type: string,
			cb: (ev: MediaQueryListEvent) => void,
		) => {
			listeners.delete(cb);
		},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	} as unknown as MediaQueryList;
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockReturnValue(mql),
	);
	return {
		setDark(next: boolean) {
			matches = next;
			for (const cb of listeners)
				cb({ matches: next } as MediaQueryListEvent);
		},
	};
}

function renderSettings() {
	return renderHook(() => useSettings(), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<SettingsProvider>{children}</SettingsProvider>
		),
	});
}

function hasDarkClass(): boolean {
	return document.documentElement.classList.contains("dark");
}

beforeEach(() => {
	window.localStorage.clear();
	document.documentElement.classList.remove("dark");
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("resolveTheme", () => {
	it("light/dark は OS 設定に関わらずそのまま返す", () => {
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("dark", false)).toBe("dark");
	});

	it("system は OS 設定へ追従する", () => {
		expect(resolveTheme("system", true)).toBe("dark");
		expect(resolveTheme("system", false)).toBe("light");
	});
});

describe("SettingsProvider", () => {
	it("保存値が無ければ既定値(theme: dark)で起動し、html に .dark が付く", () => {
		installMatchMedia(false);
		const { result } = renderSettings();

		expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
		expect(hasDarkClass()).toBe(true);
	});

	it("updateSettings({ theme: 'light' }) で .dark が外れ、localStorage に保存される", () => {
		installMatchMedia(false);
		const { result } = renderSettings();

		act(() => {
			result.current.updateSettings({ theme: "light" });
		});

		expect(result.current.settings.theme).toBe("light");
		expect(hasDarkClass()).toBe(false);
		const stored = JSON.parse(
			window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null",
		);
		expect(stored).toEqual({ ...DEFAULT_SETTINGS, theme: "light" });
	});

	it("theme: 'system' のとき matchMedia の値と change イベントに追従する", () => {
		window.localStorage.setItem(
			SETTINGS_STORAGE_KEY,
			JSON.stringify({ theme: "system" }),
		);
		const media = installMatchMedia(true);
		renderSettings();

		// OS がダーク → .dark あり
		expect(hasDarkClass()).toBe(true);

		// OS がライトへ変化 → .dark が外れる
		act(() => {
			media.setDark(false);
		});
		expect(hasDarkClass()).toBe(false);

		// OS がダークへ戻る → .dark が付く
		act(() => {
			media.setDark(true);
		});
		expect(hasDarkClass()).toBe(true);
	});

	it("localStorage に壊れた JSON があっても DEFAULT_SETTINGS で起動する", () => {
		window.localStorage.setItem(SETTINGS_STORAGE_KEY, "{壊れたJSON");
		installMatchMedia(false);
		const { result } = renderSettings();

		expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
		expect(hasDarkClass()).toBe(true);
	});

	it("部分的な保存値・不正なフィールドは DEFAULT_SETTINGS とマージされる", () => {
		window.localStorage.setItem(
			SETTINGS_STORAGE_KEY,
			JSON.stringify({ theme: "light", openFolderAfterExport: "yes" }),
		);
		installMatchMedia(false);
		const { result } = renderSettings();

		expect(result.current.settings).toEqual({
			theme: "light",
			// 未保存のフィールドは既定値
			defaultExportDir: null,
			// 型が不正なフィールドも既定値へフォールバック
			openFolderAfterExport: false,
		});
		expect(hasDarkClass()).toBe(false);
	});

	it("未知の theme 値は既定の dark へフォールバックする", () => {
		window.localStorage.setItem(
			SETTINGS_STORAGE_KEY,
			JSON.stringify({ theme: "sepia" }),
		);
		installMatchMedia(false);
		const { result } = renderSettings();

		expect(result.current.settings.theme).toBe("dark");
		expect(hasDarkClass()).toBe(true);
	});
});
