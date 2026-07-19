import type { Context, Next } from "hono";
import type { Env } from "./env.js";

const AUTHORIZATION_HEADER = "Authorization";
// RFC 6750: scheme("Bearer")は大文字小文字を区別しない。
const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

/** 文字列を SHA-256 でハッシュ化し16進文字列で返す(Web Crypto の digest を使用)。 */
async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input),
	);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

/** 文字列長で早期リターンせず全文字を走査してから結果を返す、定数時間の文字列比較。 */
function constantTimeEqual(a: string, b: string): boolean {
	const maxLen = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < maxLen; i++) {
		const charA = i < a.length ? a.charCodeAt(i) : 0;
		const charB = i < b.length ? b.charCodeAt(i) : 0;
		diff |= charA ^ charB;
	}
	return diff === 0;
}

/**
 * `hono/utils/buffer` の `timingSafeEqual` と同じ手順(両者を SHA-256 でハッシュ化した上で
 * 定数時間比較し、さらに元の文字列同士も定数時間比較する)をローカルに再実装したもの。
 * 同モジュールは internal path(セマンティックバージョニング対象外)のため、直接
 * import せずここで自前実装して依存を切り離す。
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const [hashA, hashB] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
	return constantTimeEqual(hashA, hashB) && constantTimeEqual(a, b);
}

/**
 * Bearer トークン認証ミドルウェア。
 *
 * - `SCHEDULER_API_TOKEN`(wrangler secret)が未設定の場合は fail-closed で 503 を返す。
 *   「未設定なら無認証で通す」は絶対に行わない。
 * - Authorization ヘッダ欠如・形式不正・トークン不一致は 401。
 * - トークン比較は本ファイル内の `timingSafeEqual`(SHA-256 ハッシュ後に定数時間比較)を
 *   用い、タイミング攻撃を避ける。
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
