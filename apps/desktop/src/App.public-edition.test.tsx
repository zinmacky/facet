import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./test/render";
import { mockDialogOpen, mockInvoke } from "./test/tauri-mock";

/**
 * `EDITION` を "public" に固定してエディション出し分けを検証する(既定の
 * App.test.tsx は private を前提に現行3 step の挙動を確認しているため、こちらは
 * public 版固有の差分のみを見る)。vi.mock はファイル内で巻き上げられるため、
 * `./App` の import より前に書く必要は無い。
 */
vi.mock("./lib/edition", () => ({
	EDITION: "public",
	isPublicEdition: true,
}));

import { App } from "./App";

function stepNav() {
	return within(screen.getByRole("navigation", { name: "編集ステップ" }));
}

async function pickSource(user: ReturnType<typeof userEvent.setup>, path: string) {
	mockDialogOpen.mockResolvedValueOnce(path);
	await user.click(screen.getByRole("button", { name: "元動画を選択" }));
	await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("probe", { path }));
}

describe("App: public エディション(投稿系ステップ・導線の非表示)", () => {
	it("ウィザードのステップが編集/書き出しの2つのみで、アップロードのステップが存在しない", () => {
		renderWithProviders(<App />);

		const nav = stepNav();
		expect(nav.getByRole("button", { name: /編集/ })).toBeInTheDocument();
		expect(nav.getByRole("button", { name: /書き出し/ })).toBeInTheDocument();
		expect(
			nav.queryByRole("button", { name: /アップロード/ }),
		).not.toBeInTheDocument();
	});

	it("書き出し画面に「アップロードへ進む」ボタンが無い", async () => {
		const user = userEvent.setup();
		renderWithProviders(<App />);

		await pickSource(user, "/video1.mp4");
		await user.click(screen.getByRole("button", { name: /すべて書き出し/ }));

		expect(
			screen.queryByRole("button", { name: /アップロードへ進む/ }),
		).not.toBeInTheDocument();
	});

	it("起動時に updater の更新チェックを試みる(private では実行しない、§App.test.tsx との対比)", async () => {
		// jsdom には実 Tauri IPC が無いため check() は必ず失敗するが、それ自体が
		// 「更新チェックが起動された」ことの証跡になる(lib/updater.ts の catch は
		// 黙殺するだけで console.error は必ず呼ぶ)。
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		renderWithProviders(<App />);

		await waitFor(() =>
			expect(consoleError).toHaveBeenCalledWith(
				"[updater] check() failed (ignored):",
				expect.anything(),
			),
		);
		consoleError.mockRestore();
	});
});
