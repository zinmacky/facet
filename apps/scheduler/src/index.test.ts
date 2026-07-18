import { describe, expect, it } from "vitest";
import type { Env } from "./env.js";
import { app } from "./index.js";

const TOKEN = "secret-token";

/** TOKENS(KV)のインメモリフェイク。GET / が token 健全性を読むのに必要。 */
function fakeTokensKV(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		delete: async (key: string) => {
			store.delete(key);
		},
	};
}

function envWithToken(
	token: string | undefined,
	tokens: Record<string, string> = {},
): Env {
	return {
		SCHEDULER_API_TOKEN: token,
		// biome-ignore lint/suspicious/noExplicitAny: テスト用フェイクを KVNamespace 型へ流し込む
		TOKENS: fakeTokensKV(tokens) as any,
	} as Env;
}

describe("scheduler app の認証配線", () => {
	it("GET /health はトークン無しでも 200", async () => {
		const res = await app.request("/health", {}, envWithToken(undefined));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("GET /health は誤ったトークンを付けても認証を無視して 200", async () => {
		const res = await app.request(
			"/health",
			{ headers: { Authorization: "Bearer wrong-token" } },
			envWithToken(TOKEN),
		);
		expect(res.status).toBe(200);
	});

	it("GET / はトークン無しなら 401", async () => {
		const res = await app.request("/", {}, envWithToken(TOKEN));
		expect(res.status).toBe(401);
	});

	it("GET / は SCHEDULER_API_TOKEN 未設定なら fail-closed で 503", async () => {
		const res = await app.request("/", {}, envWithToken(undefined));
		expect(res.status).toBe(503);
	});

	it("GET / は正しいトークンで 200", async () => {
		const res = await app.request(
			"/",
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
			envWithToken(TOKEN),
		);
		expect(res.status).toBe(200);
	});

	// GHSA-6vwp-4jwx-8f3w: token 健全性(expires_at 等)の読み手が無かったため、
	// GET / の body に含めて疎通チェック経由で参照できるようにした。
	it("GET / の body に tokenHealth が含まれる(健全な状態)", async () => {
		const res = await app.request(
			"/",
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
			envWithToken(TOKEN),
		);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json).toMatchObject({
			tokenHealth: {
				expiresAt: null,
				remainingMs: null,
				isNearExpiry: false,
				lastRefreshError: null,
				lastRefreshErrorAt: null,
			},
		});
	});

	it("GET / の body の tokenHealth に直近の失敗記録が反映される", async () => {
		const failedAt = Date.now() - 1000;
		const nearExpiry = Date.now() + 1000; // 閾値(10日)を大きく下回る
		const res = await app.request(
			"/",
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
			envWithToken(TOKEN, {
				ig_long_lived_expires_at: String(nearExpiry),
				ig_token_health: JSON.stringify({
					lastRefreshError: "graph error: invalid token",
					failedAt,
				}),
			}),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			tokenHealth: {
				isNearExpiry: boolean;
				lastRefreshError: string | null;
				lastRefreshErrorAt: number | null;
			};
		};
		expect(json.tokenHealth.isNearExpiry).toBe(true);
		expect(json.tokenHealth.lastRefreshError).toBe(
			"graph error: invalid token",
		);
		expect(json.tokenHealth.lastRefreshErrorAt).toBe(failedAt);
	});

	// DB バインディングは envWithToken() で未設定のため、認証段で弾かれず route
	// ハンドラまで到達すると DB アクセスで例外が発生し 500 系になり 401 にはならない。
	// 401 が返ること自体が、認証ミドルウェアで止まり route に入っていない証拠になる。
	it("POST /jobs はトークン無しなら 401(認証段で止まり DB アクセスまで進まない)", async () => {
		const res = await app.request(
			"/jobs",
			{ method: "POST", body: JSON.stringify({}) },
			envWithToken(TOKEN),
		);
		expect(res.status).toBe(401);
	});

	it("GET /jobs/:id はトークン無しなら 401(認証段で止まり DB アクセスまで進まない)", async () => {
		const res = await app.request("/jobs/some-id", {}, envWithToken(TOKEN));
		expect(res.status).toBe(401);
	});
});
