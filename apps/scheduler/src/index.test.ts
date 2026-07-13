import { describe, expect, it } from "vitest";
import type { Env } from "./env.js";
import { app } from "./index.js";

const TOKEN = "secret-token";

function envWithToken(token: string | undefined): Env {
	return { SCHEDULER_API_TOKEN: token } as Env;
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
