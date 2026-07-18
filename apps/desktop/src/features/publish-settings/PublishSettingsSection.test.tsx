import type { ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { render as testingLibraryRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockInvoke } from "../../test/tauri-mock";
import { PublishGateProvider } from "./PublishGateContext";
import { PublishSettingsSection } from "./PublishSettingsSection";

/**
 * `PublishSettingsSection` は `useSettings`/`useConfirm` に依存しないため
 * `renderWithProviders`(`test/render.tsx`)は不要だが、`usePublishGateContext()` を
 * 使うため `PublishGateProvider` では包む必要がある(Provider 外での呼び出しは
 * 例外を投げる、§PublishGateContext.tsx)。
 * scheduler URL は GHSA-j74q-9v5x-87w3 対応で invoke ベース(`tauri-mock.ts` の
 * インメモリ状態)へ変わったため、localStorage は旧キーからの移行テスト以外では
 * 触れない。念のため各テスト間で引きずらないようクリアする(SettingsDialog.test.tsx
 * と同じ方針)。
 */
beforeEach(() => {
	window.localStorage.clear();
});

function render(ui: ReactElement) {
	return testingLibraryRender(<PublishGateProvider>{ui}</PublishGateProvider>);
}

async function saveSchedulerUrl(
	user: ReturnType<typeof userEvent.setup>,
	url: string,
) {
	await user.type(screen.getByLabelText("scheduler URL"), url);
	await user.click(screen.getByRole("button", { name: "scheduler URLを保存" }));
}

async function saveToken(user: ReturnType<typeof userEvent.setup>, token: string) {
	await user.type(screen.getByLabelText("APIトークン"), token);
	await user.click(screen.getByRole("button", { name: "APIトークンを保存" }));
	await waitFor(() => expect(screen.getByText("保存済み")).toBeInTheDocument());
}

describe("PublishSettingsSection: scheduler URL", () => {
	it("入力して保存すると set_scheduler_url が呼ばれる", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);

		await saveSchedulerUrl(user, "https://scheduler.example.workers.dev");

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("set_scheduler_url", {
				url: "https://scheduler.example.workers.dev",
			}),
		);
	});

	it("旧 localStorage キーの URL は初回ゲートチェック時に移行され、疎通結果へ反映される", async () => {
		// 旧バージョンで URL 設定済みの既存ユーザーを再現する(§schedulerUrlStore.ts の
		// 一回性移行)。設定ダイアログを開かなくても、PublishGateProvider マウント時の
		// 初回 recheck が移行を先に走らせるため、no_url ではなく no_token 側になる。
		window.localStorage.setItem(
			"facet.desktop.private.schedulerUrl",
			"https://legacy.example.workers.dev",
		);
		render(<PublishSettingsSection />);

		await waitFor(() =>
			expect(screen.getByText("トークン未設定")).toBeInTheDocument(),
		);
		expect(mockInvoke).toHaveBeenCalledWith("set_scheduler_url", {
			url: "https://legacy.example.workers.dev",
		});
		// 移行後、旧キーは削除される(再実行は no-op)。
		expect(
			window.localStorage.getItem("facet.desktop.private.schedulerUrl"),
		).toBeNull();
		// 表示用の入力欄にも移行済みの URL がロードされる。
		await waitFor(() =>
			expect(
				screen.getByDisplayValue("https://legacy.example.workers.dev"),
			).toBeInTheDocument(),
		);
	});

	it("不正な URL を保存しようとするとエラーメッセージを表示する", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);

		// マウント時の自動疎通チェック一巡(初期表示「scheduler URL 未設定」)が
		// 完了するのを待ってから、次の1回(= 保存ボタン押下で呼ばれる
		// set_scheduler_url)だけを失敗させる。
		await waitFor(() =>
			expect(screen.getByText("scheduler URL 未設定")).toBeInTheDocument(),
		);
		mockInvoke.mockImplementationOnce(async () => {
			throw new Error(
				"http:// はループバック(localhost)のみ許可されます。リモートの scheduler には https:// を使ってください。",
			);
		});
		await saveSchedulerUrl(user, "http://evil.example.com");

		await waitFor(() =>
			expect(
				screen.getByText(/ループバック\(localhost\)のみ許可されます/),
			).toBeInTheDocument(),
		);
	});
});

describe("PublishSettingsSection: APIトークン", () => {
	it("初期状態は未保存(入力欄が表示される)", () => {
		render(<PublishSettingsSection />);
		expect(screen.getByLabelText("APIトークン")).toBeInTheDocument();
		expect(screen.queryByText("保存済み")).not.toBeInTheDocument();
	});

	it("保存すると set_scheduler_api_token が呼ばれ、値を再表示せず「保存済み」表示になる", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);

		await saveToken(user, "sekret-token");

		expect(mockInvoke).toHaveBeenCalledWith("set_scheduler_api_token", {
			token: "sekret-token",
		});
		// 値そのものは画面上どこにも再表示されない。
		expect(screen.queryByDisplayValue("sekret-token")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("APIトークン")).not.toBeInTheDocument();
	});

	it("削除すると delete_scheduler_api_token が呼ばれ、入力欄に戻る", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);

		await saveToken(user, "sekret-token");

		await user.click(screen.getByRole("button", { name: "削除" }));

		await waitFor(() =>
			expect(screen.getByLabelText("APIトークン")).toBeInTheDocument(),
		);
		expect(mockInvoke).toHaveBeenCalledWith("delete_scheduler_api_token");
	});

	it("トークン保存に失敗するとエラーメッセージを表示する", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);
		// マウント時の自動疎通チェック(has_scheduler_api_token)が既定実装で完了するのを
		// 待ってから、次の1回(= 保存ボタン押下で呼ばれる set_scheduler_api_token)だけを
		// 失敗させる(mockInvoke はコマンド名を問わず多重化されているため、呼び出し順で
		// 差し替える)。
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("has_scheduler_api_token"),
		);
		mockInvoke.mockImplementationOnce(async () => {
			throw new Error("boom");
		});

		await user.type(screen.getByLabelText("APIトークン"), "sekret-token");
		await user.click(screen.getByRole("button", { name: "APIトークンを保存" }));

		await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
	});
});

describe("PublishSettingsSection: 疎通チェック", () => {
	it("URL 未設定では「scheduler URL 未設定」を表示する", async () => {
		render(<PublishSettingsSection />);
		await waitFor(() =>
			expect(screen.getByText("scheduler URL 未設定")).toBeInTheDocument(),
		);
	});

	it("URL のみ設定・トークン未設定では「トークン未設定」を表示する", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);

		await saveSchedulerUrl(user, "https://scheduler.example.workers.dev");

		await waitFor(() =>
			expect(screen.getByText("トークン未設定")).toBeInTheDocument(),
		);
	});

	it("疎通チェックボタンを押すと check_scheduler_connection が呼ばれ、成功時は「接続OK」を表示する", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);

		await saveSchedulerUrl(user, "https://scheduler.example.workers.dev");
		await saveToken(user, "sekret-token");

		await user.click(screen.getByRole("button", { name: "疎通チェック" }));

		await waitFor(() => expect(screen.getByText("接続OK")).toBeInTheDocument());
		expect(mockInvoke).toHaveBeenCalledWith("check_scheduler_connection");
	});

	it("認証エラー(401 相当)の場合は理由を表示する", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);

		await saveSchedulerUrl(user, "https://scheduler.example.workers.dev");
		await saveToken(user, "wrong-token");

		// 「疎通チェック」ボタンの recheck() は has_scheduler_api_token →
		// get_scheduler_url(移行の副作用のための読み出し、§usePublishGate.ts)→
		// check_scheduler_connection の順で invoke するため、3回分をこの順で差し替える。
		mockInvoke.mockImplementationOnce(async () => true);
		mockInvoke.mockImplementationOnce(
			async () => "https://scheduler.example.workers.dev",
		);
		mockInvoke.mockImplementationOnce(async () => ({ status: "unauthorized" }));
		await user.click(screen.getByRole("button", { name: "疎通チェック" }));

		await waitFor(() =>
			expect(
				screen.getByText("認証エラー(トークンが一致しません)"),
			).toBeInTheDocument(),
		);
	});
});

/** OAuth クライアント(client_id/secret)を入力して保存する。 */
async function saveYoutubeClient(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByLabelText("YouTubeクライアントID"), "client-id");
	await user.type(
		screen.getByLabelText("YouTubeクライアントシークレット"),
		"client-secret",
	);
	await user.click(
		screen.getByRole("button", { name: "YouTubeクライアントを保存" }),
	);
	await waitFor(() => expect(screen.getByText("未接続")).toBeInTheDocument());
}

describe("PublishSettingsSection: YouTube(Google OAuth)", () => {
	it("初期状態は未設定(クライアント入力欄が表示される)", () => {
		render(<PublishSettingsSection />);
		expect(screen.getByLabelText("YouTubeクライアントID")).toBeInTheDocument();
		expect(
			screen.getByLabelText("YouTubeクライアントシークレット"),
		).toBeInTheDocument();
	});

	it("クライアントを保存すると set_youtube_oauth_client が呼ばれ、値を再表示せず「未接続」+接続ボタン表示になる", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);

		await saveYoutubeClient(user);

		expect(mockInvoke).toHaveBeenCalledWith("set_youtube_oauth_client", {
			clientId: "client-id",
			clientSecret: "client-secret",
		});
		// 値そのものは画面上どこにも再表示されない。
		expect(screen.queryByDisplayValue("client-secret")).not.toBeInTheDocument();
		expect(
			screen.queryByLabelText("YouTubeクライアントID"),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Google と接続" }),
		).toBeInTheDocument();
	});

	it("「Google と接続」で youtube_oauth_connect が呼ばれ、成功すると「接続済み」+切断ボタンになる", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);

		await saveYoutubeClient(user);
		await user.click(screen.getByRole("button", { name: "Google と接続" }));

		await waitFor(() =>
			expect(screen.getByText("接続済み")).toBeInTheDocument(),
		);
		expect(mockInvoke).toHaveBeenCalledWith("youtube_oauth_connect");
		expect(screen.getByRole("button", { name: "切断" })).toBeInTheDocument();
		// ゲート表示も有効になる。
		expect(screen.getByText("有効", { selector: "span" })).toBeInTheDocument();
	});

	it("「切断」で youtube_oauth_disconnect が呼ばれ、「未接続」に戻る(クライアントは保持)", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);

		await saveYoutubeClient(user);
		await user.click(screen.getByRole("button", { name: "Google と接続" }));
		await waitFor(() =>
			expect(screen.getByText("接続済み")).toBeInTheDocument(),
		);

		await user.click(screen.getByRole("button", { name: "切断" }));

		await waitFor(() => expect(screen.getByText("未接続")).toBeInTheDocument());
		expect(mockInvoke).toHaveBeenCalledWith("youtube_oauth_disconnect");
		// クライアントは保持されるため入力欄には戻らない。
		expect(
			screen.queryByLabelText("YouTubeクライアントID"),
		).not.toBeInTheDocument();
	});

	it("「クライアント削除」で delete_youtube_oauth_client が呼ばれ、入力欄に戻る", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);

		await saveYoutubeClient(user);
		await user.click(screen.getByRole("button", { name: "クライアント削除" }));

		await waitFor(() =>
			expect(screen.getByLabelText("YouTubeクライアントID")).toBeInTheDocument(),
		);
		expect(mockInvoke).toHaveBeenCalledWith("delete_youtube_oauth_client");
	});

	it("接続に失敗するとエラーメッセージを表示する", async () => {
		const user = userEvent.setup();
		render(<PublishSettingsSection />);

		await saveYoutubeClient(user);
		const defaultImpl = mockInvoke.getMockImplementation();
		mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
			if (cmd === "youtube_oauth_connect") {
				throw new Error("認可がタイムアウトしました(5分)。もう一度お試しください。");
			}
			return defaultImpl?.(cmd, args);
		});

		await user.click(screen.getByRole("button", { name: "Google と接続" }));

		await waitFor(() =>
			expect(
				screen.getByText(/認可がタイムアウトしました/),
			).toBeInTheDocument(),
		);
		// 失敗後も「未接続」のまま。
		expect(screen.getByText("未接続")).toBeInTheDocument();
	});
});
