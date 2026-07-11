import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CropOverlay } from "./CropOverlay";

// containerRef.getBoundingClientRect() を固定サイズで返す(jsdom は既定で全 0 を返し、
// toNorm/containerAspectRatio が 0 除算になってしまうため)。
const RECT: DOMRect = {
	x: 0,
	y: 0,
	width: 200,
	height: 200,
	top: 0,
	left: 0,
	right: 200,
	bottom: 200,
	toJSON() {
		return this;
	},
};

beforeEach(() => {
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(RECT);
});

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * ドラッグの pointercancel/lostpointercapture 未処理(P1 バグ)の固定テスト。
 * 以前は pointerup でしか window の pointermove/pointerup リスナーを解除しておらず、
 * ブラウザ/OS のジェスチャ割り込みなどで pointercancel や lostpointercapture が
 * 先に発火すると move リスナーが外れずに残り続けていた(リスナーリーク。以後その
 * 座標のポインタ移動がすべて crop 更新を発火し続ける)。
 */
describe("CropOverlay: pointercancel/lostpointercapture 時のリスナー解除", () => {
	it("枠移動(pointerdown → pointermove)中に pointercancel が来たら、以後の pointermove を無視する", () => {
		const onChange = vi.fn();
		render(
			<CropOverlay
				crop={{ x: 0.1, y: 0.1, width: 0.3, height: 0.3 }}
				onChange={onChange}
			/>,
		);

		const rect = screen.getByRole("application");
		fireEvent.pointerDown(rect, { clientX: 50, clientY: 50, pointerId: 1 });

		fireEvent(
			window,
			new PointerEvent("pointermove", {
				clientX: 60,
				clientY: 60,
				pointerId: 1,
				bubbles: true,
			}),
		);
		expect(onChange).toHaveBeenCalledTimes(1);

		fireEvent(
			window,
			new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
		);

		fireEvent(
			window,
			new PointerEvent("pointermove", {
				clientX: 120,
				clientY: 120,
				pointerId: 1,
				bubbles: true,
			}),
		);
		// pointercancel でリスナーが解除されているため、以後の pointermove は無視される
		// (呼び出し回数が増えない)。
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("枠移動中に lostpointercapture が来たら、以後の pointermove を無視する", () => {
		const onChange = vi.fn();
		render(
			<CropOverlay
				crop={{ x: 0.1, y: 0.1, width: 0.3, height: 0.3 }}
				onChange={onChange}
			/>,
		);

		const rect = screen.getByRole("application");
		fireEvent.pointerDown(rect, { clientX: 50, clientY: 50, pointerId: 1 });

		fireEvent(
			window,
			new PointerEvent("pointermove", {
				clientX: 60,
				clientY: 60,
				pointerId: 1,
				bubbles: true,
			}),
		);
		expect(onChange).toHaveBeenCalledTimes(1);

		fireEvent(
			window,
			new PointerEvent("lostpointercapture", { pointerId: 1, bubbles: true }),
		);

		fireEvent(
			window,
			new PointerEvent("pointermove", {
				clientX: 120,
				clientY: 120,
				pointerId: 1,
				bubbles: true,
			}),
		);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("四隅リサイズ中の pointercancel でも同様にリスナーを解除する", () => {
		const onChange = vi.fn();
		const { container } = render(
			<CropOverlay
				crop={{ x: 0.1, y: 0.1, width: 0.3, height: 0.3 }}
				onChange={onChange}
			/>,
		);

		// nw(左上、CORNERS 配列の先頭)ハンドル。role/aria-label を持たないため class で特定する。
		const nwHandle = container.querySelector('[class*="cursor-nwse-resize"]');
		expect(nwHandle).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: 直前に null チェック済み
		fireEvent.pointerDown(nwHandle!, { clientX: 80, clientY: 80, pointerId: 2 });

		fireEvent(
			window,
			new PointerEvent("pointermove", {
				clientX: 100,
				clientY: 100,
				pointerId: 2,
				bubbles: true,
			}),
		);
		expect(onChange).toHaveBeenCalledTimes(1);

		fireEvent(
			window,
			new PointerEvent("pointercancel", { pointerId: 2, bubbles: true }),
		);

		fireEvent(
			window,
			new PointerEvent("pointermove", {
				clientX: 150,
				clientY: 150,
				pointerId: 2,
				bubbles: true,
			}),
		);
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});
