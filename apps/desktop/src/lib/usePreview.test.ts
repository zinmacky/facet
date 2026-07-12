import type { EditSpec } from "@facet/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	emitMockEvent,
	invokeJobId,
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
			jobId: "job-1",
			input: "/in.mp4",
			spec: SPEC,
		});

		const jobId = invokeJobId(0);
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

	it("同一 key への重複 ensure() 呼び出しは同一 tick 内でも同じ Promise に合流する(preview_start は 1 回だけ)", async () => {
		// P1 バグ修正の固定テスト: 合流判定は以前 `pending && cached?.rendering` だった。
		// cached は state の ref ミラーで render commit 後にしか更新されないため、
		// 同一 tick 内で連続呼び出すと 1 回目の rendering:true がまだ cached へ反映
		// されておらず合流に失敗し、preview_start が二重発火していた
		// (usePreview.ensure の重複ガード競合)。合流判定を `pendingRef`(同期的に
		// 更新される Map)のみに単純化した現在は、同一 tick 内の連続呼び出しでも
		// 確実に合流する。
		const { result } = renderHook(() => usePreview());

		let p1!: Promise<string>;
		let p2!: Promise<string>;
		act(() => {
			p1 = result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
			p2 = result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
		});

		expect(p1).toBe(p2);
		await waitFor(() =>
			expect(result.current.states.get("clip-1")?.rendering).toBe(true),
		);
		expect(mockInvoke).toHaveBeenCalledTimes(1);
	});

	it("sig が一致し rendering でない完了済みキャッシュは再生成せず即解決する", async () => {
		const { result } = renderHook(() => usePreview());

		act(() => {
			void result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
		});
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
		const jobId = invokeJobId(0);
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
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
		const jobId = invokeJobId(0);

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
		const job1 = invokeJobId(0);
		await waitFor(() => expect(mockEventListenerCount(`preview://done/${job1}`)).toBe(1));

		act(() => {
			result.current.remove("clip-1");
		});

		expect(result.current.states.has("clip-1")).toBe(false);
		expect(result.current.states.has("clip-2")).toBe(true);
		expect(mockEventListenerCount(`preview://done/${job1}`)).toBe(0);
	});

	it("remove(key) は jobId が確定済みなら reframe_cancel を呼ぶ(バグ1: 孤児ジョブ対策)", async () => {
		const { result } = renderHook(() => usePreview());

		act(() => {
			void result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
		});
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
		const jobId = invokeJobId(0);
		// jobId が state に反映される(= invoke の then が実行された)まで待つ。
		await waitFor(() => expect(result.current.states.get("clip-1")?.jobId).toBe(jobId));

		act(() => {
			result.current.remove("clip-1");
		});

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("reframe_cancel", { jobId }),
		);
	});

	it("reset() は全 key の購読を解除し states を空にする", async () => {
		const { result } = renderHook(() => usePreview());

		act(() => {
			void result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
			void result.current.ensure("clip-2", "/in.mp4", SPEC, "sig-1");
		});
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
		const job1 = invokeJobId(0);
		const job2 = invokeJobId(1);
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

	it("invoke() の resolve より先に emit された error でも states.error に反映する(バグ2: 取りこぼし対策)", async () => {
		// tauri.ts は jobId を先に採番し listen() を確立してから invoke() する。
		// Rust 側は spawn 直後(invoke の Result が renderer に届くより前)に
		// OutputBusy 等のエラーを emit しうるため、ここでは invoke 自体の
		// mock 実装内で(resolve する前に)emitMockEvent する形でその状況を再現する。
		mockInvoke.mockImplementationOnce(async (cmd: string, args?: unknown) => {
			expect(cmd).toBe("preview_start");
			const jobId = (args as { jobId: string }).jobId;
			// invoke がまだ resolve していない時点で emit する。
			emitMockEvent(`preview://error/${jobId}`, { message: "OutputBusy" });
			return undefined;
		});

		const { result } = renderHook(() => usePreview());

		let pending!: Promise<string>;
		act(() => {
			pending = result.current
				.ensure("clip-1", "/in.mp4", SPEC, "sig-1")
				.catch((e: unknown) => {
					throw e;
				});
		});

		await expect(pending).rejects.toThrow("OutputBusy");
		// emitMockEvent は mockInvoke の実装内部(act() の外)で呼ばれるため、setStates の
		// 反映を待つ(他の act() 直接呼び出しのテストと異なり、ここでは result.current の
		// 即時反映を保証できない)。
		await waitFor(() => {
			expect(result.current.states.get("clip-1")).toMatchObject({
				rendering: false,
				error: "OutputBusy",
			});
		});
	});

	it("reset() は jobId が確定済みの全ジョブへ reframe_cancel を呼ぶ(バグ1: 孤児ジョブ対策)", async () => {
		const { result } = renderHook(() => usePreview());

		act(() => {
			void result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-1");
			void result.current.ensure("clip-2", "/in.mp4", SPEC, "sig-1");
		});
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
		const job1 = invokeJobId(0);
		const job2 = invokeJobId(1);
		await waitFor(() => {
			expect(result.current.states.get("clip-1")?.jobId).toBe(job1);
			expect(result.current.states.get("clip-2")?.jobId).toBe(job2);
		});

		act(() => {
			result.current.reset();
		});

		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("reframe_cancel", { jobId: job1 });
			expect(mockInvoke).toHaveBeenCalledWith("reframe_cancel", { jobId: job2 });
		});
	});
});
