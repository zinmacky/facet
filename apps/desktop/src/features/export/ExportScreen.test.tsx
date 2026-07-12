import { useState } from "react";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Clip } from "../../types";
import { renderWithProviders } from "../../test/render";
import {
	DEFAULT_MEDIA_INFO,
	emitMockEvent,
	mockDialogOpen,
	mockEventListenerCount,
	mockInvoke,
	mockJoin,
} from "../../test/tauri-mock";
import { ExportScreen } from "./ExportScreen";

const SOURCE = { inputPath: "/in.mp4", probe: DEFAULT_MEDIA_INFO };

function makeClip(id: string, name: string, trimEnd: number): Clip {
	return { id, name, trim: { start: 0, end: trimEnd }, aspect: "free" };
}

/**
 * 実運用(App.tsx)は clips を親(App)が state で持ち、ClipEditor 側の変更で
 * setClips するだけで ExportScreen 自身は再マウントされない。この Harness は
 * その「親から渡される clips が変わる」状況をテスト側から直接再現する
 * (ClipEditor の Timeline/CropOverlay ドラッグ操作は経由しない — ExportScreen 自身の
 * clip 単位無効化ロジックの検証が目的なので、trim/crop の変更手段は問わない)。
 */
function Harness({ initialClips }: { initialClips: Clip[] }) {
	const [clips, setClips] = useState(initialClips);
	const [resetToken, setResetToken] = useState(0);
	return (
		<div>
			<ExportScreen
				active
				source={SOURCE}
				clips={clips}
				resetToken={resetToken}
				onGoToEdit={() => {}}
				onGoToUpload={() => {}}
			/>
			<button
				type="button"
				onClick={() =>
					setClips((prev) =>
						prev.map((c) =>
							c.id === "clip-a" ? { ...c, trim: { start: 1, end: c.trim.end } } : c,
						),
					)
				}
			>
				mutate-clip-a-trim
			</button>
			<button
				type="button"
				onClick={() => setClips((prev) => prev.filter((c) => c.id !== "clip-b"))}
			>
				remove-clip-b
			</button>
			<button type="button" onClick={() => setResetToken((t) => t + 1)}>
				bump-reset-token
			</button>
		</div>
	);
}

function reframeStartCalls() {
	return mockInvoke.mock.calls.filter(([cmd]) => cmd === "reframe_start");
}

async function startExport(user: ReturnType<typeof userEvent.setup>) {
	mockDialogOpen.mockResolvedValueOnce("/out");
	await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
	await waitFor(() => expect(reframeStartCalls()).toHaveLength(2));
}

/** 右側一覧の行(ExportListItem)を clip ファイル名で一意に取得する(中央詳細見出しは button でないため衝突しない)。 */
function listRow(fileName: string): HTMLElement {
	return screen.getByRole("button", { name: new RegExp(`^${fileName}`) });
}

describe("ExportScreen: clip 単位シグネチャ無効化(clipPreviewSig)", () => {
	it("1 clip の trim 変更はその clip の結果だけを破棄し、他 clip の結果は保持する", async () => {
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		const clipB = makeClip("clip-b", "clipB", 8);
		renderWithProviders(<Harness initialClips={[clipA, clipB]} />);

		await startExport(user);
		expect(mockJoin).toHaveBeenCalledWith("/out", "clipA.mp4");
		expect(mockJoin).toHaveBeenCalledWith("/out", "clipB.mp4");

		// 両方のジョブを完了させる(job-1=clipA, job-2=clipB。clips 配列順で起動される)。
		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		emitMockEvent("reframe://done/job-2", { encoder: "h264" });

		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
			expect(within(listRow("clipB.mp4")).getByText("完了")).toBeInTheDocument();
		});

		// clip-a の trim を変更する(App では ClipEditor の Timeline 操作に相当)。
		await user.click(screen.getByRole("button", { name: "mutate-clip-a-trim" }));

		// clip-a の結果は即座に破棄される(sig 不一致による無効化)。
		// clip-b の結果(完了)はそのまま保持される — 破棄も再起動もされない。
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).queryByText("完了")).not.toBeInTheDocument();
		});
		expect(within(listRow("clipB.mp4")).getByText("完了")).toBeInTheDocument();

		// P1-7 修正の固定テスト: 無効化(clips 依存 effect)と起動(同じく clips 依存、
		// resultsRef.current を読む)が同一コミット内で順に走っても、無効化 effect が
		// resultsRef を同期更新するため、起動 effect は 1 回の操作だけで無効化された
		// clip-a を確実に拾って再起動する(以前は 2 回操作しないと再起動されず、
		// clip-a が「実行中 0%」の見た目で固まっていた)。
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(3));

		emitMockEvent("reframe://done/job-3", { encoder: "h264" });
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
		});
		// clip-b は一連の操作を通じて一度も再起動されていない(reframe_start 呼び出しは
		// clip-a 用の 2 回分(初回 job-1 + 再生成 job-3)+ clip-b 用の初回 job-2 の計 3 回のみ)。
		expect(reframeStartCalls()).toHaveLength(3);
	});

	it("clip 削除時はその clip の結果・購読のみ個別に破棄し、他 clip は影響を受けない", async () => {
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		const clipB = makeClip("clip-b", "clipB", 8);
		renderWithProviders(<Harness initialClips={[clipA, clipB]} />);

		await startExport(user);
		// clip-b(job-2)はまだ進行中(完了させない)。購読が張られていることを確認。
		await waitFor(() => expect(mockEventListenerCount("reframe://done/job-2")).toBe(1));

		await user.click(screen.getByRole("button", { name: "remove-clip-b" }));

		// clip-b の結果行が消え、購読も解除される。
		await waitFor(() => expect(screen.queryByText("clipB.mp4")).not.toBeInTheDocument());
		expect(mockEventListenerCount("reframe://done/job-2")).toBe(0);

		// clip-a(job-1)は無関係に進行中のまま(再起動されない = invoke 回数は増えない)。
		expect(reframeStartCalls()).toHaveLength(2);
		expect(mockEventListenerCount("reframe://done/job-1")).toBe(1);

		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
		});
	});
});

describe("ExportScreen: 書き出しファイル名の重複回避", () => {
	it("同名 clip が複数あっても書き出し先ファイル名は衝突せず、2 件目以降に -2 が付く", async () => {
		const user = userEvent.setup();
		// 2 clip が同じ表示名を持つ(例: 同じ元動画から複製した場合など)。
		const clipA = makeClip("clip-a", "Clip", 10);
		const clipB = makeClip("clip-b", "Clip", 8);
		renderWithProviders(<Harness initialClips={[clipA, clipB]} />);

		await startExport(user);

		// 以前は両方とも `sanitizeFileName(clip.name)}.mp4` = "Clip.mp4" で
		// 書き出し先が衝突し、後発のジョブが先発の出力を上書きしていた(P1 バグ)。
		// 採番ロジック(uniqueBaseNames、UploadScreen の一括書き出しと共有)により
		// 2 件目は "Clip-2.mp4" になる。
		expect(mockJoin).toHaveBeenCalledWith("/out", "Clip.mp4");
		expect(mockJoin).toHaveBeenCalledWith("/out", "Clip-2.mp4");
	});
});
