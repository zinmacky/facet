import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepIndicator } from "./StepIndicator";

/**
 * StepIndicator の前進ガード(canGoExport/canGoUpload/locked)。
 * 後退クリックは常時可能、前進クリックは対応する canGoXxx のときのみ許可、
 * locked 中は現在ステップ以外への遷移を全面禁止する(§App.tsx goToStep 参照)。
 */
describe("StepIndicator", () => {
	it("canGoExport/canGoUpload が false の間、対応するステップボタンを disabled にする", () => {
		render(
			<StepIndicator
				step="edit"
				canGoExport={false}
				canGoUpload={false}
				onSelect={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: /編集/ })).toBeEnabled();
		expect(screen.getByRole("button", { name: /確認/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: /リフレーム/ })).toBeDisabled();
	});

	it("canGoExport が true なら確認へ前進でき、クリックで onSelect が呼ばれる", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(
			<StepIndicator
				step="edit"
				canGoExport={true}
				canGoUpload={false}
				onSelect={onSelect}
			/>,
		);
		const exportBtn = screen.getByRole("button", { name: /確認/ });
		expect(exportBtn).toBeEnabled();
		await user.click(exportBtn);
		expect(onSelect).toHaveBeenCalledWith("export");
	});

	it("後退クリックは canGoXxx に関わらず常に許可される", () => {
		render(
			<StepIndicator
				step="upload"
				canGoExport={false}
				canGoUpload={false}
				onSelect={vi.fn()}
			/>,
		);
		// upload が現在地でも canGoExport/canGoUpload が false なのは
		// 「前進不可」の意味であり、後退(edit/export への遷移)は許可され続ける。
		expect(screen.getByRole("button", { name: /編集/ })).toBeEnabled();
		expect(screen.getByRole("button", { name: /確認/ })).toBeEnabled();
	});

	it("locked=true の間は現在ステップ以外すべて disabled になる(離脱抑止)", () => {
		render(
			<StepIndicator
				step="upload"
				canGoExport={true}
				canGoUpload={true}
				locked={true}
				onSelect={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: /編集/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: /確認/ })).toBeDisabled();
		// 現在ステップ自身は常に enabled(disabled={!allowed}, active は allowed=true)。
		expect(screen.getByRole("button", { name: /リフレーム/ })).toBeEnabled();
	});

	it("exportSummary の done/total をバッジ表示する", () => {
		render(
			<StepIndicator
				step="export"
				canGoExport={true}
				canGoUpload={true}
				exportSummary={{ total: 3, done: 1, running: 1 }}
				onSelect={vi.fn()}
			/>,
		);
		expect(screen.getByText("1/3")).toBeInTheDocument();
	});

	it("確認が1件も開始されていない間(done=0 かつ running=0)はバッジを表示しない", () => {
		render(
			<StepIndicator
				step="export"
				canGoExport={true}
				canGoUpload={true}
				exportSummary={{ total: 3, done: 0, running: 0 }}
				onSelect={vi.fn()}
			/>,
		);
		expect(screen.queryByText("0/3")).not.toBeInTheDocument();
	});

	it("running > 0(実行中)になった時点でバッジを表示する", () => {
		render(
			<StepIndicator
				step="export"
				canGoExport={true}
				canGoUpload={true}
				exportSummary={{ total: 3, done: 0, running: 1 }}
				onSelect={vi.fn()}
			/>,
		);
		expect(screen.getByText("0/3")).toBeInTheDocument();
	});
});
