import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Clip } from "../../types";
import { renderWithProviders } from "../../test/render";
import {
	DEFAULT_MEDIA_INFO,
	emitMockEvent,
	invokeJobId,
	mockInvoke,
} from "../../test/tauri-mock";
import { UploadScreen } from "./UploadScreenPrivate";

/**
 * YouTube 投稿フローのテスト(Phase 3 本体、§6.5)。`UploadScreen.igPublish.test.tsx` と
 * 同じ構成で、YouTube 固有の点を検証する:
 *
 * - ゲート活性化条件: Google 接続済み(`ytReady`)のときのみ YouTube 向け Output の
 *   投稿ボタンが有効になる(IG のゲートとは独立)。
 * - 投稿フロー: 投稿用レンダリング(preview_start, publish 品質 8Mbps)→
 *   youtube_publish_start(listen-before-invoke。タイトル/説明は UploadOutput の
 *   メタデータ)→ 進捗(uploading %)→ done で「完了」。
 * - エラー分類: Rust 側の構造化 enum(kind タグ)がユーザー向けメッセージに変換される。
 */

const SOURCE = { inputPath: "/in.mp4", probe: DEFAULT_MEDIA_INFO };

const CLIP: Clip = {
	id: "clip-1",
	name: "ClipOne",
	trim: { start: 0, end: 5 },
	aspect: "free",
};

beforeEach(() => {
	window.localStorage.clear();
});

/** YouTube ゲートが開く前提条件(OAuth クライアント保存 + Google 接続)を作る。 */
async function setUpConnectedYoutube() {
	// tauri-mock の defaultInvokeImpl のインメモリ状態を直接構築する
	// (render 前に呼ぶことで、PublishGateProvider のマウント時チェックが connected になる)。
	await mockInvoke("set_youtube_oauth_client", {
		clientId: "client-id",
		clientSecret: "client-secret",
	});
	await mockInvoke("youtube_oauth_connect");
}

function renderScreen() {
	return renderWithProviders(
		<UploadScreen
			active
			source={SOURCE}
			clips={[CLIP]}
			resetToken={0}
			onGoToExport={() => {}}
		/>,
	);
}

/**
 * 既定ターゲット(yt-shorts = YouTube)のまま「投稿設定」を開いて投稿ボタンを返す
 * (アクセシブルネームの都合は igPublish テストの `outputCardDisclosureButton` 参照)。
 */
async function openYoutubePublishButton(
	user: ReturnType<typeof userEvent.setup>,
) {
	await waitFor(() =>
		expect(screen.getByLabelText("出力ターゲット")).toBeInTheDocument(),
	);
	await user.click(screen.getByRole("button", { name: /投稿設定.*未投稿/ }));
	return screen.getByRole("button", { name: "投稿" });
}

describe("UploadScreen: YouTube 投稿のゲート活性化", () => {
	it("Google 未接続の間は投稿ボタンが disabled で、案内バナーが表示される", async () => {
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openYoutubePublishButton(user);
		expect(publishButton).toBeDisabled();
		expect(
			screen.getByText(/YouTube\s*への投稿には設定(.*)が必要です/),
		).toBeInTheDocument();
	});

	it("クライアント設定のみ(未接続)では投稿ボタンは disabled のまま", async () => {
		await mockInvoke("set_youtube_oauth_client", {
			clientId: "client-id",
			clientSecret: "client-secret",
		});
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openYoutubePublishButton(user);
		expect(publishButton).toBeDisabled();
	});

	it("Google 接続済みで YouTube の投稿ボタンが有効になる", async () => {
		await setUpConnectedYoutube();
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openYoutubePublishButton(user);
		await waitFor(() => expect(publishButton).toBeEnabled());
	});

	it("YouTube 接続済みでも IG(未設定)の投稿ボタンは disabled のまま(ゲートは独立)", async () => {
		await setUpConnectedYoutube();
		const user = userEvent.setup();
		renderScreen();

		await waitFor(() =>
			expect(screen.getByLabelText("出力ターゲット")).toBeInTheDocument(),
		);
		await user.selectOptions(screen.getByLabelText("出力ターゲット"), "ig-reels");
		await user.click(screen.getByRole("button", { name: /投稿設定.*未投稿/ }));

		expect(screen.getByRole("button", { name: "投稿" })).toBeDisabled();
	});

	it("接続済みなら §12.2 の予約公開(監査)警告が表示される", async () => {
		await setUpConnectedYoutube();
		renderScreen();

		await waitFor(() =>
			expect(
				screen.getByText(/監査済みの Google Cloud プロジェクトでのみ機能します/),
			).toBeInTheDocument(),
		);
	});
});

describe("UploadScreen: YouTube 投稿フロー", () => {
	it("投稿用レンダリング(publish 品質)→ youtube_publish_start(メタデータ付き)→ 進捗 → done で「完了」になる", async () => {
		await setUpConnectedYoutube();
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openYoutubePublishButton(user);
		await waitFor(() => expect(publishButton).toBeEnabled());

		// タイトル/説明(UploadOutput のメタデータ)を入力してから投稿する。
		await user.type(screen.getByLabelText("タイトル"), "ライブ切り抜き#1");
		await user.type(screen.getByLabelText("説明"), "バンドのライブ映像");
		await user.click(publishButton);

		// 1. 投稿用レンダリング(preview_start, quality:"publish" = 本書き出しと同一品質
		//    8Mbps・publish-cache)が走る(IG と同じ経路、§usePublishExtras)。
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith(
				"preview_start",
				expect.objectContaining({
					input: SOURCE.inputPath,
					quality: "publish",
				}),
			),
		);
		const previewCallIndex = mockInvoke.mock.calls.findIndex(
			([cmd]) => cmd === "preview_start",
		);
		emitMockEvent(`preview://done/${invokeJobId(previewCallIndex)}`, {
			path: "/publish-cache/out.mp4",
		});

		// 2. youtube_publish_start が 8Mbps 生成物のパス・タイトル・説明付きで呼ばれる
		//    (予約日時未設定のため publishAt は null = 即時アップロード)。
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith(
				"youtube_publish_start",
				expect.objectContaining({
					inputPath: "/publish-cache/out.mp4",
					title: "ライブ切り抜き#1",
					description: "バンドのライブ映像",
					publishAt: null,
				}),
			),
		);
		const ytCallIndex = mockInvoke.mock.calls.findIndex(
			([cmd]) => cmd === "youtube_publish_start",
		);
		const ytJobId = invokeJobId(ytCallIndex);

		// 3. アップロード進捗がステータスバッジに反映される。
		emitMockEvent(`youtube_publish://progress/${ytJobId}`, {
			phase: "uploading",
			bytesSent: 42,
			totalBytes: 100,
			percent: 42,
		});
		await waitFor(() =>
			expect(screen.getByText(/アップロード中 42%/)).toBeInTheDocument(),
		);

		// 4. done で「完了」。
		emitMockEvent(`youtube_publish://done/${ytJobId}`, {
			videoId: "video-abc",
			status: "private",
		});
		await waitFor(() => expect(screen.getByText("完了")).toBeInTheDocument());
	});

	it("認可エラー(not_authorized)は再接続を促すメッセージとして表示される", async () => {
		await setUpConnectedYoutube();
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openYoutubePublishButton(user);
		await waitFor(() => expect(publishButton).toBeEnabled());
		await user.type(screen.getByLabelText("タイトル"), "t");
		await user.click(publishButton);

		const previewCallIndex = await waitFor(() => {
			const index = mockInvoke.mock.calls.findIndex(
				([cmd]) => cmd === "preview_start",
			);
			expect(index).toBeGreaterThanOrEqual(0);
			return index;
		});
		emitMockEvent(`preview://done/${invokeJobId(previewCallIndex)}`, {
			path: "/cache/out.mp4",
		});

		const ytCallIndex = await waitFor(() => {
			const index = mockInvoke.mock.calls.findIndex(
				([cmd]) => cmd === "youtube_publish_start",
			);
			expect(index).toBeGreaterThanOrEqual(0);
			return index;
		});
		emitMockEvent(`youtube_publish://error/${invokeJobId(ytCallIndex)}`, {
			kind: "not_authorized",
		});

		await waitFor(() =>
			expect(
				screen.getByText(/YouTube の認可が無効です/),
			).toBeInTheDocument(),
		);
	});

	it("予約日時を設定すると publishAt(unix ms)が youtube_publish_start へ伝搬する", async () => {
		await setUpConnectedYoutube();
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openYoutubePublishButton(user);
		await waitFor(() => expect(publishButton).toBeEnabled());
		await user.type(screen.getByLabelText("タイトル"), "予約テスト");

		// PostDetail 側の「投稿設定(予約日時・一括投稿)」を開いて予約日時を入力する。
		await user.click(
			screen.getByRole("button", { name: /予約日時・一括投稿/ }),
		);
		const datetimeInput = screen.getByLabelText(/予約日時/);
		await user.clear(datetimeInput);
		await user.type(datetimeInput, "2026-07-20T12:00");

		await user.click(publishButton);

		const previewCallIndex = await waitFor(() => {
			const index = mockInvoke.mock.calls.findIndex(
				([cmd]) => cmd === "preview_start",
			);
			expect(index).toBeGreaterThanOrEqual(0);
			return index;
		});
		emitMockEvent(`preview://done/${invokeJobId(previewCallIndex)}`, {
			path: "/cache/out.mp4",
		});

		// localInputToMs(§lib/schedule.ts)と同じ解釈(ローカルタイムゾーン)。
		const expectedMs = new Date("2026-07-20T12:00").getTime();
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith(
				"youtube_publish_start",
				expect.objectContaining({ publishAt: expectedMs }),
			),
		);
	});

	it("タイトル未入力は投稿用レンダリングの前に弾かれる(preview_start は呼ばれない)", async () => {
		await setUpConnectedYoutube();
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openYoutubePublishButton(user);
		await waitFor(() => expect(publishButton).toBeEnabled());

		// タイトルを入力せずに投稿する。
		await user.click(publishButton);

		await waitFor(() =>
			expect(screen.getByText(/タイトルは必須です/)).toBeInTheDocument(),
		);
		expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "preview_start")).toBe(
			false,
		);
		expect(
			mockInvoke.mock.calls.some(([cmd]) => cmd === "youtube_publish_start"),
		).toBe(false);
	});

	it("同期エラー(invoke reject)はエラーステータスとして表示される", async () => {
		await setUpConnectedYoutube();
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openYoutubePublishButton(user);
		await waitFor(() => expect(publishButton).toBeEnabled());
		await user.type(screen.getByLabelText("タイトル"), "t");

		// youtube_publish_start のみ reject させる(ファイル不在等は Rust 側で
		// ジョブ開始前に同期 Err として返る、§commands/publish/youtube.rs)。
		const defaultImpl = mockInvoke.getMockImplementation();
		mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
			if (cmd === "youtube_publish_start") {
				throw new Error("ファイルが見つかりません: /cache/out.mp4");
			}
			return defaultImpl?.(cmd, args);
		});

		await user.click(publishButton);

		const previewCallIndex = await waitFor(() => {
			const index = mockInvoke.mock.calls.findIndex(
				([cmd]) => cmd === "preview_start",
			);
			expect(index).toBeGreaterThanOrEqual(0);
			return index;
		});
		emitMockEvent(`preview://done/${invokeJobId(previewCallIndex)}`, {
			path: "/cache/out.mp4",
		});

		await waitFor(() =>
			expect(screen.getByText(/ファイルが見つかりません/)).toBeInTheDocument(),
		);
	});
});
