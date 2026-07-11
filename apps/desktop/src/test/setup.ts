import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
	mockConvertFileSrc,
	mockDialogOpen,
	mockInvoke,
	mockJoin,
	mockListen,
	mockOpenPath,
	resetTauriMocks,
} from "./tauri-mock";

/**
 * apps/desktop の全テストへ共通適用する setup。
 * - Tauri v2 の renderer 向け API(`lib/tauri.ts` が薄くラップしているもの)を
 *   `./tauri-mock` の実装へ差し替える(実 IPC は無いため、Tauri 外の vitest では
 *   invoke/listen が undefined でエラーになる)。
 * - jsdom に無い `ResizeObserver`(CropOverlay の snap effect が使う)を最小スタブで補う。
 */

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: Parameters<typeof mockInvoke>) => mockInvoke(...args),
	convertFileSrc: (...args: Parameters<typeof mockConvertFileSrc>) =>
		mockConvertFileSrc(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: (...args: Parameters<typeof mockListen>) => mockListen(...args),
}));

vi.mock("@tauri-apps/api/path", () => ({
	join: (...args: Parameters<typeof mockJoin>) => mockJoin(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: (...args: Parameters<typeof mockDialogOpen>) => mockDialogOpen(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openPath: (...args: Parameters<typeof mockOpenPath>) => mockOpenPath(...args),
}));

// CropOverlay は snap 有効時(固定アスペクト選択時)に ResizeObserver を使う。
// jsdom は ResizeObserver を実装していないため、no-op スタブで補う。
class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

afterEach(() => {
	cleanup();
	resetTauriMocks();
});
