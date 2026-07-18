import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import {
	checkTokenExpiryAndForceRefresh,
	getTokenHealthSnapshot,
	refreshTokens,
	TOKEN_EXPIRY_WARNING_THRESHOLD_MS,
} from "./token-refresh.js";

// GHSA-6vwp-4jwx-8f3w: IG トークンリフレッシュ失敗の握りつぶし・失効監視なしの回帰テスト。
// - refreshTokens: 失効間近での失敗のみ health を記録し、成功でクリアする
// - checkTokenExpiryAndForceRefresh: 閾値割れで強制リフレッシュ、cooldown 内は間引く
// - getTokenHealthSnapshot: GET / の読み手として KV の状態を正しく反映する

const TOKEN_KEY = "ig_long_lived";
const TOKEN_EXPIRES_KEY = "ig_long_lived_expires_at";
const TOKEN_HEALTH_KEY = "ig_token_health";

/** TOKENS(KV)のインメモリフェイク。 */
function fakeTokensKV(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value);
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key);
		}),
		// テストから直接覗くための素の Map。
		__store: store,
	};
}

function envWithKV(kv: ReturnType<typeof fakeTokensKV>): Env {
	return {
		GRAPH_VERSION: "v21.0",
		// biome-ignore lint/suspicious/noExplicitAny: テスト用フェイクを KVNamespace 型へ流し込む
		TOKENS: kv as any,
	} as Env;
}

function mockFetchOnce(json: unknown, status = 200) {
	const fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify(json), {
				status,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("refreshTokens", () => {
	it("成功時はトークンと expires_at を更新し、既存の失敗記録をクリアする", async () => {
		const kv = fakeTokensKV({
			[TOKEN_KEY]: "old-token",
			[TOKEN_HEALTH_KEY]: JSON.stringify({
				lastRefreshError: "previous failure",
				failedAt: Date.now() - 1000,
			}),
		});
		mockFetchOnce({ access_token: "new-token", expires_in: 5_184_000 });

		await refreshTokens(envWithKV(kv));

		expect(kv.put).toHaveBeenCalledWith(TOKEN_KEY, "new-token");
		expect(kv.__store.get(TOKEN_HEALTH_KEY)).toBeUndefined();
	});

	it("失効間近での失敗は health レコードを記録する", async () => {
		const nearExpiry = Date.now() + 1000; // 閾値を大きく下回る
		const kv = fakeTokensKV({
			[TOKEN_KEY]: "old-token",
			[TOKEN_EXPIRES_KEY]: String(nearExpiry),
		});
		mockFetchOnce({ error: { message: "Invalid OAuth access token" } });

		await refreshTokens(envWithKV(kv));

		const raw = kv.__store.get(TOKEN_HEALTH_KEY);
		expect(raw).toBeDefined();
		const record = JSON.parse(raw as string);
		expect(record.lastRefreshError).toContain("Invalid OAuth access token");
	});

	it("期限に余裕がある状態での失敗は health レコードを記録しない(日次再試行に任せる)", async () => {
		const farExpiry = Date.now() + TOKEN_EXPIRY_WARNING_THRESHOLD_MS * 3;
		const kv = fakeTokensKV({
			[TOKEN_KEY]: "old-token",
			[TOKEN_EXPIRES_KEY]: String(farExpiry),
		});
		mockFetchOnce({ error: { message: "temporary graph error" } });

		await refreshTokens(envWithKV(kv));

		expect(kv.__store.get(TOKEN_HEALTH_KEY)).toBeUndefined();
	});

	it("expires_at 未記録での失敗は判定不能なため health レコードを記録しない", async () => {
		const kv = fakeTokensKV({ [TOKEN_KEY]: "old-token" });
		mockFetchOnce({ error: { message: "temporary graph error" } });

		await refreshTokens(envWithKV(kv));

		expect(kv.__store.get(TOKEN_HEALTH_KEY)).toBeUndefined();
	});

	it("access_token は更新できたが expires_in が無い場合は health を失敗扱いにする(cooldown を効かせるため)", async () => {
		const nearExpiry = Date.now() + 1000;
		const kv = fakeTokensKV({
			[TOKEN_KEY]: "old-token",
			[TOKEN_EXPIRES_KEY]: String(nearExpiry),
		});
		mockFetchOnce({ access_token: "new-token" }); // expires_in 欠落

		await refreshTokens(envWithKV(kv));

		expect(kv.__store.get(TOKEN_KEY)).toBe("new-token");
		// expires_at は更新されない(古い near-expiry のまま)。
		expect(kv.__store.get(TOKEN_EXPIRES_KEY)).toBe(String(nearExpiry));
		// health は失敗扱いで記録され、次分の checkTokenExpiryAndForceRefresh が
		// cooldown で間引かれるようになる。
		expect(kv.__store.get(TOKEN_HEALTH_KEY)).toBeDefined();
	});

	it("トークン未設定なら fetch を呼ばずに no-op", async () => {
		const kv = fakeTokensKV();
		const fetchMock = mockFetchOnce({});

		await refreshTokens(envWithKV(kv));

		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("checkTokenExpiryAndForceRefresh", () => {
	it("expires_at 未記録なら何もしない(fetch を呼ばない)", async () => {
		const kv = fakeTokensKV({ [TOKEN_KEY]: "token" });
		const fetchMock = mockFetchOnce({});

		await checkTokenExpiryAndForceRefresh(envWithKV(kv));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("残余期間が閾値以上なら何もしない", async () => {
		const farExpiry = Date.now() + TOKEN_EXPIRY_WARNING_THRESHOLD_MS * 2;
		const kv = fakeTokensKV({
			[TOKEN_KEY]: "token",
			[TOKEN_EXPIRES_KEY]: String(farExpiry),
		});
		const fetchMock = mockFetchOnce({});

		await checkTokenExpiryAndForceRefresh(envWithKV(kv));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("残余期間が閾値未満かつ直近の失敗記録が無ければ強制リフレッシュする", async () => {
		const nearExpiry = Date.now() + 1000;
		const kv = fakeTokensKV({
			[TOKEN_KEY]: "token",
			[TOKEN_EXPIRES_KEY]: String(nearExpiry),
		});
		const fetchMock = mockFetchOnce({
			access_token: "refreshed",
			expires_in: 5_184_000,
		});

		await checkTokenExpiryAndForceRefresh(envWithKV(kv));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(kv.__store.get(TOKEN_KEY)).toBe("refreshed");
	});

	it("直近の失敗記録が cooldown 内なら強制リフレッシュを間引く", async () => {
		const nearExpiry = Date.now() + 1000;
		const kv = fakeTokensKV({
			[TOKEN_KEY]: "token",
			[TOKEN_EXPIRES_KEY]: String(nearExpiry),
			[TOKEN_HEALTH_KEY]: JSON.stringify({
				lastRefreshError: "recent failure",
				failedAt: Date.now() - 5_000, // 直近(cooldown 内)
			}),
		});
		const fetchMock = mockFetchOnce({});

		await checkTokenExpiryAndForceRefresh(envWithKV(kv));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("直近の失敗記録が cooldown を過ぎていれば再度強制リフレッシュする", async () => {
		const nearExpiry = Date.now() + 1000;
		const kv = fakeTokensKV({
			[TOKEN_KEY]: "token",
			[TOKEN_EXPIRES_KEY]: String(nearExpiry),
			[TOKEN_HEALTH_KEY]: JSON.stringify({
				lastRefreshError: "old failure",
				failedAt: Date.now() - 2 * 60 * 60 * 1000, // 2時間前(cooldown=1時間を超過)
			}),
		});
		const fetchMock = mockFetchOnce({
			access_token: "refreshed-again",
			expires_in: 5_184_000,
		});

		await checkTokenExpiryAndForceRefresh(envWithKV(kv));

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("getTokenHealthSnapshot", () => {
	it("何も記録が無ければ健全な既定値を返す", async () => {
		const kv = fakeTokensKV();

		const snapshot = await getTokenHealthSnapshot(envWithKV(kv));

		expect(snapshot).toEqual({
			expiresAt: null,
			remainingMs: null,
			isNearExpiry: false,
			lastRefreshError: null,
			lastRefreshErrorAt: null,
		});
	});

	it("expires_at と health レコードを反映する", async () => {
		const nearExpiry = Date.now() + 1000;
		const failedAt = Date.now() - 500;
		const kv = fakeTokensKV({
			[TOKEN_EXPIRES_KEY]: String(nearExpiry),
			[TOKEN_HEALTH_KEY]: JSON.stringify({
				lastRefreshError: "graph error: unknown",
				failedAt,
			}),
		});

		const snapshot = await getTokenHealthSnapshot(envWithKV(kv));

		expect(snapshot.expiresAt).toBe(nearExpiry);
		expect(snapshot.isNearExpiry).toBe(true);
		expect(snapshot.lastRefreshError).toBe("graph error: unknown");
		expect(snapshot.lastRefreshErrorAt).toBe(failedAt);
	});

	it("health の JSON が壊れていれば null 扱いにする(例外を投げない)", async () => {
		const kv = fakeTokensKV({ [TOKEN_HEALTH_KEY]: "not-json" });

		const snapshot = await getTokenHealthSnapshot(envWithKV(kv));

		expect(snapshot.lastRefreshError).toBeNull();
	});
});
