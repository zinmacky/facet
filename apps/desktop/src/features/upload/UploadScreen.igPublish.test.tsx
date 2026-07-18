import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Clip } from "../../types";
import { renderWithProviders } from "../../test/render";
import {
	DEFAULT_MEDIA_INFO,
	emitMockEvent,
	invokeJobId,
	mockEventListenerCount,
	mockInvoke,
	MOCK_IG_PUBLISH_DONE,
} from "../../test/tauri-mock";
import { UploadScreen } from "./UploadScreenPrivate";

/**
 * IG(Instagram)投稿フローのテスト(Phase 3 本体、§6.4)。
 *
 * - ゲート活性化条件: scheduler 疎通 OK + R2 資格情報保存済み(igReady)のときのみ
 *   Instagram 向け Output の投稿ボタンが有効になる(YouTube は引き続き disabled)。
 * - 投稿フロー: プレビュー生成(preview_start)→ ig_publish_start(listen-before-invoke)
 *   → 進捗(uploading %)→ done で「完了」。
 * - エラー分類: Rust 側の構造化 enum(kind タグ)がユーザー向けメッセージに変換される。
 */

const SOURCE = { inputPath: "/in.mp4", probe: DEFAULT_MEDIA_INFO };

const CLIP: Clip = {
	id: "clip-1",
	name: "ClipOne",
	trim: { start: 0, end: 5 },
	aspect: "free",
};

const SCHEDULER_URL = "https://scheduler.example.workers.dev";

beforeEach(() => {
	window.localStorage.clear();
});

/** ゲートが開く前提条件(scheduler URL + トークン + R2 資格情報)を作る。 */
async function setUpReadyGate() {
	// tauri-mock の defaultInvokeImpl のインメモリ状態を直接構築する
	// (render 前に呼ぶことで、PublishGateProvider のマウント時チェックが ready になる)。
	// scheduler URL は GHSA-j74q-9v5x-87w3 対応で invoke ベースへ変わった
	// (旧: localStorage 直接設定)。
	await mockInvoke("set_scheduler_url", { url: SCHEDULER_URL });
	await mockInvoke("set_scheduler_api_token", { token: "test-token" });
	await mockInvoke("set_r2_credentials", {
		accountId: "acc",
		accessKeyId: "key",
		secretAccessKey: "secret",
		bucket: "facet-media",
	});
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

/** 出力ターゲットを Instagram リールへ変更し、「投稿設定」を開いて投稿ボタンを返す。 */
async function openIgPublishButton(user: ReturnType<typeof userEvent.setup>) {
	await waitFor(() =>
		expect(screen.getByLabelText("出力ターゲット")).toBeInTheDocument(),
	);
	await user.selectOptions(screen.getByLabelText("出力ターゲット"), "ig-reels");
	await user.click(outputCardDisclosureButton());
	return screen.getByRole("button", { name: "投稿" });
}

/**
 * OutputCard に差し込まれる OutputPublishSection の「投稿設定」折りたたみトグル。
 * アクセシブルネームは「▶投稿設定<ステータス>」(trailing の StatusBadge を含む)に
 * なるため、初期ステータス「未投稿」で PostDetail に差し込まれる PostScheduleSection
 * 側の「投稿設定(予約日時・一括投稿)」と区別する(このヘルパは折りたたみを開く前 =
 * 未投稿のときにのみ使う)。
 */
function outputCardDisclosureButton() {
	return screen.getByRole("button", { name: /投稿設定.*未投稿/ });
}

describe("UploadScreen: IG 投稿のゲート活性化", () => {
	it("設定が未完了(igReady=false)の間は投稿ボタンが disabled", async () => {
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openIgPublishButton(user);
		expect(publishButton).toBeDisabled();
		// 案内バナーも表示される(YouTube 未設定バナーも並ぶため IG 側を特定する)。
		expect(
			screen.getByText(/Instagram\s*への投稿には設定(.*)が必要です/),
		).toBeInTheDocument();
	});

	it("scheduler 疎通 OK + R2 資格情報ありで Instagram の投稿ボタンが有効になる", async () => {
		await setUpReadyGate();
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openIgPublishButton(user);
		await waitFor(() => expect(publishButton).toBeEnabled());
	});

	it("ゲートが開いていても YouTube 向け Output の投稿ボタンは disabled のまま", async () => {
		await setUpReadyGate();
		const user = userEvent.setup();
		renderScreen();

		// 既定ターゲットは yt-shorts(YouTube)。ターゲットは変えずに投稿設定を開く。
		await waitFor(() =>
			expect(screen.getByLabelText("出力ターゲット")).toBeInTheDocument(),
		);
		await user.click(outputCardDisclosureButton());

		expect(screen.getByRole("button", { name: "投稿" })).toBeDisabled();
	});

	it("「すべて投稿」は投稿可能な Output が無い間 disabled、IG 出力があれば有効になる", async () => {
		await setUpReadyGate();
		const user = userEvent.setup();
		renderScreen();

		// 既定(yt-shorts のみ)では disabled。
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "すべて投稿" })).toBeDisabled(),
		);

		// IG ターゲットへ変更すると有効になる。
		await user.selectOptions(screen.getByLabelText("出力ターゲット"), "ig-reels");
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "すべて投稿" })).toBeEnabled(),
		);
	});
});

describe("UploadScreen: IG 投稿フロー", () => {
	it("投稿用レンダリング(publish 品質)→ ig_publish_start → 進捗 → done で「完了」になる", async () => {
		await setUpReadyGate();
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openIgPublishButton(user);
		await waitFor(() => expect(publishButton).toBeEnabled());
		await user.click(publishButton);

		// 1. 投稿用レンダリング(preview_start, quality:"publish" = 本書き出しと同一品質
		//    8Mbps・publish-cache)が走る。プレビュー品質(2Mbps)の動画が投稿される
		//    P1 問題の修正の固定。
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
		const previewJobId = invokeJobId(previewCallIndex);
		emitMockEvent(`preview://done/${previewJobId}`, {
			path: "/publish-cache/out.mp4",
		});

		// 2. ig_publish_start が投稿用レンダリング結果のパス・キャプション・scheduler URL
		//    付きで呼ばれる(publishAt 未設定のため即時 = Date.now() ベースの数値)。
		//    バリデーション(≤300MB 等)は Rust 側がこのパス(8Mbps 生成物)に対して
		//    アップロード前に行う(§commands/publish/ig.rs)。
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith(
				"ig_publish_start",
				expect.objectContaining({
					inputPath: "/publish-cache/out.mp4",
					caption: "",
					publishAt: expect.any(Number),
				}),
			),
		);
		const igCallIndex = mockInvoke.mock.calls.findIndex(
			([cmd]) => cmd === "ig_publish_start",
		);
		const igJobId = invokeJobId(igCallIndex);

		// 3. アップロード進捗がステータスバッジに反映される。
		emitMockEvent(`ig_publish://progress/${igJobId}`, {
			phase: "uploading",
			bytesSent: 42,
			totalBytes: 100,
			percent: 42,
		});
		await waitFor(() =>
			expect(screen.getByText(/アップロード中 42%/)).toBeInTheDocument(),
		);

		// 4. done で「完了」。
		emitMockEvent(`ig_publish://done/${igJobId}`, MOCK_IG_PUBLISH_DONE);
		await waitFor(() => expect(screen.getByText("完了")).toBeInTheDocument());
	});

	it("401(enqueue_unauthorized)はトークン無効のメッセージとして表示される", async () => {
		await setUpReadyGate();
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openIgPublishButton(user);
		await waitFor(() => expect(publishButton).toBeEnabled());
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

		const igCallIndex = await waitFor(() => {
			const index = mockInvoke.mock.calls.findIndex(
				([cmd]) => cmd === "ig_publish_start",
			);
			expect(index).toBeGreaterThanOrEqual(0);
			return index;
		});
		emitMockEvent(`ig_publish://error/${invokeJobId(igCallIndex)}`, {
			kind: "enqueue_unauthorized",
		});

		await waitFor(() =>
			expect(
				screen.getByText(/scheduler の API トークンが無効です/),
			).toBeInTheDocument(),
		);
	});

	it("バリデーション違反(invoke reject)はエラーステータスとして表示される", async () => {
		await setUpReadyGate();
		const user = userEvent.setup();
		renderScreen();

		const publishButton = await openIgPublishButton(user);
		await waitFor(() => expect(publishButton).toBeEnabled());

		// ig_publish_start のみ reject させる(バリデーション違反は Rust 側で
		// ジョブ開始前に同期 Err として返る、§commands/publish/ig.rs)。
		const defaultImpl = mockInvoke.getMockImplementation();
		mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
			if (cmd === "ig_publish_start") {
				throw new Error(
					"ファイルサイズが上限を超えています(310.0MB > 300MB)。Instagram の上限は300MBです。",
				);
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
			expect(
				screen.getByText(/ファイルサイズが上限を超えています/),
			).toBeInTheDocument(),
		);
	});
});

describe("UploadScreen: IG 投稿ジョブのライフサイクル(Issue #95, GHSA-rrgf-h689-w639)", () => {
	it("投稿中(ig_publish_start 後)にアンマウントすると、購読解除 + ig_publish_cancel が呼ばれる", async () => {
		await setUpReadyGate();
		const user = userEvent.setup();
		const { unmount } = renderScreen();

		const publishButton = await openIgPublishButton(user);
		await waitFor(() => expect(publishButton).toBeEnabled());
		await user.click(publishButton);

		const previewCallIndex = await waitFor(() => {
			const index = mockInvoke.mock.calls.findIndex(
				([cmd]) => cmd === "preview_start",
			);
			expect(index).toBeGreaterThanOrEqual(0);
			return index;
		});
		emitMockEvent(`preview://done/${invokeJobId(previewCallIndex)}`, {
			path: "/publish-cache/out.mp4",
		});

		const igCallIndex = await waitFor(() => {
			const index = mockInvoke.mock.calls.findIndex(
				([cmd]) => cmd === "ig_publish_start",
			);
			expect(index).toBeGreaterThanOrEqual(0);
			return index;
		});
		const igJobId = invokeJobId(igCallIndex);
		expect(igJobId).toBeDefined();
		await waitFor(() =>
			expect(mockEventListenerCount(`ig_publish://done/${igJobId}`)).toBe(1),
		);

		// 投稿(数十秒かかりうる)の途中でアンマウントする(旧実装は `.catch` のみで
		// ハンドルを握り潰しており、リスナ残留・キャンセル導線の欠如が起きていた)。
		unmount();

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("ig_publish_cancel", {
				jobId: igJobId,
			}),
		);
		// unsubscribe まで済んでいるので、購読は残らない。
		expect(mockEventListenerCount(`ig_publish://done/${igJobId}`)).toBe(0);

		// アンマウント後に done イベントが届いても(購読解除済みのため実際には配送
		// されないが)、念のため例外が起きない・setState されないことを確認する。
		expect(() =>
			emitMockEvent(`ig_publish://done/${igJobId}`, {
				schedulerJobId: "scheduler-job-1",
				status: "pending",
			}),
		).not.toThrow();
	});

	it("同一 output への再投稿(リトライ)は同じ jobId を ig_publish_start に渡す(idempotency_key 決定化との対、Issue #95)", async () => {
		await setUpReadyGate();
		const user = userEvent.setup();
		renderScreen();

		// 1 回目: enqueue_rejected で失敗させる。
		const publishButton = await openIgPublishButton(user);
		await waitFor(() => expect(publishButton).toBeEnabled());
		await user.click(publishButton);

		const firstPreviewIndex = await waitFor(() => {
			const index = mockInvoke.mock.calls.findIndex(
				([cmd]) => cmd === "preview_start",
			);
			expect(index).toBeGreaterThanOrEqual(0);
			return index;
		});
		emitMockEvent(`preview://done/${invokeJobId(firstPreviewIndex)}`, {
			path: "/publish-cache/out.mp4",
		});

		const firstIgIndex = await waitFor(() => {
			const index = mockInvoke.mock.calls.findIndex(
				([cmd]) => cmd === "ig_publish_start",
			);
			expect(index).toBeGreaterThanOrEqual(0);
			return index;
		});
		const firstJobId = invokeJobId(firstIgIndex);
		emitMockEvent(`ig_publish://error/${firstJobId}`, {
			kind: "enqueue_rejected",
			detail: "duplicate",
		});
		await waitFor(() =>
			expect(screen.getByText(/scheduler にジョブ登録を拒否されました/)).toBeInTheDocument(),
		);

		// 2 回目(リトライ): 前回の試行は done/error で終了済みなので、ボタンは
		// 再度有効になっている。投稿用レンダリングは sig 一致のキャッシュ再利用のため
		// preview_start は再発火しない(usePreview.ensure のキャッシュ挙動どおり)。
		await waitFor(() => expect(publishButton).toBeEnabled());
		await user.click(publishButton);

		await waitFor(() => {
			const calls = mockInvoke.mock.calls.filter(
				([cmd]) => cmd === "ig_publish_start",
			);
			expect(calls.length).toBe(2);
		});
		const secondJobId = mockInvoke.mock.calls.filter(
			([cmd]) => cmd === "ig_publish_start",
		)[1]?.[1] as { jobId: string };
		// output.id ごとに安定な jobId が再利用される(Rust 側の idempotency_key 決定化と対)。
		expect(secondJobId.jobId).toBe(firstJobId);
	});
});
