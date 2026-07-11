import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Timeline } from "./Timeline";

// trackRef.getBoundingClientRect() を固定サイズで返す(jsdom は既定で全 0 を返し、
// pxToSeconds が 0 除算になってしまうため)。
const RECT: DOMRect = {
	x: 0,
	y: 0,
	width: 300,
	height: 8,
	top: 0,
	left: 0,
	right: 300,
	bottom: 8,
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
 * 先に発火すると move リスナーが外れずに残り続けていた(リスナーリーク)うえ、
 * onHandleRelease(ドラッグ確定コールバック)も一切呼ばれないままになっていた。
 */
describe("Timeline: pointercancel/lostpointercapture 時のリスナー解除", () => {
	it("開始点ハンドルのドラッグ中に pointercancel が来たら、直近の値で release し以後の move を無視する", () => {
		const onChange = vi.fn();
		const onHandleRelease = vi.fn();
		render(
			<Timeline
				duration={30}
				trim={{ start: 5, end: 20 }}
				currentTime={0}
				onChange={onChange}
				onHandleRelease={onHandleRelease}
			/>,
		);

		const handle = screen.getByRole("slider", { name: "開始点" });
		fireEvent.pointerDown(handle, { clientX: 50, clientY: 4, pointerId: 1 });

		fireEvent(
			window,
			new PointerEvent("pointermove", {
				clientX: 60,
				clientY: 4,
				pointerId: 1,
				bubbles: true,
			}),
		);
		expect(onChange).toHaveBeenCalledTimes(1);

		fireEvent(
			window,
			new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
		);
		// pointercancel でも、直近の pointermove で確定した値を release として親へ渡す
		// (ドラッグ中断でも見た目の位置と確定値がずれないようにする)。
		expect(onHandleRelease).toHaveBeenCalledTimes(1);
		expect(onHandleRelease).toHaveBeenCalledWith(
			"start",
			expect.objectContaining({ end: 20 }),
		);

		fireEvent(
			window,
			new PointerEvent("pointermove", {
				clientX: 200,
				clientY: 4,
				pointerId: 1,
				bubbles: true,
			}),
		);
		// リスナーは pointercancel で解除済みなので、以後の pointermove は無視される。
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onHandleRelease).toHaveBeenCalledTimes(1);
	});

	it("終了点ハンドルのドラッグ中に lostpointercapture が来ても同様にリスナーを解除する", () => {
		const onChange = vi.fn();
		const onHandleRelease = vi.fn();
		render(
			<Timeline
				duration={30}
				trim={{ start: 5, end: 20 }}
				currentTime={0}
				onChange={onChange}
				onHandleRelease={onHandleRelease}
			/>,
		);

		const handle = screen.getByRole("slider", { name: "終了点" });
		fireEvent.pointerDown(handle, { clientX: 200, clientY: 4, pointerId: 2 });

		fireEvent(
			window,
			new PointerEvent("pointermove", {
				clientX: 210,
				clientY: 4,
				pointerId: 2,
				bubbles: true,
			}),
		);
		expect(onChange).toHaveBeenCalledTimes(1);

		fireEvent(
			window,
			new PointerEvent("lostpointercapture", { pointerId: 2, bubbles: true }),
		);
		expect(onHandleRelease).toHaveBeenCalledTimes(1);

		fireEvent(
			window,
			new PointerEvent("pointermove", {
				clientX: 280,
				clientY: 4,
				pointerId: 2,
				bubbles: true,
			}),
		);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onHandleRelease).toHaveBeenCalledTimes(1);
	});
});
