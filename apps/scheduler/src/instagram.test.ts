import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import { GRAPH_API_TIMEOUT_MS } from "./fetch-with-timeout.js";
import {
	createContainer,
	getContainerStatus,
	publishContainer,
} from "./instagram.js";

// Graph API 呼び出しの認証がヘッダ経由(Authorization: Bearer)で行われ、
// URL クエリ・ボディにアクセストークンが漏れないことを検証する(S-4 対策)。

const env = {
	GRAPH_VERSION: "v21.0",
	IG_USER_ID: "1784",
} as unknown as Env;

const TOKEN = "SECRET_TOKEN_VALUE";

function mockFetch(json: unknown) {
	const fetchMock = vi.fn(async () =>
		new Response(JSON.stringify(json), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

/** 直近の fetch 呼び出しの url / init を取り出す。 */
function lastCall(fetchMock: ReturnType<typeof vi.fn>): {
	url: string;
	init: RequestInit;
} {
	const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
	return { url, init };
}

function headerValue(init: RequestInit, name: string): string | undefined {
	const headers = (init.headers ?? {}) as Record<string, string>;
	return headers[name] ?? headers[name.toLowerCase()];
}

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Graph API 呼び出しはトークンをヘッダで渡す", () => {
	it("getContainerStatus は URL にトークンを載せず Authorization ヘッダを使う", async () => {
		const fetchMock = mockFetch({ status_code: "FINISHED" });
		await getContainerStatus(env, TOKEN, "container-1");

		const { url, init } = lastCall(fetchMock);
		expect(url).not.toContain(TOKEN);
		expect(url).not.toContain("access_token");
		expect(headerValue(init, "authorization")).toBe(`Bearer ${TOKEN}`);
	});

	it("createContainer はボディ・URL にトークンを載せず Authorization ヘッダを使う", async () => {
		const fetchMock = mockFetch({ id: "container-1" });
		await createContainer(env, TOKEN, {
			videoUrl: "https://example.com/v.mp4",
			caption: "cap",
			mediaType: "REELS",
		});

		const { url, init } = lastCall(fetchMock);
		expect(url).not.toContain(TOKEN);
		expect(String(init.body)).not.toContain(TOKEN);
		expect(String(init.body)).not.toContain("access_token");
		expect(headerValue(init, "authorization")).toBe(`Bearer ${TOKEN}`);
	});

	it("publishContainer はボディ・URL にトークンを載せず Authorization ヘッダを使う", async () => {
		const fetchMock = mockFetch({ id: "media-1" });
		await publishContainer(env, TOKEN, "container-1");

		const { url, init } = lastCall(fetchMock);
		expect(url).not.toContain(TOKEN);
		expect(String(init.body)).not.toContain(TOKEN);
		expect(String(init.body)).not.toContain("access_token");
		expect(headerValue(init, "authorization")).toBe(`Bearer ${TOKEN}`);
	});
});

/**
 * Graph API 呼び出しがハングしたまま応答しない場合、fetchWithTimeout により
 * GRAPH_API_TIMEOUT_MS 経過で abort され、DO の handleFailure が拾える通常の
 * Error として reject することを検証する(MEDIUM 指摘1)。
 */
describe("Graph API 呼び出しは応答が無ければタイムアウトする(fetchWithTimeout)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** abort されるまで永久に pending な fetch。init.signal の abort を見て reject する。 */
	function mockHangingFetch() {
		const fetchMock = vi.fn((_url: string, init: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted.", "AbortError"));
				});
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("createContainer は GRAPH_API_TIMEOUT_MS を超えて応答が無いと timeout エラーで reject する", async () => {
		mockHangingFetch();

		const promise = createContainer(env, TOKEN, {
			videoUrl: "https://example.com/v.mp4",
			caption: "cap",
			mediaType: "REELS",
		});
		// 先に rejection ハンドラを仕込んでから時間を進める(unhandled rejection 回避)。
		const assertion = expect(promise).rejects.toThrow(/timed out/i);

		await vi.advanceTimersByTimeAsync(GRAPH_API_TIMEOUT_MS + 1_000);

		await assertion;
	});

	it("getContainerStatus も GRAPH_API_TIMEOUT_MS でタイムアウトする", async () => {
		mockHangingFetch();

		const promise = getContainerStatus(env, TOKEN, "container-1");
		const assertion = expect(promise).rejects.toThrow(/timed out/i);

		await vi.advanceTimersByTimeAsync(GRAPH_API_TIMEOUT_MS + 1_000);

		await assertion;
	});

	it("publishContainer も GRAPH_API_TIMEOUT_MS でタイムアウトする", async () => {
		mockHangingFetch();

		const promise = publishContainer(env, TOKEN, "container-1");
		const assertion = expect(promise).rejects.toThrow(/timed out/i);

		await vi.advanceTimersByTimeAsync(GRAPH_API_TIMEOUT_MS + 1_000);

		await assertion;
	});
});
