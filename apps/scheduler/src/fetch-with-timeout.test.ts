import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, GRAPH_API_TIMEOUT_MS } from "./fetch-with-timeout.js";

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("fetchWithTimeout", () => {
	it("正常に応答があればそのまま Response を返す(タイマーは解除される)", async () => {
		const fetchMock = vi.fn(
			async () => new Response("ok", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const res = await fetchWithTimeout("https://example.com", { method: "GET" });

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// signal が付与されている(呼び出し元が abort できる)ことを確認する。
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("timeoutMs を過ぎても応答が無ければ abort し、わかりやすいメッセージの Error で reject する", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn((_url: string, init: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted.", "AbortError"));
				});
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const promise = fetchWithTimeout(
			"https://example.com",
			{ method: "GET" },
			1_000,
		);
		const assertion = expect(promise).rejects.toThrow(
			"fetch timed out after 1000ms: https://example.com",
		);

		await vi.advanceTimersByTimeAsync(1_500);
		await assertion;
	});

	it("timeoutMs を省略すると GRAPH_API_TIMEOUT_MS が既定値として使われる", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn((_url: string, init: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted.", "AbortError"));
				});
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const promise = fetchWithTimeout("https://example.com", { method: "GET" });
		const assertion = expect(promise).rejects.toThrow(
			`fetch timed out after ${GRAPH_API_TIMEOUT_MS}ms`,
		);

		await vi.advanceTimersByTimeAsync(GRAPH_API_TIMEOUT_MS + 1_000);
		await assertion;
	});

	it("AbortError 以外のネットワークエラーはそのまま(メッセージを書き換えずに)伝播する", async () => {
		const fetchMock = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchWithTimeout("https://example.com", { method: "GET" }),
		).rejects.toThrow("fetch failed");
	});
});
