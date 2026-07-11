import { useState } from "react";
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

/**
 * 実運用(App.tsx)は clips を親(App)が state で持ち、ClipEditor 側の変更で
 * setClips するだけで UploadScreen 自身は再マウントされない。この Harness は
 * その「親から渡される clips が変わる」状況をテスト側から直接再現する
 * (ExportScreen.test.tsx の Harness と同じ考え方)。
 */
function Harness({ initialClips }: { initialClips: Clip[] }) {
	const [clips, setClips] = useState(initialClips);
	return (
		<div>
			<UploadScreen
				active
				source={SOURCE}
				clips={clips}
				resetToken={0}
				onGoToExport={() => {}}
			/>
			<button
				type="button"
				onClick={() =>
					setClips((prev) =>
						prev.map((c) =>
							c.id === "clip-1" ? { ...c, trim: { start: 1, end: c.trim.end } } : c,
						),
					)
				}
			>
				mutate-clip-1-trim
			</button>
			<button
				type="button"
				onClick={() => setClips((prev) => prev.filter((c) => c.id !== "clip-b"))}
			>
				remove-clip-b
			</button>
		</div>
	);
}

/**
 * outputSig(finalSpec に効く clip.trim/crop/aspect を含める修正)の固定テスト。
 * 以前は post.clipId + targetId + fit のみを sig にしていたため、ターゲット/フィットを
 * 変えずに clip 側(トリム/クロップ/アスペクト)だけ編集しても「要更新」にならず、
 * 古い(編集前の内容の)プレビューがそのまま「最新」として表示され続けていた。
 */
describe("UploadScreen: outputSig は clip の trim/crop/aspect を反映する", () => {
	it("プレビュー生成後に clip の trim を変更すると「要更新」表示になる", async () => {
		const user = userEvent.setup();
		renderWithProviders(<Harness initialClips={[CLIP]} />);

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "プレビュー生成" })).toBeInTheDocument(),
		);
		await user.click(screen.getByRole("button", { name: "プレビュー生成" }));

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith(
				"preview_start",
				expect.objectContaining({ input: SOURCE.inputPath }),
			),
		);
		const callIndex = mockInvoke.mock.calls.findIndex(
			([cmd]) => cmd === "preview_start",
		);
		const jobId = await mockInvoke.mock.results[callIndex]?.value;
		emitMockEvent(`preview://done/${jobId}`, { path: "/cache/out.mp4" });

		// 生成直後は最新(要更新表示なし)。
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "プレビュー更新" })).toBeInTheDocument(),
		);
		expect(screen.queryByText("(要更新)")).not.toBeInTheDocument();

		// clip 側(ターゲット/フィットは変えず trim のみ)を編集する
		// (App では ClipEditor の Timeline 操作に相当)。
		await user.click(screen.getByRole("button", { name: "mutate-clip-1-trim" }));

		// finalSpec に効く変更のため、Output 側の設定(target/fit)は何も変えていなくても
		// 「要更新」になる。
		await waitFor(() => expect(screen.getByText("(要更新)")).toBeInTheDocument());
	});
});

/**
 * 孤児 post の無効化(ExportScreen.tsx の clip 単位の細粒度無効化 effect が手本)。
 * clip 削除後も参照切れの post が残り続け、「対象 clip 不明」のまま操作可能に見えて
 * しまっていた P1 バグの固定テスト。
 */
describe("UploadScreen: 孤児 post の無効化", () => {
	it("clip が削除されると、その clip を参照する post が一覧から消える", async () => {
		const user = userEvent.setup();
		const clipA: Clip = {
			id: "clip-1",
			name: "ClipOne",
			trim: { start: 0, end: 5 },
			aspect: "free",
		};
		const clipB: Clip = {
			id: "clip-b",
			name: "ClipTwo",
			trim: { start: 0, end: 5 },
			aspect: "free",
		};
		renderWithProviders(<Harness initialClips={[clipA, clipB]} />);

		// 2 clip 分の post が自動生成されるのを待つ。
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /ClipTwo/ })).toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: /ClipOne/ })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "remove-clip-b" }));

		// clip-b を参照する post だけが除去され、clip-a の post は残る。
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /ClipTwo/ })).not.toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: /ClipOne/ })).toBeInTheDocument();
	});
});
