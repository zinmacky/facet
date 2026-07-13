import type { Context, Next } from "hono";
import { timingSafeEqual } from "hono/utils/buffer";
import type { Env } from "./env.js";

const AUTHORIZATION_HEADER = "Authorization";
// RFC 6750: scheme("Bearer")は大文字小文字を区別しない。
const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

/**
 * Bearer トークン認証ミドルウェア。
 *
 * - `SCHEDULER_API_TOKEN`(wrangler secret)が未設定の場合は fail-closed で 503 を返す。
 *   「未設定なら無認証で通す」は絶対に行わない。
 * - Authorization ヘッダ欠如・形式不正・トークン不一致は 401。
 * - トークン比較は `hono/utils/buffer` の `timingSafeEqual`(SHA-256 ハッシュ後に
 *   定数時間比較)を用い、タイミング攻撃を避ける。
 */
export function requireBearerAuth() {
	return async (c: Context<{ Bindings: Env }>, next: Next) => {
		const expected = c.env.SCHEDULER_API_TOKEN;
		if (!expected) {
			return c.json({ error: "scheduler not configured" }, 503);
		}

		const header = c.req.header(AUTHORIZATION_HEADER);
		const match = header ? BEARER_PATTERN.exec(header) : null;
		if (!match) {
			return c.json({ error: "unauthorized" }, 401);
		}

		// キャプチャグループは正規表現上必ずマッチするが、
		// noUncheckedIndexedAccess により型上は string | undefined になる。
		const provided = match[1];
		if (provided === undefined) {
			return c.json({ error: "unauthorized" }, 401);
		}
		const ok = await timingSafeEqual(expected, provided);
		if (!ok) {
			return c.json({ error: "unauthorized" }, 401);
		}

		await next();
	};
}
