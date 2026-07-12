import type { EditSpec } from "@facet/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { emitMockEvent, invokeJobId, mockInvoke } from "../test/tauri-mock";
import { useReframeQueue } from "./useReframeQueue";

const SPEC: EditSpec = {
	source: { width: 1920, height: 1080 },
	trim: { start: 0, end: 5 },
	preset: { name: "free", width: 1080, height: 1920, fit: "crop" },
};

describe("useReframeQueue", () => {
	it("remove(key) は jobId が確定済みなら reframe_cancel を呼ぶ(バグ1: 孤児ジョブ対策)", async () => {
		const { result } = renderHook(() => useReframeQueue());

		let token!: string | false;
		act(() => {
			token = result.current.reserve("clip-1");
		});
		expect(token).not.toBe(false);
		act(() => {
			void result.current.run(
				token as string,
				"clip-1",
				"/in.mp4",
				"/out/clip-1.mp4",
				SPEC,
			);
		});

		const jobId = await waitFor(() => {
			const id = invokeJobId(0);
			expect(id).toBeDefined();
			return id as string;
		});
		await waitFor(() => expect(result.current.tasks.get("clip-1")?.jobId).toBe(jobId));

		act(() => {
			result.current.remove("clip-1");
		});

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("reframe_cancel", { jobId }),
		);
		expect(result.current.tasks.has("clip-1")).toBe(false);
	});

	it("invoke() の resolve より先に emit された error でも task が error 状態になる(バグ2: 取りこぼし対策)", async () => {
		// tauri.ts は jobId を先に採番し listen() を確立してから invoke() する。
		// Rust 側は spawn 直後(invoke の Result が renderer に届くより前)に
		// OutputBusy 等のエラーを emit しうるため、ここでは invoke 自体の
		// mock 実装内で(resolve する前に)emitMockEvent する形でその状況を再現する。
		mockInvoke.mockImplementationOnce(async (cmd: string, args?: unknown) => {
			expect(cmd).toBe("reframe_start");
			const jobId = (args as { jobId: string }).jobId;
			emitMockEvent(`reframe://error/${jobId}`, { message: "OutputBusy" });
			return undefined;
		});

		const { result } = renderHook(() => useReframeQueue());

		let token!: string | false;
		act(() => {
			token = result.current.reserve("clip-1");
		});
		expect(token).not.toBe(false);

		let pending!: Promise<void>;
		act(() => {
			pending = result.current
				.run(token as string, "clip-1", "/in.mp4", "/out/clip-1.mp4", SPEC)
				.catch((e: unknown) => {
					throw e;
				});
		});

		await expect(pending).rejects.toThrow("OutputBusy");
		// emitMockEvent は mockInvoke の実装内部(act() の外)で呼ばれるため、setTasks の
		// 反映を待つ(他の act() 直接呼び出しのテストと異なり、ここでは result.current の
		// 即時反映を保証できない)。
		await waitFor(() => {
			expect(result.current.tasks.get("clip-1")).toMatchObject({
				status: "error",
				error: "OutputBusy",
			});
		});
	});

	it("remove() 後に再 reserve() したジョブの状態を、旧世代の遅延 resolve が上書きしない(バグ3: 世代管理)", async () => {
		// 1 回目の reframe_start は resolve を意図的に保留する(remove()/再 reserve() が
		// run() の invoke() resolve 前に起きるケースを再現するため)。
		let resolveFirstInvoke: (() => void) | undefined;
		mockInvoke.mockImplementationOnce(() => {
			return new Promise<void>((resolve) => {
				resolveFirstInvoke = () => resolve(undefined);
			});
		});

		const { result } = renderHook(() => useReframeQueue());

		let token1!: string | false;
		act(() => {
			token1 = result.current.reserve("clip-1");
		});
		expect(token1).not.toBe(false);
		act(() => {
			void result.current.run(
				token1 as string,
				"clip-1",
				"/in.mp4",
				"/out/clip-1-v1.mp4",
				SPEC,
			);
		});
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
		const job1 = invokeJobId(0);

		// 旧ジョブ(job1)がまだ invoke 未 resolve のうちに remove() + 再 reserve() する
		// (ExportScreen の sig 無効化 → 即再起動に相当)。
		act(() => {
			result.current.remove("clip-1");
		});
		let token2!: string | false;
		act(() => {
			token2 = result.current.reserve("clip-1");
		});
		expect(token2).not.toBe(false);
		expect(token2).not.toBe(token1);
		act(() => {
			void result.current.run(
				token2 as string,
				"clip-1",
				"/in.mp4",
				"/out/clip-1-v2.mp4",
				SPEC,
			);
		});

		const job2 = await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledTimes(2);
			return invokeJobId(1) as string;
		});
		await waitFor(() => expect(result.current.tasks.get("clip-1")?.jobId).toBe(job2));

		// ここで旧ジョブ(job1)の invoke がようやく resolve する。
		act(() => {
			resolveFirstInvoke?.();
		});

		// 新ジョブ(job2)の状態が上書きされていないこと。
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("reframe_cancel", { jobId: job1 }),
		);
		expect(result.current.tasks.get("clip-1")?.jobId).toBe(job2);

		// 孤児化していた job1 の done/error が後から届いても、tasks には一切影響しない。
		act(() => {
			emitMockEvent(`reframe://done/${job1}`, { encoder: "h264" });
		});
		expect(result.current.tasks.get("clip-1")?.jobId).toBe(job2);
		expect(result.current.tasks.get("clip-1")?.status).toBe("running");
	});

	it("startBatch() は key ごとに世代トークンを発行し、run() に渡すことでバッチの起動ができる", async () => {
		const { result } = renderHook(() => useReframeQueue());

		let tokens!: Map<string, string>;
		act(() => {
			tokens = result.current.startBatch(["out-1", "out-2"]);
		});
		expect(tokens.size).toBe(2);

		act(() => {
			void result.current.run(
				tokens.get("out-1") as string,
				"out-1",
				"/in.mp4",
				"/out/out-1.mp4",
				SPEC,
			);
			void result.current.run(
				tokens.get("out-2") as string,
				"out-2",
				"/in.mp4",
				"/out/out-2.mp4",
				SPEC,
			);
		});

		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
		const job1 = invokeJobId(0);
		const job2 = invokeJobId(1);

		act(() => {
			emitMockEvent(`reframe://done/${job1}`, { encoder: "h264" });
			emitMockEvent(`reframe://done/${job2}`, { encoder: "h264" });
		});

		await waitFor(() => {
			expect(result.current.tasks.get("out-1")?.status).toBe("done");
			expect(result.current.tasks.get("out-2")?.status).toBe("done");
		});
	});
});
