import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/render";
import { mockDialogOpen } from "../../test/tauri-mock";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "../../lib/settings";
import { SettingsDialog } from "./SettingsDialog";

function storedSettings(): unknown {
	return JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null");
}

// 設定(useSettings)は localStorage 経由で読み出される。テスト間で永続化状態が
// 引き継がれないよう、各テストの前に必ずクリアする。
beforeEach(() => {
	window.localStorage.clear();
});

describe("SettingsDialog: 外観(テーマ)", () => {
	it("「ライト」を選ぶと html の .dark が外れ、localStorage に保存される", async () => {
		const user = userEvent.setup();
		renderWithProviders(<SettingsDialog open onClose={() => {}} />);

		await user.click(screen.getByRole("button", { name: "ライト" }));

		expect(document.documentElement.classList.contains("dark")).toBe(false);
		expect(storedSettings()).toEqual({ ...DEFAULT_SETTINGS, theme: "light" });
		expect(screen.getByRole("button", { name: "ライト" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	it("「ダーク」を選ぶと html に .dark が付く", async () => {
		const user = userEvent.setup();
		renderWithProviders(<SettingsDialog open onClose={() => {}} />);

		await user.click(screen.getByRole("button", { name: "ライト" }));
		await user.click(screen.getByRole("button", { name: "ダーク" }));

		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(storedSettings()).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });
	});
});

describe("SettingsDialog: 書き出し先", () => {
	it("フォルダを選択すると defaultExportDir が保存され、表示される", async () => {
		const user = userEvent.setup();
		renderWithProviders(<SettingsDialog open onClose={() => {}} />);

		expect(screen.getByText("毎回選択する(既定)")).toBeInTheDocument();

		mockDialogOpen.mockResolvedValueOnce("/exports/out");
		await user.click(screen.getByRole("button", { name: "フォルダを選択" }));

		await waitFor(() => {
			expect(screen.getByText("/exports/out")).toBeInTheDocument();
		});
		expect(storedSettings()).toEqual({
			...DEFAULT_SETTINGS,
			defaultExportDir: "/exports/out",
		});
	});

	it("「クリア」で defaultExportDir が null に戻る", async () => {
		const user = userEvent.setup();
		renderWithProviders(<SettingsDialog open onClose={() => {}} />);

		mockDialogOpen.mockResolvedValueOnce("/exports/out");
		await user.click(screen.getByRole("button", { name: "フォルダを選択" }));
		await waitFor(() => {
			expect(screen.getByText("/exports/out")).toBeInTheDocument();
		});

		await user.click(screen.getByRole("button", { name: "クリア" }));

		expect(screen.getByText("毎回選択する(既定)")).toBeInTheDocument();
		expect(storedSettings()).toEqual(DEFAULT_SETTINGS);
		expect(screen.queryByRole("button", { name: "クリア" })).not.toBeInTheDocument();
	});

	it("キャンセル(null)時は defaultExportDir を変更しない", async () => {
		const user = userEvent.setup();
		renderWithProviders(<SettingsDialog open onClose={() => {}} />);

		mockDialogOpen.mockResolvedValueOnce(null);
		await user.click(screen.getByRole("button", { name: "フォルダを選択" }));

		await waitFor(() => expect(mockDialogOpen).toHaveBeenCalled());
		expect(screen.getByText("毎回選択する(既定)")).toBeInTheDocument();
		expect(storedSettings()).toEqual(DEFAULT_SETTINGS);
	});

	it("「書き出し完了後にフォルダを開く」トグルが永続化される", async () => {
		const user = userEvent.setup();
		renderWithProviders(<SettingsDialog open onClose={() => {}} />);

		const checkbox = screen.getByRole("checkbox", {
			name: "書き出し完了後にフォルダを開く",
		});
		expect(checkbox).not.toBeChecked();

		await user.click(checkbox);

		expect(checkbox).toBeChecked();
		expect(storedSettings()).toEqual({
			...DEFAULT_SETTINGS,
			openFolderAfterExport: true,
		});
	});

	it("「書き出し完了時に通知する」トグルが永続化される", async () => {
		const user = userEvent.setup();
		renderWithProviders(<SettingsDialog open onClose={() => {}} />);

		const checkbox = screen.getByRole("checkbox", {
			name: "書き出し完了時に通知する",
		});
		expect(checkbox).not.toBeChecked();

		await user.click(checkbox);

		expect(checkbox).toBeChecked();
		expect(storedSettings()).toEqual({
			...DEFAULT_SETTINGS,
			notifyOnExportComplete: true,
		});
	});
});
