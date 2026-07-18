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

	it('usePreview("publish") の ensure() は preview_start に quality:"publish" を渡す', async () => {
		// 投稿フロー用: フックインスタンス全体が本書き出し品質(8Mbps・publish-cache)で
		// 動くこと。既定(引数なし)の呼び出しが quality キーを含まないことは上のテストの
		// toHaveBeenCalledWith(完全一致)で担保済み。
		const { result } = renderHook(() => usePreview("publish"));

		let pending!: Promise<string>;
		act(() => {
			pending = result.current.ensure("out-1", "/in.mp4", SPEC, "sig-1");
		});

		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
		expect(mockInvoke).toHaveBeenCalledWith("preview_start", {
			jobId: "job-1",
			input: "/in.mp4",
			spec: SPEC,
			quality: "publish",
		});

		const jobId = invokeJobId(0);
		act(() => {
			emitMockEvent(`preview://done/${jobId}`, {
				path: "/publish-cache/out.mp4",
			});
		});

		await expect(pending).resolves.toBe("/publish-cache/out.mp4");
		expect(result.current.states.get("out-1")).toMatchObject({
			rendering: false,
			outputPath: "/publish-cache/out.mp4",
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

	it("進行中レンダリングと異なる sig で ensure() すると合流せず、古いジョブを孤児化して新しい sig で撮り直す(cancel-and-restart)", async () => {
		// レビュー指摘の回帰テスト: 以前は pendingRef への合流が sig を見ておらず、
		// publish 品質のレンダリングが進行中に(投稿直前の)spec 編集で ensure() し直すと、
		// 呼び出し元は編集前の(古い sig の)結果をそのまま受け取ってしまっていた
		// (usePublishExtras の投稿フローがそれをそのままアップロードする実害)。
		const { result } = renderHook(() => usePreview());

		const specB: EditSpec = { ...SPEC, trim: { start: 0, end: 3 } };

		// pendingA の決着(resolved/rejected)を同期的に記録する。unhandled rejection
		// 警告を避けるため、.catch を後から生やすのではなく生成と同一 tick でハンドラを
		// 張る(このファイルの「jobId 未確定窓で remove()」テストと同じ配慮)。
		let pendingASettled: "resolved" | "rejected" | undefined;
		let pendingA!: Promise<string>;
		act(() => {
			pendingA = result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-a");
			pendingA.then(
				() => {
					pendingASettled = "resolved";
				},
				() => {
					pendingASettled = "rejected";
				},
			);
		});
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
		const jobA = invokeJobId(0);

		// sig-a のレンダリングがまだ完了していないうちに、異なる sig(sig-b)で ensure()
		// する(同一 tick 内でも成立することを確認するため act() でまとめて呼ぶ)。
		let pendingB!: Promise<string>;
		act(() => {
			pendingB = result.current.ensure("clip-1", "/in.mp4", specB, "sig-b");
		});

		// 合流せず、新しい撮り直しとして 2 回目の preview_start が発火する。
		await waitFor(() => {
			const previewCalls = mockInvoke.mock.calls.filter(
				([cmd]) => cmd === "preview_start",
			);
			expect(previewCalls.length).toBe(2);
		});
		const previewCalls = mockInvoke.mock.calls.filter(
			([cmd]) => cmd === "preview_start",
		);
		const secondCall = previewCalls[1];
		if (!secondCall) throw new Error("2 回目の preview_start 呼び出しが見つからない");
		const jobB = (secondCall[1] as { jobId: string }).jobId;
		expect(jobB).not.toBe(jobA);

		// 孤児化した古い ensure()(pendingA)は、cancel-and-restart の時点で明示的に
		// reject 済み(孤児化した古いジョブ自身の onDone/onError が発火する保証が
		// ないため — 詳細は usePreview.ts の pendingRejectRef コメント参照)。
		await waitFor(() => expect(pendingASettled).toBe("rejected"));
		// 孤児化した古いジョブ(jobA)自体も、走らせっぱなしにせず Rust 側へキャンセルを
		// 通知する(cancel-and-restart の「cancel」側の確認)。
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("reframe_cancel", { jobId: jobA }),
		);

		// 孤児化した古いジョブ(jobA)の done が後から届いても無視され、states には
		// 反映されない(sig-a はもはや current な世代ではない)。
		act(() => {
			emitMockEvent(`preview://done/${jobA}`, { path: "/cache/stale.mp4" });
		});
		expect(result.current.states.get("clip-1")?.sig).not.toBe("sig-a");

		// 新しい sig(sig-b)のジョブが完了すると、呼び出し元(pendingB)・states の双方に
		// sig-b の結果が反映される。
		act(() => {
			emitMockEvent(`preview://done/${jobB}`, { path: "/cache/fresh.mp4" });
		});
		await expect(pendingB).resolves.toBe("/cache/fresh.mp4");
		expect(result.current.states.get("clip-1")).toMatchObject({
			rendering: false,
			outputPath: "/cache/fresh.mp4",
			sig: "sig-b",
		});
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

	it("jobId 未確定窓で remove() すると、jobId 判明時に states へ復活せず reframe_cancel される(世代トークン: GHSA-c4jj-6rmf-h7g3 対応)", async () => {
		// 1 回目の preview_start は resolve を意図的に保留する(remove() が invoke() の
		// resolve 前に起きるケースを再現するため)。
		let resolveFirstInvoke: (() => void) | undefined;
		mockInvoke.mockImplementationOnce(() => {
			return new Promise<void>((resolve) => {
				resolveFirstInvoke = () => resolve(undefined);
			});
		});

		const { result } = renderHook(() => usePreview());

		// この ensure() の Promise は remove() 済みになった時点で reject する
		// (isCurrent() が false の間は state 更新も再登録もしないだけで、Promise 自体は
		// 確定させる必要があるため — jobId 未確定時点の early-cancel 分岐、
		// usePreview.ts 参照)。reject 自体はここでは検証しない(状態と mockInvoke の
		// 呼び出しで十分)ため、unhandled rejection を避けるために即座に握りつぶす。
		act(() => {
			void result.current
				.ensure("clip-1", "/in.mp4", SPEC, "sig-1")
				.catch(() => undefined);
		});
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
		const job1 = invokeJobId(0);

		// invoke() がまだ resolve していない(jobId 未確定)うちに remove() する。
		act(() => {
			result.current.remove("clip-1");
		});
		expect(result.current.states.has("clip-1")).toBe(false);

		// ここで旧ジョブ(job1)の invoke がようやく resolve し、jobId が判明する。
		act(() => {
			resolveFirstInvoke?.();
		});

		// ghost 復活しない: states に "clip-1" が再登録されない。
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("reframe_cancel", { jobId: job1 }),
		);
		expect(result.current.states.has("clip-1")).toBe(false);
		// jobId が判明した時点で明示的にキャンセルされるため、購読も残らない。
		expect(mockEventListenerCount(`preview://done/${job1}`)).toBe(0);

		// 孤児化していた job1 の done が後から届いても、states には一切影響しない。
		act(() => {
			emitMockEvent(`preview://done/${job1}`, { path: "/cache/ghost.mp4" });
		});
		expect(result.current.states.has("clip-1")).toBe(false);

		// 同じ key への再 ensure() は新しい世代として独立に動く(旧ジョブに影響されない)。
		// 直前の reframe_cancel も mockInvoke の呼び出しに数えられるため、コマンド名で
		// 絞り込んで 2 回目の preview_start を特定する。
		let again!: Promise<string>;
		act(() => {
			again = result.current.ensure("clip-1", "/in.mp4", SPEC, "sig-2");
		});
		await waitFor(() => {
			const previewCalls = mockInvoke.mock.calls.filter(
				([cmd]) => cmd === "preview_start",
			);
			expect(previewCalls.length).toBe(2);
		});
		const previewCalls = mockInvoke.mock.calls.filter(
			([cmd]) => cmd === "preview_start",
		);
		const secondPreviewCall = previewCalls[1];
		if (!secondPreviewCall) {
			throw new Error("2 回目の preview_start 呼び出しが見つからない");
		}
		const job2 = (secondPreviewCall[1] as { jobId: string }).jobId;
		expect(job2).not.toBe(job1);
		act(() => {
			emitMockEvent(`preview://done/${job2}`, { path: "/cache/out2.mp4" });
		});
		await expect(again).resolves.toBe("/cache/out2.mp4");
		expect(result.current.states.get("clip-1")).toMatchObject({
			rendering: false,
			outputPath: "/cache/out2.mp4",
			sig: "sig-2",
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
