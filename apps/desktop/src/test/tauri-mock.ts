import { vi } from "vitest";
import type { MediaInfo } from "../lib/tauri";

/**
 * `@tauri-apps/api` / `@tauri-apps/plugin-dialog` / `@tauri-apps/plugin-opener` /
 * `@tauri-apps/plugin-notification` のテスト用モック実装。`src/test/setup.ts` が
 * `vi.mock` でこのモジュールへ差し替える(全テストファイル共通)。個々のテストは
 * `mockInvoke.mockImplementationOnce(...)` 等で挙動を差し替え、`emitMockEvent` で
 * ジョブ完了/進捗/エラーイベントを発火させる。
 *
 * `resetTauriMocks()` を各テストの `beforeEach` で呼び、前のテストの状態を引きずらない
 * ようにする(setup.ts の afterEach でも呼ぶ)。
 */

export const DEFAULT_MEDIA_INFO: MediaInfo = {
	duration: 30,
	width: 1920,
	height: 1080,
	sar: "1:1",
	dar: "16:9",
	fps: 30,
	hasAudio: true,
	codec: "h264",
};

let jobCounter = 0;

/** invoke コマンドの既定実装。未対応コマンドは reject する(テスト側の見落としに気付けるように)。 */
async function defaultInvokeImpl(cmd: string, _args?: unknown): Promise<unknown> {
	switch (cmd) {
		case "ping":
			return "pong";
		case "probe":
			return DEFAULT_MEDIA_INFO;
		case "reframe_start":
		case "preview_start":
			jobCounter += 1;
			return `job-${jobCounter}`;
		case "reframe_cancel":
		case "set_max_concurrent_encodes":
			return undefined;
		default:
			throw new Error(`invoke not mocked for command: ${cmd}`);
	}
}

export const mockInvoke = vi.fn(defaultInvokeImpl);

// event 名 → 登録済みハンドラの集合(reframe://progress/<jobId> のような動的イベント名)。
type EventHandler = (event: { payload: unknown }) => void;
const eventHandlers = new Map<string, Set<EventHandler>>();

export const mockListen = vi.fn(
	async (event: string, handler: EventHandler): Promise<() => void> => {
		let set = eventHandlers.get(event);
		if (!set) {
			set = new Set();
			eventHandlers.set(event, set);
		}
		set.add(handler);
		return () => {
			eventHandlers.get(event)?.delete(handler);
		};
	},
);

/** `listen(event, handler)` で登録済みのハンドラへイベントを配送する(テストからのジョブ完了通知等)。 */
export function emitMockEvent(event: string, payload: unknown): void {
	const set = eventHandlers.get(event);
	if (!set) return;
	for (const handler of [...set]) handler({ payload });
}

/** 現在 `event` に登録されているハンドラ数(購読解除の検証用)。 */
export function mockEventListenerCount(event: string): number {
	return eventHandlers.get(event)?.size ?? 0;
}

export const mockConvertFileSrc = vi.fn((path: string) => `asset://${path}`);

export const mockDialogOpen = vi.fn(async (_opts?: unknown): Promise<string | null> => null);

export const mockJoin = vi.fn(async (...parts: string[]) => parts.join("/"));

export const mockOpenPath = vi.fn(async (_path: string) => undefined);

// 通知権限は既定で許可済み扱い(多くのテストは通知フローそのものを検証しないため)。
// 権限拒否のケースを検証するテストは isPermissionGranted/requestPermission を
// 個別に差し替える。
export const mockIsPermissionGranted = vi.fn(async () => true);

export const mockRequestPermission = vi.fn(async (): Promise<NotificationPermission> => "granted");

export const mockSendNotification = vi.fn(async (_options: unknown) => undefined);

/** 各テスト後に呼び、モックの呼び出し履歴・購読・ジョブ採番をリセットする。 */
export function resetTauriMocks(): void {
	mockInvoke.mockReset();
	mockInvoke.mockImplementation(defaultInvokeImpl);
	jobCounter = 0;

	mockListen.mockClear();
	eventHandlers.clear();

	mockConvertFileSrc.mockClear();
	mockConvertFileSrc.mockImplementation((path: string) => `asset://${path}`);

	mockDialogOpen.mockReset();
	mockDialogOpen.mockImplementation(async () => null);

	mockJoin.mockClear();
	mockJoin.mockImplementation(async (...parts: string[]) => parts.join("/"));

	mockOpenPath.mockReset();
	mockOpenPath.mockImplementation(async () => undefined);

	mockIsPermissionGranted.mockReset();
	mockIsPermissionGranted.mockImplementation(async () => true);

	mockRequestPermission.mockReset();
	mockRequestPermission.mockImplementation(async () => "granted");

	mockSendNotification.mockReset();
	mockSendNotification.mockImplementation(async () => undefined);
}
