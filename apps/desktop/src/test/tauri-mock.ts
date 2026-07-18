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

/**
 * jobId 採番(`lib/jobId.ts` の `newJobId()`)のモック。バグ2対策で jobId は renderer 側
 * (`lib/tauri.ts` の `startReframe`/`startPreview`)が採番するようになったため、
 * Rust コマンド(`reframe_start`/`preview_start`)は jobId を戻り値として返さなくなった
 * (`Result<(), String>` を返すだけ)。テスト側は jobId を予測可能にするため
 * `newJobId()` を差し替え、以前の `job-${N}`(呼び出し順に採番)と同じ命名を保つ
 * (既存テストの `emitMockEvent("reframe://done/job-1", …)` 等をそのまま使えるようにする)。
 *
 * `crypto.randomUUID()` 自体はグローバルに差し替えない — `App.tsx`/
 * `features/upload/uploadTypes.ts` 等が clip/post/output の id 生成に直接
 * `crypto.randomUUID()` を使っており、グローバルに差し替えるとそれらの id も
 * `job-N` になってしまい、ジョブ ID の連番と衝突する(`lib/jobId.ts` の設計コメント
 * 参照)。ジョブ ID 採番だけを専用モジュール `lib/jobId.ts` に切り出し、
 * `src/test/setup.ts` で `vi.mock("../lib/jobId", …)` によりそのモジュールだけを
 * 差し替えることで分離している。
 */
let jobCounter = 0;
export const mockNewJobId = vi.fn((): string => {
	jobCounter += 1;
	return `job-${jobCounter}`;
});

/**
 * `commands::publish`(§features/publish-settings/)向けのインメモリ「キーチェーン」
 * モック状態。テストは `mockInvoke.mockImplementationOnce(...)` で個別の応答を
 * 差し替えられるが、既定実装では set/has/delete/check_scheduler_connection が
 * この変数を介して一貫した挙動になる(保存済みトークンがあれば疎通チェックは "ok" を
 * 返す、という単純な既定シナリオ)。
 */
let mockSchedulerApiToken: string | null = null;

/**
 * scheduler URL のインメモリモック状態(§commands/publish/mod.rs の
 * `KEY_SCHEDULER_URL`。GHSA-j74q-9v5x-87w3 対応で localStorage から invoke ベースへ
 * 変わったため、`mockSchedulerApiToken` と同じ形の状態をここに追加した)。
 */
let mockSchedulerUrl: string | null = null;

/**
 * R2(Cloudflare, S3 互換)資格情報のインメモリモック状態(§commands/publish/r2_credentials.rs)。
 * `mockSchedulerApiToken` と同じ「テストは個別に差し替え可能・既定実装は一貫した
 * シナリオを提供する」方針。
 */
let mockR2Credentials: {
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucket: string;
} | null = null;

/**
 * YouTube OAuth のインメモリモック状態(§commands/publish/youtube_oauth.rs)。
 * クライアント(client_id/secret)とトークンキャッシュ(接続済みフラグ)の2段構え。
 * `youtube_oauth_connect` の既定実装は「クライアント設定済みなら即接続成功」
 * (実ブラウザフローの成功ケースに相当)。
 */
let mockYoutubeOauthClient: { clientId: string; clientSecret: string } | null =
	null;
let mockYoutubeOauthConnected = false;

/** invoke コマンドの既定実装。未対応コマンドは reject する(テスト側の見落としに気付けるように)。 */
async function defaultInvokeImpl(cmd: string, args?: unknown): Promise<unknown> {
	switch (cmd) {
		case "ping":
			return "pong";
		case "probe":
			return DEFAULT_MEDIA_INFO;
		case "reframe_start":
		case "preview_start":
			// jobId は呼び出し側(renderer)が args.jobId として渡す。Rust 側は戻り値を返さない。
			return undefined;
		case "reframe_cancel":
		case "set_max_concurrent_encodes":
			return undefined;
		case "set_scheduler_api_token": {
			const { token } = (args ?? {}) as { token?: string };
			if (!token?.trim()) throw new Error("トークンが空です。");
			mockSchedulerApiToken = token;
			return undefined;
		}
		case "has_scheduler_api_token":
			return mockSchedulerApiToken !== null;
		case "delete_scheduler_api_token":
			mockSchedulerApiToken = null;
			return undefined;
		case "set_scheduler_url": {
			const { url } = (args ?? {}) as { url?: string };
			const trimmed = url?.trim();
			if (!trimmed) throw new Error("scheduler_url が空です。");
			mockSchedulerUrl = trimmed;
			return undefined;
		}
		case "get_scheduler_url":
			return mockSchedulerUrl;
		case "delete_scheduler_url":
			mockSchedulerUrl = null;
			return undefined;
		case "check_scheduler_connection":
			if (mockSchedulerUrl === null) return { status: "no_url" };
			return mockSchedulerApiToken === null
				? { status: "no_token" }
				: { status: "ok" };
		case "set_r2_credentials": {
			const { accountId, accessKeyId, secretAccessKey, bucket } = (args ??
				{}) as {
				accountId?: string;
				accessKeyId?: string;
				secretAccessKey?: string;
				bucket?: string;
			};
			if (!accountId?.trim() || !accessKeyId?.trim() || !secretAccessKey?.trim()) {
				throw new Error(
					"R2 のアカウント ID・アクセスキー ID・シークレットアクセスキーは必須です。",
				);
			}
			mockR2Credentials = {
				accountId,
				accessKeyId,
				secretAccessKey,
				bucket: bucket?.trim() || "facet-media",
			};
			return undefined;
		}
		case "has_r2_credentials":
			return mockR2Credentials !== null;
		case "delete_r2_credentials":
			mockR2Credentials = null;
			return undefined;
		case "ig_publish_start":
			// jobId は呼び出し側(renderer)が args.jobId として渡す。Rust 側は戻り値を
			// 返さない(バリデーション/資格情報未設定エラーのみテストが
			// `mockImplementationOnce` で個別に差し替える)。
			return undefined;
		case "ig_publish_cancel":
			return undefined;
		case "set_youtube_oauth_client": {
			const { clientId, clientSecret } = (args ?? {}) as {
				clientId?: string;
				clientSecret?: string;
			};
			if (!clientId?.trim() || !clientSecret?.trim()) {
				throw new Error("クライアントIDとクライアントシークレットは必須です。");
			}
			mockYoutubeOauthClient = { clientId, clientSecret };
			return undefined;
		}
		case "delete_youtube_oauth_client":
			// Rust 側と同じく、クライアント削除はトークンキャッシュも道連れにする。
			mockYoutubeOauthClient = null;
			mockYoutubeOauthConnected = false;
			return undefined;
		case "youtube_oauth_status":
			if (mockYoutubeOauthClient === null) return { status: "not_configured" };
			return mockYoutubeOauthConnected
				? { status: "connected" }
				: { status: "configured" };
		case "youtube_oauth_connect":
			if (mockYoutubeOauthClient === null) {
				throw new Error(
					"YouTube の OAuth クライアント(クライアントID/シークレット)が未設定です。設定画面から入力してください。",
				);
			}
			mockYoutubeOauthConnected = true;
			return undefined;
		case "youtube_oauth_disconnect":
			mockYoutubeOauthConnected = false;
			return undefined;
		case "youtube_publish_start":
			// jobId は呼び出し側(renderer)が args.jobId として渡す。Rust 側は戻り値を
			// 返さない(OAuth 未接続・タイトル未入力等の同期エラーのみテストが
			// `mockImplementationOnce` で個別に差し替える)。
			return undefined;
		case "youtube_publish_cancel":
			return undefined;
		default:
			throw new Error(`invoke not mocked for command: ${cmd}`);
	}
}

export const mockInvoke = vi.fn(defaultInvokeImpl);

/**
 * `mockInvoke` の `callIndex` 番目の呼び出しに渡された `jobId` 引数を返す
 * (`reframe_start`/`preview_start` の呼び出しから、渡された jobId を読み取るための
 * テスト用ヘルパ。以前の `await mockInvoke.mock.results[callIndex]?.value` 相当 —
 * jobId が戻り値ではなく引数になったため置き換え)。
 */
export function invokeJobId(callIndex: number): string | undefined {
	const args = mockInvoke.mock.calls[callIndex]?.[1] as { jobId?: string } | undefined;
	return args?.jobId;
}

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

/** `documentDir()`(`pickExportDirectory` の defaultPath 解決用)のダミー実装。 */
export const mockDocumentDir = vi.fn(async () => "/mock/Documents");

export const mockOpenPath = vi.fn(async (_path: string) => undefined);

/** ExportDetail の「フォルダで表示」(`revealItemInDir`)のモック。 */
export const mockRevealItemInDir = vi.fn(async (_path: string | string[]) => undefined);

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

	mockNewJobId.mockClear();
	jobCounter = 0;

	mockSchedulerApiToken = null;
	mockSchedulerUrl = null;
	mockR2Credentials = null;
	mockYoutubeOauthClient = null;
	mockYoutubeOauthConnected = false;

	mockListen.mockClear();
	eventHandlers.clear();

	mockConvertFileSrc.mockClear();
	mockConvertFileSrc.mockImplementation((path: string) => `asset://${path}`);

	mockDialogOpen.mockReset();
	mockDialogOpen.mockImplementation(async () => null);

	mockJoin.mockClear();
	mockJoin.mockImplementation(async (...parts: string[]) => parts.join("/"));

	mockDocumentDir.mockClear();
	mockDocumentDir.mockImplementation(async () => "/mock/Documents");

	mockOpenPath.mockReset();
	mockOpenPath.mockImplementation(async () => undefined);

	mockRevealItemInDir.mockReset();
	mockRevealItemInDir.mockImplementation(async () => undefined);

	mockIsPermissionGranted.mockReset();
	mockIsPermissionGranted.mockImplementation(async () => true);

	mockRequestPermission.mockReset();
	mockRequestPermission.mockImplementation(async () => "granted");

	mockSendNotification.mockReset();
	mockSendNotification.mockImplementation(async () => undefined);
}
