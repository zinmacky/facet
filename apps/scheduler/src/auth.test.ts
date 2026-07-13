import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireBearerAuth } from "./auth.js";
import type { Env } from "./env.js";

const TOKEN = "secret-token";

/** requireBearerAuth 単体の検証用に、保護ルート1本だけの最小アプリを組み立てる。 */
function buildTestApp() {
	const app = new Hono<{ Bindings: Env }>();
	app.use("*", requireBearerAuth());
	app.get("/protected", (c) => c.json({ ok: true }));
	return app;
}

/** SCHEDULER_API_TOKEN 以外のフィールドはこのミドルウェアが参照しないため未設定でよい。 */
function envWithToken(token: string | undefined): Env {
	return { SCHEDULER_API_TOKEN: token } as Env;
}

describe("requireBearerAuth", () => {
	it("有効なトークンなら 200", async () => {
		const app = buildTestApp();
		const res = await app.request(
			"/protected",
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
			envWithToken(TOKEN),
		);
		expect(res.status).toBe(200);
	});

	it("不一致のトークンなら 401", async () => {
		const app = buildTestApp();
		const res = await app.request(
			"/protected",
			{ headers: { Authorization: "Bearer wrong-token" } },
			envWithToken(TOKEN),
		);
		expect(res.status).toBe(401);
	});

	it("Authorization ヘッダが無ければ 401", async () => {
		const app = buildTestApp();
		const res = await app.request("/protected", {}, envWithToken(TOKEN));
		expect(res.status).toBe(401);
	});

	it("Bearer 形式でないヘッダなら 401", async () => {
		const app = buildTestApp();
		const res = await app.request(
			"/protected",
			{ headers: { Authorization: TOKEN } },
			envWithToken(TOKEN),
		);
		expect(res.status).toBe(401);
	});

	it("SCHEDULER_API_TOKEN 未設定なら fail-closed で 503(正しいヘッダを付けても)", async () => {
		const app = buildTestApp();
		const res = await app.request(
			"/protected",
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
			envWithToken(undefined),
		);
		expect(res.status).toBe(503);
	});

	it("SCHEDULER_API_TOKEN が空文字でも fail-closed で 503", async () => {
		const app = buildTestApp();
		const res = await app.request(
			"/protected",
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
			envWithToken(""),
		);
		expect(res.status).toBe(503);
	});
});
