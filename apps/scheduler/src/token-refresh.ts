import type { Env } from "./env.js";

/** KV に保管する長期トークンのキー。instagram.ts と共有。 */
const TOKEN_KEY = "ig_long_lived";
/** トークンの有効期限メタ(unix ms)を保管するキー。 */
const TOKEN_EXPIRES_KEY = "ig_long_lived_expires_at";

/**
 * 毎日3時の cron で呼ばれる。IG 長期トークンを ig_refresh_token で更新し KV に書き戻す。
 * 長期トークンは約60日で失効するため、期限内に定期リフレッシュして延命する。
 * トークン未設定なら何もしない(no-op)。
 */
export async function refreshTokens(env: Env): Promise<void> {
  const current = await env.TOKENS.get(TOKEN_KEY);
  if (current === null || current === "") {
    console.log("token-refresh: ig_long_lived not set, skipping");
    return;
  }

  const query = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: current,
  });
  const url = `https://graph.facebook.com/${env.GRAPH_VERSION}/refresh_access_token?${query.toString()}`;

  const res = await fetch(url, { method: "GET" });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    console.error(`token-refresh: non-JSON response (status ${res.status})`);
    return;
  }

  if (typeof body === "object" && body !== null && "error" in body) {
    const err = (body as { error?: { message?: string } }).error;
    console.error(`token-refresh: graph error: ${err?.message ?? "unknown"}`);
    return;
  }

  const data = body as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string") {
    console.error("token-refresh: response missing access_token");
    return;
  }

  await env.TOKENS.put(TOKEN_KEY, data.access_token);
  if (typeof data.expires_in === "number") {
    const expiresAt = Date.now() + data.expires_in * 1000;
    await env.TOKENS.put(TOKEN_EXPIRES_KEY, String(expiresAt));
  }
  console.log("token-refresh: ig_long_lived refreshed");
}
