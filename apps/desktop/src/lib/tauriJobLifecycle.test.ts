import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../test/tauri-mock";
import {
	cancelOrphanHandle,
	cancelOrphanJob,
	detachAllJobHandles,
	detachHandle,
	detachJobHandle,
	type JobHandleLike,
	useKeyedJobLifecycle,
} from "./tauriJobLifecycle";

/** テスト用の最小 JobHandleLike。unsubscribe/cancel の呼び出し回数を検証できる。 */
function makeHandle(
	jobId: string,
	opts?: { cancelImpl?: () => Promise<void> },
): JobHandleLike & { unsubscribeCalls: number; cancelCalls: number } {
	const handle = {
		jobId,
		unsubscribeCalls: 0,
		cancelCalls: 0,
		unsubscribe(): void {
			handle.unsubscribeCalls += 1;
		},
		cancel(): Promise<void> {
			handle.cancelCalls += 1;
			return opts?.cancelImpl ? opts.cancelImpl() : Promise.resolve();
		},
	};
	return handle;
}

describe("cancelOrphanJob", () => {
	it("jobId が undefined なら reframe_cancel を呼ばず即 resolve する", async () => {
		await expect(cancelOrphanJob(undefined)).resolves.toBeUndefined();
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("jobId があれば reframe_cancel を呼ぶ", async () => {
		await cancelOrphanJob("job-1");
		expect(mockInvoke).toHaveBeenCalledWith("reframe_cancel", { jobId: "job-1" });
	});

	it("reframe_cancel が失敗しても console.warn するだけで resolve する", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mockInvoke.mockImplementationOnce(() => Promise.reject(new Error("boom")));

		await expect(cancelOrphanJob("job-1")).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("ジョブのキャンセルに失敗しました(jobId=job-1)"),
			expect.any(Error),
		);
		warn.mockRestore();
	});
});

describe("cancelOrphanHandle", () => {
	it("handle を購読解除 + キャンセルする", () => {
		const handle = makeHandle("job-1");
		cancelOrphanHandle(handle);
		expect(handle.unsubscribeCalls).toBe(1);
		expect(handle.cancelCalls).toBe(1);
	});

	it("cancel() が失敗しても console.warn するだけで例外は投げない", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const handle = makeHandle("job-1", { cancelImpl: () => Promise.reject(new Error("boom")) });

		expect(() => cancelOrphanHandle(handle)).not.toThrow();
		// cancel().catch(...) はマイクロタスクなので flush を待つ。
		await Promise.resolve();
		await Promise.resolve();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("孤児ジョブのキャンセルに失敗しました(jobId=job-1)"),
			expect.any(Error),
		);
		warn.mockRestore();
	});
});

describe("detachHandle/detachJobHandle/detachAllJobHandles", () => {
	it("detachHandle は購読解除 + キャンセルする(失敗しても無視する)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const handle = makeHandle("job-1", { cancelImpl: () => Promise.reject(new Error("boom")) });

		expect(() => detachHandle(handle)).not.toThrow();
		expect(handle.unsubscribeCalls).toBe(1);
		expect(handle.cancelCalls).toBe(1);
		await Promise.resolve();
		await Promise.resolve();
		// usePublishExtras.tsx と同じ挙動: 失敗を warn しない(cancelOrphanHandle と違い握りつぶす)。
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("detachJobHandle は該当 key の handle のみ取り除く", () => {
		const handles = new Map<string, JobHandleLike>();
		const h1 = makeHandle("job-1");
		const h2 = makeHandle("job-2");
		handles.set("out-1", h1);
		handles.set("out-2", h2);

		detachJobHandle(handles, "out-1");

		expect(h1.unsubscribeCalls).toBe(1);
		expect(h1.cancelCalls).toBe(1);
		expect(handles.has("out-1")).toBe(false);
		expect(handles.has("out-2")).toBe(true);
		expect(h2.unsubscribeCalls).toBe(0);
	});

	it("detachJobHandle は key が無ければ何もしない", () => {
		const handles = new Map<string, JobHandleLike>();
		expect(() => detachJobHandle(handles, "missing")).not.toThrow();
	});

	it("detachAllJobHandles は全 handle を取り除く", () => {
		const handles = new Map<string, JobHandleLike>();
		const h1 = makeHandle("job-1");
		const h2 = makeHandle("job-2");
		handles.set("out-1", h1);
		handles.set("out-2", h2);

		detachAllJobHandles(handles);

		expect(h1.unsubscribeCalls).toBe(1);
		expect(h2.unsubscribeCalls).toBe(1);
		expect(handles.size).toBe(0);
	});
});

describe("useKeyedJobLifecycle", () => {
	it("reserve() は key ごとに一意なトークンを発行し、isCurrent() で判定できる", () => {
		const { result } = renderHook(() => useKeyedJobLifecycle());

		let token1!: string;
		let token2!: string;
		act(() => {
			token1 = result.current.reserve("clip-1");
			token2 = result.current.reserve("clip-2");
		});

		expect(token1).not.toBe(token2);
		expect(result.current.isCurrent("clip-1", token1)).toBe(true);
		expect(result.current.isCurrent("clip-2", token2)).toBe(true);
		// 他 key のトークンとは一致しない。
		expect(result.current.isCurrent("clip-1", token2)).toBe(false);
	});

	it("reserve() は isActive() を true にする(unsubsRef へのプレースホルダ登録)", () => {
		const { result } = renderHook(() => useKeyedJobLifecycle());

		expect(result.current.isActive("clip-1")).toBe(false);
		act(() => {
			result.current.reserve("clip-1");
		});
		expect(result.current.isActive("clip-1")).toBe(true);
	});

	it("同じ key へ再 reserve() すると旧世代の token は isCurrent() が false になる(バグ3: 世代管理)", () => {
		const { result } = renderHook(() => useKeyedJobLifecycle());

		let token1!: string;
		act(() => {
			token1 = result.current.reserve("clip-1");
		});
		expect(result.current.isCurrent("clip-1", token1)).toBe(true);

		let token2!: string;
		act(() => {
			token2 = result.current.reserve("clip-1");
		});

		expect(token2).not.toBe(token1);
		expect(result.current.isCurrent("clip-1", token1)).toBe(false);
		expect(result.current.isCurrent("clip-1", token2)).toBe(true);
	});

	it("setUnsubscribe() で差し替えた購読解除関数は remove() 時に呼ばれる", async () => {
		const { result } = renderHook(() => useKeyedJobLifecycle());

		const unsubscribe = vi.fn();
		act(() => {
			result.current.reserve("clip-1");
			result.current.setUnsubscribe("clip-1", unsubscribe);
		});

		await act(async () => {
			await result.current.remove("clip-1", undefined);
		});

		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("remove(key, jobId) は jobId が既知なら reframe_cancel を呼び、世代を無効化する", async () => {
		const { result } = renderHook(() => useKeyedJobLifecycle());

		let token!: string;
		act(() => {
			token = result.current.reserve("clip-1");
		});

		await act(async () => {
			await result.current.remove("clip-1", "job-1");
		});

		expect(mockInvoke).toHaveBeenCalledWith("reframe_cancel", { jobId: "job-1" });
		expect(result.current.isCurrent("clip-1", token)).toBe(false);
		expect(result.current.isActive("clip-1")).toBe(false);
	});

	it("remove(key, undefined) は jobId 未確定でも安全に処理を終える(reframe_cancel は呼ばない)", async () => {
		const { result } = renderHook(() => useKeyedJobLifecycle());

		act(() => {
			result.current.reserve("clip-1");
		});

		await act(async () => {
			await result.current.remove("clip-1", undefined);
		});

		expect(mockInvoke).not.toHaveBeenCalled();
		expect(result.current.isActive("clip-1")).toBe(false);
	});

	it("clearUnsubscribe() は購読解除関数を呼ばずに登録だけ取り除く", async () => {
		const { result } = renderHook(() => useKeyedJobLifecycle());

		const unsubscribe = vi.fn();
		act(() => {
			result.current.reserve("clip-1");
			result.current.setUnsubscribe("clip-1", unsubscribe);
			result.current.clearUnsubscribe("clip-1");
		});
		// isActive は unsubsRef の登録有無で判定するため、clearUnsubscribe 後は false になる。
		expect(result.current.isActive("clip-1")).toBe(false);

		await act(async () => {
			await result.current.remove("clip-1", undefined);
		});
		expect(unsubscribe).not.toHaveBeenCalled();
	});

	it("resetAll() は全 key の購読を解除し、渡された jobId 全てを cancelOrphanJob する", async () => {
		const { result } = renderHook(() => useKeyedJobLifecycle());

		const unsub1 = vi.fn();
		const unsub2 = vi.fn();
		act(() => {
			result.current.reserve("clip-1");
			result.current.setUnsubscribe("clip-1", unsub1);
			result.current.reserve("clip-2");
			result.current.setUnsubscribe("clip-2", unsub2);
		});

		act(() => {
			result.current.resetAll(["job-1", "job-2"]);
		});

		expect(unsub1).toHaveBeenCalledTimes(1);
		expect(unsub2).toHaveBeenCalledTimes(1);
		expect(result.current.isActive("clip-1")).toBe(false);
		expect(result.current.isActive("clip-2")).toBe(false);

		// cancelOrphanJob() は fire-and-forget(await しない)なので invoke の反映を待つ。
		await Promise.resolve();
		await Promise.resolve();
		expect(mockInvoke).toHaveBeenCalledWith("reframe_cancel", { jobId: "job-1" });
		expect(mockInvoke).toHaveBeenCalledWith("reframe_cancel", { jobId: "job-2" });
	});

	it("resetAll() は undefined の jobId をスキップする", async () => {
		const { result } = renderHook(() => useKeyedJobLifecycle());

		act(() => {
			result.current.reserve("clip-1");
		});
		act(() => {
			result.current.resetAll([undefined]);
		});

		await Promise.resolve();
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("戻り値オブジェクトの参照はレンダー間で安定している(アンマウント専用 effect の依存配列対策)", () => {
		const { result, rerender } = renderHook(() => useKeyedJobLifecycle());
		const first = result.current;
		rerender();
		expect(result.current).toBe(first);
	});
});
