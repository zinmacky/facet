import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "./Modal";

/**
 * ヘッダの ✕ ボタンを取得する。オーバーレイ(背景クリックで閉じる要素)も同じ
 * aria-label="閉じる" を持つため(DOM 順: オーバーレイ → ヘッダの ✕)、2 番目を採る。
 */
function headerCloseButton(): HTMLElement {
	return screen.getAllByRole("button", { name: "閉じる" })[1] as HTMLElement;
}

/**
 * トリガーボタン + Modal を持つ最小ハーネス。
 * 「トリガーで開く → 閉じたらトリガーへフォーカスが戻る」を検証するため、
 * 実際のアプリと同じく open 状態をトリガー側で管理する。
 */
function Harness() {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<button type="button" onClick={() => setOpen(true)}>
				open
			</button>
			<Modal
				open={open}
				title="テストモーダル"
				onClose={() => setOpen(false)}
				footer={
					<button type="button" onClick={() => setOpen(false)}>
						footer-button
					</button>
				}
			>
				<input type="text" aria-label="modal-input" />
			</Modal>
		</div>
	);
}

describe("Modal: フォーカストラップ", () => {
	it("開いたら最初のフォーカス可能要素(閉じるボタン)へフォーカスする", async () => {
		const user = userEvent.setup();
		render(<Harness />);

		await user.click(screen.getByRole("button", { name: "open" }));

		expect(headerCloseButton()).toHaveFocus();
	});

	it("Tab でパネル内の要素をループする(末尾から先頭へ)", async () => {
		const user = userEvent.setup();
		render(<Harness />);

		await user.click(screen.getByRole("button", { name: "open" }));
		const closeButton = headerCloseButton();
		const input = screen.getByLabelText("modal-input");
		const footerButton = screen.getByRole("button", { name: "footer-button" });

		expect(closeButton).toHaveFocus();
		await user.tab();
		expect(input).toHaveFocus();
		await user.tab();
		expect(footerButton).toHaveFocus();
		// 末尾(footer-button)から Tab するとパネル先頭(閉じるボタン)へループする。
		await user.tab();
		expect(closeButton).toHaveFocus();
	});

	it("Shift+Tab で先頭から末尾へ逆方向にループする", async () => {
		const user = userEvent.setup();
		render(<Harness />);

		await user.click(screen.getByRole("button", { name: "open" }));
		const closeButton = headerCloseButton();
		const footerButton = screen.getByRole("button", { name: "footer-button" });

		expect(closeButton).toHaveFocus();
		// 先頭(閉じるボタン)から Shift+Tab するとパネル末尾(footer-button)へループする。
		await user.tab({ shift: true });
		expect(footerButton).toHaveFocus();
	});

	it("閉じたら開く直前にフォーカスされていたトリガー要素へフォーカスが戻る", async () => {
		const user = userEvent.setup();
		render(<Harness />);

		const openButton = screen.getByRole("button", { name: "open" });
		await user.click(openButton);
		expect(headerCloseButton()).toHaveFocus();

		await user.keyboard("{Escape}");

		expect(openButton).toHaveFocus();
	});
});
