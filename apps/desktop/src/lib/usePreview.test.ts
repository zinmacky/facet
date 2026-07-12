import type { EditSpec } from "@facet/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	emitMockEvent,
	mockEventListenerCount,
	mockInvoke,
} from "../test/tauri-mock";
import { usePreview } from "./usePreview";

const SPEC: EditSpec = {
	source: { width: 1920, height: 1080 },
	trim: { start: 0, end: 5 },
	preset: { name: "free", width: 1080, height: 1920, fit: "crop" },
};

describe("usePreview", () => {
	it("ensure() は preview_start を叩き、done イベントで states へ反映する", async () => {
		const { result } = renderHook(() => usePreview());

		let pending!: Promise<string>;
		act(() => {
			pending = result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
		});

		await waitFor(() => {
			expect(result.current.states.get("clip-1")?.rendering).toBe(true);
		});
		expect(mockInvoke).toHaveBeenCalledWith("preview_start", {
			input: "/in.mp4",
			spec: SPEC,
		});

		const jobId = await mockInvoke.mock.results[0]?.value;
		act(() => {
			emitMockEvent(`preview://done/${jobId}`, { path: "/cache/out.mp4" });
		});

		await expect(pending).resolves.toBe("/cache/out.mp4");
		expect(result.current.states.get("clip-1")).toMatchObject({
			rendering: false,
			outputPath: "/cache/out.mp4",
			sig: "sig-1",
		});
	});

	it("同一 key への重複 ensure() 呼び出しは同じ Promise に合流する(preview_start は 1 回だけ)", async () => {
		// 合流条件(ensure 実装)は `pending && cached?.rendering` — cached は state の
		// ref ミラーで render commit 後にしか更新されない。よって「1 回目の
		// rendering:true が画面に反映された後」に呼ばれた 2 回目のみ合流する
		// (同一 tick 内で連続呼び出すと cached がまだ undefined で合流しない — これは
		// usePreview の実装上の制約で、実際の呼び出し元(ボタン押下やクリップ選択)は
		// 別 tick から呼ぶため通常問題にならない)。
		const { result } = renderHook(() => usePreview());

		let p1!: Promise<string>;
		act(() => {
			p1 = result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
		});
		await waitFor(() =>
			expect(result.current.states.get("clip-1")?.rendering).toBe(true),
		);

		let p2!: Promise<string>;
		act(() => {
			p2 = result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
		});

		expect(p1).toBe(p2);
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
	});

	it("sig が一致し rendering でない完了済みキャッシュは再生成せず即解決する", async () => {
		const { result } = renderHook(() => usePreview());

		act(() => {
			void result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
		});
		const jobId = await waitFor(async () => {
			expect(mockInvoke).toHaveBeenCalledTimes(1);
			return mockInvoke.mock.results[0]?.value;
		});
		act(() => {
			emitMockEvent(`preview://done/${jobId}`, { path: "/cache/out.mp4" });
		});
		await waitFor(() =>
			expect(result.current.states.get("clip-1")?.rendering).toBe(false),
		);

		let again!: Promise<string>;
		act(() => {
			again = result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
		});
		await expect(again).resolves.toBe("/cache/out.mp4");
		// sig 不変・rendering=false のキャッシュ再利用なので invoke は増えない。
		expect(mockInvoke).toHaveBeenCalledTimes(1);
	});

	it("onError イベントで ensure() が reject し、states.error に反映する", async () => {
		const { result } = renderHook(() => usePreview());

		let pending!: Promise<string>;
		act(() => {
			pending = result.current
				.ensure("clip-1", "/in.mp4", SPEC, "sig-1")
				.catch((e: unknown) => {
					throw e;
				});
		});
		const jobId = await waitFor(async () => {
			expect(mockInvoke).toHaveBeenCalledTimes(1);
			return mockInvoke.mock.results[0]?.value;
		});

		act(() => {
			emitMockEvent(`preview://error/${jobId}`, { message: "boom" });
		});

		await expect(pending).rejects.toThrow("boom");
		expect(result.current.states.get("clip-1")?.error).toBe("boom");
	});

	it("remove(key) は購読解除して該当 key の状態のみ破棄する(他 key は残る)", async () => {
		const { result } = renderHook(() => usePreview());

		act(() => {
			void result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
			void result.current.ensure("clip-2", "/in.mp4", SPEC, "sig-1");
		});
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
		const job1 = await mockInvoke.mock.results[0]?.value;
		await waitFor(() => expect(mockEventListenerCount(`preview://done/${job1}`)).toBe(1));

		act(() => {
			result.current.remove("clip-1");
		});

		expect(result.current.states.has("clip-1")).toBe(false);
		expect(result.current.states.has("clip-2")).toBe(true);
		expect(mockEventListenerCount(`preview://done/${job1}`)).toBe(0);
	});

	it("reset() は全 key の購読を解除し states を空にする", async () => {
		const { result } = renderHook(() => usePreview());

		act(() => {
			void result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
			void result.current.ensure("clip-2", "/in.mp4", SPEC, "sig-1");
		});
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
		const job1 = await mockInvoke.mock.results[0]?.value;
		const job2 = await mockInvoke.mock.results[1]?.value;
		await waitFor(() => {
			expect(mockEventListenerCount(`preview://done/${job1}`)).toBe(1);
			expect(mockEventListenerCount(`preview://done/${job2}`)).toBe(1);
		});

		act(() => {
			result.current.reset();
		});

		expect(result.current.states.size).toBe(0);
		expect(mockEventListenerCount(`preview://done/${job1}`)).toBe(0);
		expect(mockEventListenerCount(`preview://done/${job2}`)).toBe(0);
	});
});
