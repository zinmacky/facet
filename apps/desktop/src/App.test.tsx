import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { renderWithProviders } from "./test/render";
import { emitMockEvent, mockDialogOpen, mockInvoke } from "./test/tauri-mock";

function reframeStartCalls() {
	return mockInvoke.mock.calls.filter(([cmd]) => cmd === "reframe_start");
}

/** ヘッダの StepIndicator(`<nav aria-label="編集ステップ">`)へスコープした操作。 */
function stepNav() {
	return within(screen.getByRole("navigation", { name: "編集ステップ" }));
}

async function goToStep(user: ReturnType<typeof userEvent.setup>, label: string) {
	await user.click(stepNav().getByRole("button", { name: new RegExp(label) }));
}

/**
 * OutputCard 内の「投稿設定」折りたたみ(メタデータ入力欄)を開く。
 * PostDetail 側にも同名を含む別の折りたたみ(「投稿設定(予約日時・一括投稿)」)が
 * あるため、"予約日時" を含まない方をこちらの対象として区別する。
 */
async function expandOutputSettings(user: ReturnType<typeof userEvent.setup>) {
	const toggle = await waitFor(() => {
		const found = screen
			.getAllByRole("button")
			.find(
				(el) =>
					/投稿設定/.test(el.textContent ?? "") && !/予約日時/.test(el.textContent ?? ""),
			);
		if (!found) throw new Error("output settings disclosure toggle not found");
		return found;
	});
	await user.click(toggle);
}

/** 「元動画を選択」→ probe 成功 → 1本目の clip 自動作成、までを行う。 */
async function pickSource(user: ReturnType<typeof userEvent.setup>, path: string) {
	mockDialogOpen.mockResolvedValueOnce(path);
	await user.click(screen.getByRole("button", { name: "元動画を選択" }));
	await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("probe", { path }));
}

/**
 * ウィザードの状態保持(PR #33 のリグレッション固定)。
 * 3画面(edit/export/upload)は常時マウントされたまま CSS スライドで切り替わるため、
 * 画面往復では ExportScreen の results / UploadScreen の posts・入力値は消えない。
 * 新しい元動画を選択したとき(resetToken 増分)だけ明示的に破棄される。
 */
describe("App: ウィザードの状態保持", () => {
	it("export の結果・upload の入力値は画面往復で保持され、新しい元動画選択でのみ破棄される", async () => {
		const user = userEvent.setup();
		renderWithProviders(<App />);

		await pickSource(user, "/video1.mp4");

		// edit → export(1 clip があるので前進できる)。
		await user.click(screen.getByRole("button", { name: /すべて書き出し/ }));
		expect(stepNav().getByRole("button", { name: /書き出し/ })).toHaveAttribute(
			"aria-current",
			"step",
		);

		// 書き出しを開始し、1 clip 分のジョブを完了させる。
		mockDialogOpen.mockResolvedValueOnce("/out");
		await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));
		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		await waitFor(() => expect(screen.getByText("完了")).toBeInTheDocument());

		// export → upload。既定 Post(1 出力: yt-shorts/crop)が自動生成される。
		await goToStep(user, "アップロード");
		await expandOutputSettings(user);
		const titleField = await screen.findByLabelText<HTMLInputElement>("タイトル", {
			selector: "input",
		});
		await user.type(titleField, "テストタイトル");
		expect(titleField).toHaveValue("テストタイトル");

		// upload → export → edit → export → upload と往復しても、結果・入力値は消えない。
		await goToStep(user, "書き出し");
		expect(screen.getByText("完了")).toBeInTheDocument();
		await goToStep(user, "編集");
		await goToStep(user, "書き出し");
		expect(screen.getByText("完了")).toBeInTheDocument();
		await goToStep(user, "アップロード");
		expect(
			await screen.findByLabelText<HTMLInputElement>("タイトル", { selector: "input" }),
		).toHaveValue("テストタイトル");
		// 往復のあいだ、書き出しジョブは再起動されていない(1 回のみ)。
		expect(reframeStartCalls()).toHaveLength(1);

		// 新しい元動画を選択する(resetToken 増分)と、export の結果・upload の入力値は
		// 明示的に破棄される。
		await goToStep(user, "編集");
		await pickSource(user, "/video2.mp4");

		await goToStep(user, "書き出し");
		expect(screen.queryByText("完了")).not.toBeInTheDocument();
		await goToStep(user, "アップロード");
		// resetToken で posts が作り直されたため Output も新規インスタンス
		// (折りたたみの開閉状態はリセットされている)。改めて開く。
		await expandOutputSettings(user);
		const freshTitleField = await screen.findByLabelText<HTMLInputElement>("タイトル", {
			selector: "input",
		});
		expect(freshTitleField).toHaveValue("");
	});
});

/**
 * a11y: ステップ遷移時、遷移先パネルの見出しへフォーカスが移ることの固定テスト。
 * 各パネルは sr-only の見出し(`wizard-panel-heading-${step}`)を持ち、
 * goToStep 経由の遷移のたびにそこへフォーカスする(初回マウント時は除く)。
 */
describe("App: ステップ遷移時のフォーカス移動(a11y)", () => {
	it("edit → export → upload と遷移するたびに遷移先パネルの見出しへフォーカスする", async () => {
		const user = userEvent.setup();
		renderWithProviders(<App />);

		await pickSource(user, "/video1.mp4");

		await user.click(screen.getByRole("button", { name: /すべて書き出し/ }));
		expect(screen.getByRole("heading", { name: "書き出し" })).toHaveFocus();

		await goToStep(user, "アップロード");
		expect(screen.getByRole("heading", { name: "アップロード" })).toHaveFocus();

		await goToStep(user, "編集");
		expect(screen.getByRole("heading", { name: "編集" })).toHaveFocus();
	});
});
