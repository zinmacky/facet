import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
	mockConvertFileSrc,
	mockDialogOpen,
	mockDocumentDir,
	mockInvoke,
	mockIsPermissionGranted,
	mockJoin,
	mockListen,
	mockNewJobId,
	mockOpenPath,
	mockRequestPermission,
	mockRevealItemInDir,
	mockSendNotification,
	resetTauriMocks,
} from "./tauri-mock";

/**
 * apps/desktop の全テストへ共通適用する setup。
 * - Tauri v2 の renderer 向け API(`lib/tauri.ts` が薄くラップしているもの)を
 *   `./tauri-mock` の実装へ差し替える(実 IPC は無いため、Tauri 外の vitest では
 *   invoke/listen が undefined でエラーになる)。
 * - `lib/jobId.ts`(`reframe_start`/`preview_start` の jobId 採番)を決定的な実装へ
 *   差し替える(`job-1`, `job-2`, … の連番。`crypto.randomUUID()` はグローバルには
 *   差し替えない — `tauri-mock.ts` の `mockNewJobId` コメント参照)。
 * - jsdom に無い `ResizeObserver`(CropOverlay の snap effect が使う)を最小スタブで補う。
 * - jsdom に無い `setPointerCapture`/`releasePointerCapture`/`hasPointerCapture`
 *   (CropOverlay/Timeline のドラッグ実装が使う)を最小スタブで補う。
 */

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: Parameters<typeof mockInvoke>) => mockInvoke(...args),
	convertFileSrc: (...args: Parameters<typeof mockConvertFileSrc>) =>
		mockConvertFileSrc(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: (...args: Parameters<typeof mockListen>) => mockListen(...args),
}));

vi.mock("../lib/jobId", () => ({
	newJobId: (...args: Parameters<typeof mockNewJobId>) => mockNewJobId(...args),
}));

vi.mock("@tauri-apps/api/path", () => ({
	join: (...args: Parameters<typeof mockJoin>) => mockJoin(...args),
	documentDir: (...args: Parameters<typeof mockDocumentDir>) =>
		mockDocumentDir(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: (...args: Parameters<typeof mockDialogOpen>) => mockDialogOpen(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openPath: (...args: Parameters<typeof mockOpenPath>) => mockOpenPath(...args),
	revealItemInDir: (...args: Parameters<typeof mockRevealItemInDir>) =>
		mockRevealItemInDir(...args),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
	isPermissionGranted: (...args: Parameters<typeof mockIsPermissionGranted>) =>
		mockIsPermissionGranted(...args),
	requestPermission: (...args: Parameters<typeof mockRequestPermission>) =>
		mockRequestPermission(...args),
	sendNotification: (...args: Parameters<typeof mockSendNotification>) =>
		mockSendNotification(...args),
}));

// CropOverlay は snap 有効時(固定アスペクト選択時)に ResizeObserver を使う。
// jsdom は ResizeObserver を実装していないため、no-op スタブで補う。
class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

// jsdom は Pointer Events の capture 系メソッドを実装していない
// (呼ぶと "not a function" で即エラーになる)。CropOverlay/Timeline のドラッグ
// ハンドラが `e.currentTarget.setPointerCapture(...)` を呼ぶため no-op で補う。
if (!Element.prototype.setPointerCapture) {
	Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
	Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}

// jsdom は matchMedia を実装していない。SettingsProvider が "system" テーマの
// 解決(prefers-color-scheme 判定)に使うため、最小スタブで補う。
// matches: false 固定(= ライト相当)だが、既定テーマは "dark" なので既存テストの
// 見た目には影響しない。値や change を制御したいテストは vi.stubGlobal で上書きする。
if (typeof window.matchMedia !== "function") {
	window.matchMedia = (query: string): MediaQueryList =>
		({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}) as MediaQueryList;
}

// jsdom は <video>/<audio> の再生を実装していない(play/pause/load は
// "Not implemented" 警告を吐く)。ClipEditor・usePauseVideosOnHide が
// 呼ぶため、テスト出力を汚さないよう no-op へ差し替える。
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};
HTMLMediaElement.prototype.load = () => {};

afterEach(() => {
	cleanup();
	resetTauriMocks();
});
