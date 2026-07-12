import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Clip } from "../../types";
import { renderWithProviders } from "../../test/render";
import { mockOpenPath, mockRevealItemInDir } from "../../test/tauri-mock";
import type { ReframeTaskState } from "../../lib/useReframeQueue";
import { ExportDetail } from "./ExportDetail";

function makeClip(): Clip {
	return {
		id: "clip-a",
		name: "clipA",
		trim: { start: 0, end: 10 },
		aspect: "free",
	};
}

const DONE_TASK: ReframeTaskState = {
	status: "done",
	ratio: 1,
	outputPath: "/out/clipA.mp4",
};

describe("ExportDetail: 完了表示のアクション化(UX変更2 — インライン video 埋め込みの廃止)", () => {
	it("status=done でもインライン video は描画されず、再生/フォルダで表示ボタンが出る", () => {
		renderWithProviders(<ExportDetail clip={makeClip()} task={DONE_TASK} dirty={false} />);

		expect(document.querySelector("video")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "再生" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "フォルダで表示" })).toBeInTheDocument();
	});

	it("「再生」ボタンは出力ファイルパスで openPath(OS 既定のプレーヤー起動)を呼ぶ", async () => {
		const user = userEvent.setup();
		renderWithProviders(<ExportDetail clip={makeClip()} task={DONE_TASK} dirty={false} />);

		await user.click(screen.getByRole("button", { name: "再生" }));
		await waitFor(() => expect(mockOpenPath).toHaveBeenCalledWith("/out/clipA.mp4"));
		expect(mockRevealItemInDir).not.toHaveBeenCalled();
	});

	it("「フォルダで表示」ボタンは出力ファイルパスで revealItemInDir を呼ぶ", async () => {
		const user = userEvent.setup();
		renderWithProviders(<ExportDetail clip={makeClip()} task={DONE_TASK} dirty={false} />);

		await user.click(screen.getByRole("button", { name: "フォルダで表示" }));
		await waitFor(() =>
			expect(mockRevealItemInDir).toHaveBeenCalledWith("/out/clipA.mp4"),
		);
		expect(mockOpenPath).not.toHaveBeenCalled();
	});

	it("openPath が失敗した場合はエラーメッセージを表示する", async () => {
		const user = userEvent.setup();
		mockOpenPath.mockRejectedValueOnce(new Error("開けませんでした(テスト)"));
		renderWithProviders(<ExportDetail clip={makeClip()} task={DONE_TASK} dirty={false} />);

		await user.click(screen.getByRole("button", { name: "再生" }));
		await waitFor(() => {
			expect(screen.getByText(/開けませんでした\(テスト\)/)).toBeInTheDocument();
		});
	});

	it("同名 clip の重複回避で実ファイル名が変わっている場合、clip.name ではなく実際の出力ファイル名を表示する", () => {
		// 同名 clip が複数あると uniqueBaseNames で 2 件目以降に "-2" 等が付く
		// (ExportScreen.test.tsx の「書き出しファイル名の重複回避」参照)。完了表示の
		// ファイル名は clip.name.mp4 ではなく実際の task.outputPath の basename を
		// 出すべき(上部見出しは編集対象 clip 名の表示であり別物 — ここでは変更しない)。
		const task: ReframeTaskState = {
			status: "done",
			ratio: 1,
			outputPath: "/out/clipA-2.mp4",
		};
		renderWithProviders(<ExportDetail clip={makeClip()} task={task} dirty={false} />);

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
		renderWithProviders(<ExportDetail clip={makeClip()} task={task} dirty={false} />);

		expect(screen.getByText("OutputBusy")).toBeInTheDocument();
		expect(screen.getByText(/再試行/)).toBeInTheDocument();
	});
});

describe("ExportDetail: task 未確定時の文言(自動再書き出し廃止に伴う正直な表示)", () => {
	it("dirty=false(新規未書き出し)のときは「未書き出し」を表示する", () => {
		renderWithProviders(
			<ExportDetail clip={makeClip()} task={undefined} dirty={false} />,
		);
		expect(screen.getByText(/未書き出し/)).toBeInTheDocument();
	});

	it("dirty=true(編集による要再書き出し)のときは「要再書き出し」を表示する", () => {
		renderWithProviders(
			<ExportDetail clip={makeClip()} task={undefined} dirty={true} />,
		);
		expect(screen.getByText(/要再書き出し/)).toBeInTheDocument();
	});
});
