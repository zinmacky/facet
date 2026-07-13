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
// public ビルドが実際に使うモジュール(entry.public.ts)を直接 import する
// (`virtual:upload-entry` 経由だと vitest.config.ts が常に private 実体へ alias するため、
// public の挙動を検証できない。§App.public-edition.test.tsx 冒頭コメント参照)。
import { UploadScreen } from "./entry.public";

/**
 * public エディションのリフレーム画面(entry.public.ts が実際にエクスポートする
 * `ReframeScreen`)の固定テスト。
 *
 * - ターゲット/フィット選択・プレビュー生成・「フォルダへ保存」という
 *   リフレーム機能そのものが利用できること(v2.4 エディション分離時に
 *   リフレーム機能ごと除外してしまった切り分けミスの修正確認)。
 * - 投稿(スケジュール・キャプション・IG/YT 連携)系の文言・操作が一切現れないこと
 *   (`publishSlots` を渡していないため `ReframeScreen` 側で描画されない)。
 */

const SOURCE = { inputPath: "/in.mp4", probe: DEFAULT_MEDIA_INFO };

const CLIP: Clip = {
	id: "clip-1",
	name: "ClipOne",
	trim: { start: 0, end: 5 },
	aspect: "free",
};

function reframeStartCalls() {
	return mockInvoke.mock.calls.filter(([cmd]) => cmd === "reframe_start");
}

function renderScreen() {
	return renderWithProviders(
		<UploadScreen
			active
			source={SOURCE}
			clips={[CLIP]}
			resetToken={0}
			onGoToExport={() => {}}
		/>,
	);
}

describe("public のリフレーム画面: リフレーム機能自体は利用できる", () => {
	it("出力ターゲット・フィットを選び、プレビュー生成できる", async () => {
		const user = userEvent.setup();
		renderScreen();

		await waitFor(() =>
			expect(screen.getByLabelText("出力ターゲット")).toBeInTheDocument(),
		);
		await user.selectOptions(screen.getByLabelText("出力ターゲット"), "ig-reels");
		await user.selectOptions(screen.getByLabelText("フィット"), "blur-pad");

		await user.click(screen.getByRole("button", { name: "プレビュー生成" }));
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith(
				"preview_start",
				expect.objectContaining({ input: SOURCE.inputPath }),
			),
		);
	});

	it("「フォルダへ保存」でフォルダを選び、reframe_start が実書き出し品質で起動する", async () => {
		const user = userEvent.setup();
		renderScreen();

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "フォルダへ保存" })).toBeInTheDocument(),
		);
		mockDialogOpen.mockResolvedValueOnce("/out");
		await user.click(screen.getByRole("button", { name: "フォルダへ保存" }));

		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));
		expect(mockJoin).toHaveBeenCalledWith("/out", "ClipOne_yt-shorts_crop.mp4");

		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		await waitFor(() => expect(screen.getByText(/完了 1 \/ 1 件/)).toBeInTheDocument());
	});
});

describe("public のリフレーム画面: 投稿系 UI が一切現れない", () => {
	it("投稿設定・すべて投稿・予約スケジュール・APIトークン等の文言が存在しない", async () => {
		renderScreen();

		await waitFor(() =>
			expect(screen.getByLabelText("出力ターゲット")).toBeInTheDocument(),
		);

		for (const text of [
			"投稿設定",
			"すべて投稿",
			"予約スケジュール",
			"一括投稿",
			"APIトークン",
			"キャプション",
			"この投稿をすべて投稿",
		]) {
			expect(screen.queryByText(text)).not.toBeInTheDocument();
		}
		expect(
			screen.queryByRole("button", { name: "予約スケジュール…" }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "すべて投稿" })).not.toBeInTheDocument();
	});

	it("項目一覧・一括設定は「投稿」ではなく「項目」と表記される", async () => {
		const user = userEvent.setup();
		renderScreen();

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "+ 項目を追加" })).toBeInTheDocument(),
		);
		await user.click(screen.getByRole("button", { name: "一括設定…" }));
		expect(
			screen.getByRole("button", { name: "全ての項目に出力先を適用" }),
		).toBeInTheDocument();
	});
});
