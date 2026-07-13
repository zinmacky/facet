import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "./test/render";

/**
 * `EDITION` を "public" に固定してエディション出し分けを検証する(既定の
 * App.test.tsx は private を前提に挙動を確認しているため、こちらは public 版固有の
 * 差分のみを見る)。vi.mock はファイル内で巻き上げられるため、`./App` の import より
 * 前に書く必要は無い。
 *
 * 注意: ウィザードの step 構成(編集/確認/リフレーム)自体は両エディション共通
 * (§features/wizard/WizardShell.tsx の `WIZARD_STEPS`)になったため、v2.4 時点の
 * 「public は2 step」テストはここでは検証しない(そもそもそういう分岐が無くなった)。
 * また `virtual:upload-entry`(App.tsx がリフレーム画面を読み込む先)は
 * vitest.config.ts が常に private 実体へ alias する(§vitest.config.ts コメント)ため、
 * この EDITION モックだけではリフレーム画面の中身(投稿系スロットの有無)は
 * 切り替わらない — public のリフレーム画面(投稿系 UI が無いこと)は
 * `features/upload/ReframeScreen.public.test.tsx` が `entry.public.ts` を直接
 * import して検証する。
 */
vi.mock("./lib/edition", () => ({
	EDITION: "public",
	isPublicEdition: true,
}));

import { App } from "./App";

function stepNav() {
	return within(screen.getByRole("navigation", { name: "編集ステップ" }));
}

describe("App: public エディション", () => {
	it("ウィザードは編集/確認/リフレームの3ステップ(2 step への分岐は撤去済み)", () => {
		renderWithProviders(<App />);

		const nav = stepNav();
		expect(nav.getByRole("button", { name: /編集/ })).toBeInTheDocument();
		expect(nav.getByRole("button", { name: /確認/ })).toBeInTheDocument();
		expect(nav.getByRole("button", { name: /リフレーム/ })).toBeInTheDocument();
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
