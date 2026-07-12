import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/render";
import { mockOpenPath, mockRevealItemInDir } from "../../test/tauri-mock";
import type { ReframeTaskState } from "../../lib/useReframeQueue";
import { ExportDetail } from "./ExportDetail";

const DONE_TASK: ReframeTaskState = {
	status: "done",
	ratio: 1,
	outputPath: "/out/clipA.mp4",
};

describe("ExportDetail: 完了表示のアクション化(UX変更2 — インライン video 埋め込みの廃止)", () => {
	it("status=done でもインライン video は描画されず、再生/フォルダで表示ボタンが出る", () => {
		renderWithProviders(<ExportDetail task={DONE_TASK} dirty={false} />);

		expect(document.querySelector("video")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "再生" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "フォルダで表示" })).toBeInTheDocument();
	});

	it("「再生」ボタンは出力ファイルパスで openPath(OS 既定のプレーヤー起動)を呼ぶ", async () => {
		const user = userEvent.setup();
		renderWithProviders(<ExportDetail task={DONE_TASK} dirty={false} />);

		await user.click(screen.getByRole("button", { name: "再生" }));
		await waitFor(() => expect(mockOpenPath).toHaveBeenCalledWith("/out/clipA.mp4"));
		expect(mockRevealItemInDir).not.toHaveBeenCalled();
	});

	it("「フォルダで表示」ボタンは出力ファイルパスで revealItemInDir を呼ぶ", async () => {
		const user = userEvent.setup();
		renderWithProviders(<ExportDetail task={DONE_TASK} dirty={false} />);

		await user.click(screen.getByRole("button", { name: "フォルダで表示" }));
		await waitFor(() =>
			expect(mockRevealItemInDir).toHaveBeenCalledWith("/out/clipA.mp4"),
		);
		expect(mockOpenPath).not.toHaveBeenCalled();
	});

	it("openPath が失敗した場合はエラーメッセージを表示する", async () => {
		const user = userEvent.setup();
		mockOpenPath.mockRejectedValueOnce(new Error("開けませんでした(テスト)"));
		renderWithProviders(<ExportDetail task={DONE_TASK} dirty={false} />);

		await user.click(screen.getByRole("button", { name: "再生" }));
		await waitFor(() => {
			expect(screen.getByText(/開けませんでした\(テスト\)/)).toBeInTheDocument();
		});
	});

	it("同名 clip の重複回避で実ファイル名が変わっている場合、clip.name ではなく実際の出力ファイル名を表示する", () => {
		// 同名 clip が複数あると uniqueBaseNames で 2 件目以降に "-2" 等が付く
		// (ExportScreen.test.tsx の「書き出しファイル名の重複回避」参照)。完了表示の
		// ファイル名は clip.name.mp4 ではなく実際の task.outputPath の basename を出す。
		const task: ReframeTaskState = {
			status: "done",
			ratio: 1,
			outputPath: "/out/clipA-2.mp4",
		};
		renderWithProviders(<ExportDetail task={task} dirty={false} />);

		expect(screen.getByText("clipA-2.mp4")).toBeInTheDocument();
	});
});

describe("ExportDetail: 失敗(error)表示", () => {
	it("error のときは失敗理由と、右の一覧の「再試行」を案内する文言を表示する(自動リトライは廃止済み)", () => {
		const task: ReframeTaskState = {
			status: "error",
			ratio: 0,
			error: "OutputBusy",
		};
		renderWithProviders(<ExportDetail task={task} dirty={false} />);

		expect(screen.getByText("OutputBusy")).toBeInTheDocument();
		expect(screen.getByText(/再試行/)).toBeInTheDocument();
	});
});

describe("ExportDetail: task 未確定時はカードではなく1行のプレースホルダのみを表示する", () => {
	it("dirty=false(新規未書き出し)のときは「未書き出し」を表示し、進捗バー等のカード要素は出さない", () => {
		renderWithProviders(<ExportDetail task={undefined} dirty={false} />);
		expect(screen.getByText(/未書き出し/)).toBeInTheDocument();
		// カード枠(進捗バー/完了アクション等)は task が無い間は描画されない。
		expect(screen.queryByRole("button", { name: "再生" })).not.toBeInTheDocument();
	});

	it("dirty=true(編集による要再書き出し)のときは「要再書き出し」を表示する", () => {
		renderWithProviders(<ExportDetail task={undefined} dirty={true} />);
		expect(screen.getByText(/要再書き出し/)).toBeInTheDocument();
	});
});
