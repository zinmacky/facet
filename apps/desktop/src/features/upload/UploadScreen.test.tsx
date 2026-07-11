import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Clip } from "../../types";
import { renderWithProviders } from "../../test/render";
import {
	DEFAULT_MEDIA_INFO,
	emitMockEvent,
	mockDialogOpen,
	mockInvoke,
	mockJoin,
} from "../../test/tauri-mock";
import { UploadScreen } from "./UploadScreen";

const SOURCE = { inputPath: "/in.mp4", probe: DEFAULT_MEDIA_INFO };

// clip.name に Windows で無効な文字を含め、sanitizeFileName の適用も併せて確認する。
const CLIP: Clip = {
	id: "clip-1",
	name: "Clip:A",
	trim: { start: 0, end: 5 },
	aspect: "free",
};

function reframeStartCalls() {
	return mockInvoke.mock.calls.filter(([cmd]) => cmd === "reframe_start");
}

/**
 * ファイル名生成: `${sanitizeFileName(clip.name)}_${target.id}_${fit}.mp4`、
 * 同名衝突時は `-2` を付与する(bulkExportMutation の uniqueBaseName)。
 * 1 clip の Post に既定 Output(yt-shorts/crop)をもう 1 つ追加すると、
 * clip・ターゲット・フィットがすべて同一の Output が 2 つできるため衝突が起きる。
 */
describe("UploadScreen: 一括書き出しのファイル名組み立て", () => {
	it("clip 名を sanitize し、`名前_ターゲット_フィット.mp4` の形式で組み立てる。衝突時は -2 を付与する", async () => {
		const user = userEvent.setup();
		renderWithProviders(
			<UploadScreen
				active
				source={SOURCE}
				clips={[CLIP]}
				resetToken={0}
				onGoToExport={() => {}}
			/>,
		);

		// clips から既定 Post(Output 1 つ: yt-shorts/crop)が自動生成されるのを待つ。
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "+ 出力先を追加" })).toBeInTheDocument(),
		);
		await user.click(screen.getByRole("button", { name: "+ 出力先を追加" }));

		mockDialogOpen.mockResolvedValueOnce("/out");
		await user.click(screen.getByRole("button", { name: "フォルダへ一括書き出し" }));

		await waitFor(() => expect(reframeStartCalls()).toHaveLength(2));
		expect(mockJoin).toHaveBeenCalledWith("/out", "Clip_A_yt-shorts_crop.mp4");
		expect(mockJoin).toHaveBeenCalledWith("/out", "Clip_A_yt-shorts_crop-2.mp4");

		// ジョブを完了させて後始末する(pending のまま残さない)。
		const [job1, job2] = reframeStartCalls().map((_, i) => `job-${i + 1}`);
		emitMockEvent(`reframe://done/${job1}`, { encoder: "h264" });
		emitMockEvent(`reframe://done/${job2}`, { encoder: "h264" });
		await waitFor(() => expect(screen.getByText(/完了 2 \/ 2 件/)).toBeInTheDocument());
	});
});
