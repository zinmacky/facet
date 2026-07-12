import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Clip } from "../../types";
import { renderWithProviders } from "../../test/render";
import { clipPreviewSig } from "../../lib/clipSig";
import type { PreviewState } from "../../lib/usePreview";
import { ExportPreviewDetail } from "./ExportPreviewDetail";

function makeClip(overrides: Partial<Clip> = {}): Clip {
	return {
		id: "clip-a",
		name: "clipA",
		trim: { start: 0, end: 10 },
		aspect: "free",
		...overrides,
	};
}

describe("ExportPreviewDetail: 表示時の sig 照合(古いプレビューを表示し続けない)", () => {
	it("state.sig が現在の clip の sig と一致するときは video を表示する", () => {
		const clip = makeClip();
		const state: PreviewState = {
			rendering: false,
			outputPath: "/cache/preview.mp4",
			sig: clipPreviewSig(clip),
		};
		renderWithProviders(
			<ExportPreviewDetail
				clip={clip}
				state={state}
				onGenerate={() => {}}
				onCancel={() => {}}
			/>,
		);

		expect(document.querySelector("video")).toBeInTheDocument();
		expect(screen.queryByText(/要更新/)).not.toBeInTheDocument();
		expect(screen.queryByText(/編集内容が変わりました/)).not.toBeInTheDocument();
	});

	it("クリップ編集後(sig 不一致)は古い video を表示せず、要更新の案内とボタンを表示する", () => {
		const clip = makeClip({ trim: { start: 0, end: 10 } });
		// state.sig は編集前(trim.end=10)の内容で生成されたもの。
		const state: PreviewState = {
			rendering: false,
			outputPath: "/cache/preview.mp4",
			sig: clipPreviewSig(clip),
		};
		// 表示時には clip が既に編集されている(trim.end=8)想定。
		const editedClip = makeClip({ trim: { start: 0, end: 8 } });
		renderWithProviders(
			<ExportPreviewDetail
				clip={editedClip}
				state={state}
				onGenerate={() => {}}
				onCancel={() => {}}
			/>,
		);

		expect(document.querySelector("video")).not.toBeInTheDocument();
		expect(screen.getByText(/要更新/)).toBeInTheDocument();
		expect(screen.getByText(/編集内容が変わりました/)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "プレビュー更新" }),
		).toBeInTheDocument();
	});

	it("要更新の「プレビュー更新」ボタンをクリックすると onGenerate が呼ばれる", async () => {
		const user = userEvent.setup();
		const clip = makeClip({ trim: { start: 0, end: 10 } });
		const state: PreviewState = {
			rendering: false,
			outputPath: "/cache/preview.mp4",
			sig: clipPreviewSig(clip),
		};
		const editedClip = makeClip({ trim: { start: 0, end: 8 } });
		const onGenerate = vi.fn();
		renderWithProviders(
			<ExportPreviewDetail
				clip={editedClip}
				state={state}
				onGenerate={onGenerate}
				onCancel={() => {}}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "プレビュー更新" }));
		expect(onGenerate).toHaveBeenCalledTimes(1);
	});

	it("プレビュー未生成(outputPath 無し)のときは従来どおり生成案内を表示する", () => {
		const clip = makeClip();
		renderWithProviders(
			<ExportPreviewDetail
				clip={clip}
				state={undefined}
				onGenerate={() => {}}
				onCancel={() => {}}
			/>,
		);

		expect(document.querySelector("video")).not.toBeInTheDocument();
		expect(screen.queryByText(/要更新/)).not.toBeInTheDocument();
		expect(
			screen.getByText(/「プレビュー生成」でクロップ内容を確認できます/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "プレビュー生成" }),
		).toBeInTheDocument();
	});
});
