import type { Env } from "./env.js";

/** KV に保管する長期トークンのキー。instagram.ts と共有。 */
const TOKEN_KEY = "ig_long_lived";
/** トークンの有効期限メタ(unix ms)を保管するキー。 */
const TOKEN_EXPIRES_KEY = "ig_long_lived_expires_at";
/**
 * トークンの健全性(直近リフレッシュ失敗の記録)を保管するキー。
 * 「失効が近い状態でのリフレッシュ失敗」のみを記録する(GHSA-6vwp-4jwx-8f3w 対応)。
 * 成功時は削除する。index.ts の `GET /` がこれを読み、監視の read 側を提供する。
 */
const TOKEN_HEALTH_KEY = "ig_token_health";

/**
 * この残余期間を下回ったら「失効間近」とみなす(約60日の長期トークンに対し10日)。
 * 毎日3時の通常リフレッシュが何らかの理由で連続失敗しても、この閾値内であれば
 * 毎分の cron から強制リフレッシュを試みて延命の猶予を稼ぐ。
 */
export const TOKEN_EXPIRY_WARNING_THRESHOLD_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * 失効間近と判定した状態での強制リフレッシュ再試行の最小間隔。
 * 毎分 cron からそのまま毎分 Graph API を叩くと過剰呼び出しになるため、
 * 直近の失敗記録(TOKEN_HEALTH_KEY.failedAt)を見て間引く。
 */
const FORCE_REFRESH_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

/** GET / のレスポンスに載せるトークン健全性情報。 */
export interface TokenHealthSnapshot {
	/** 現在保持しているトークンの失効予定時刻(unix ms)。未記録なら null。 */
	expiresAt: number | null;
	/** 失効までの残余ミリ秒。expiresAt が無ければ null。 */
	remainingMs: number | null;
	/** 残余期間が閾値を下回っているか。 */
	isNearExpiry: boolean;
	/** 直近のリフレッシュ失敗メッセージ(失効間近の状態で発生したもののみ)。無ければ null。 */
	lastRefreshError: string | null;
	/** 上記失敗の発生時刻(unix ms)。無ければ null。 */
	lastRefreshErrorAt: number | null;
}

/** KV に書く健全性レコードの形。 */
interface TokenHealthRecord {
	lastRefreshError: string;
	failedAt: number;
}

async function readExpiresAt(env: Env): Promise<number | null> {
	const raw = await env.TOKENS.get(TOKEN_EXPIRES_KEY);
	if (raw === null) {
		return null;
	}
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : null;
}

async function readHealthRecord(env: Env): Promise<TokenHealthRecord | null> {
	const raw = await env.TOKENS.get(TOKEN_HEALTH_KEY);
	if (raw === null) {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<TokenHealthRecord>;
		if (
			typeof parsed.lastRefreshError === "string" &&
			typeof parsed.failedAt === "number"
		) {
			return {
				lastRefreshError: parsed.lastRefreshError,
				failedAt: parsed.failedAt,
			};
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * `GET /` のレスポンス用に、現在のトークン健全性を KV から読み出す。
 * これまで expires_at・health ともに put するだけで読み手が無かった箇所を埋める。
 */
export async function getTokenHealthSnapshot(
	env: Env,
): Promise<TokenHealthSnapshot> {
	const expiresAt = await readExpiresAt(env);
	const remainingMs = expiresAt === null ? null : expiresAt - Date.now();
	const isNearExpiry =
		remainingMs !== null && remainingMs < TOKEN_EXPIRY_WARNING_THRESHOLD_MS;
	const health = await readHealthRecord(env);

	return {
		expiresAt,
		remainingMs,
		isNearExpiry,
		lastRefreshError: health?.lastRefreshError ?? null,
		lastRefreshErrorAt: health?.failedAt ?? null,
	};
}

/**
 * 毎日3時の cron で呼ばれる。IG 長期トークンを ig_refresh_token で更新し KV に書き戻す。
 * 長期トークンは約60日で失効するため、期限内に定期リフレッシュして延命する。
 * トークン未設定なら何もしない(no-op)。
 *
 * `forcedByExpiryWatch` は毎分 cron からの強制呼び出しであることを示す。ログ用途のみで
 * 挙動は変えない(強制呼び出しでも通常のリフレッシュ処理をそのまま行う)。
 */
export async function refreshTokens(
	env: Env,
	opts?: { forcedByExpiryWatch?: boolean },
): Promise<void> {
	const current = await env.TOKENS.get(TOKEN_KEY);
	if (current === null || current === "") {
		console.log("token-refresh: ig_long_lived not set, skipping");
		return;
	}

	// 失敗時にアラート要否(失効間近か)を判定するため、リフレッシュ前の期限を控えておく。
	// 成功すれば expires_at は更新されるが、失敗時はこの値が「現在の期限」のまま。
	const expiresAtBeforeAttempt = await readExpiresAt(env);

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
		const message = `non-JSON response (status ${res.status})`;
		console.error(`token-refresh: ${message}`);
		await recordFailureIfNearExpiry(env, message, expiresAtBeforeAttempt);
		return;
	}

	if (typeof body === "object" && body !== null && "error" in body) {
		const err = (body as { error?: { message?: string } }).error;
		const message = `graph error: ${err?.message ?? "unknown"}`;
		console.error(`token-refresh: ${message}`);
		await recordFailureIfNearExpiry(env, message, expiresAtBeforeAttempt);
		return;
	}

	const data = body as { access_token?: unknown; expires_in?: unknown };
	if (typeof data.access_token !== "string") {
		const message = "response missing access_token";
		console.error(`token-refresh: ${message}`);
		await recordFailureIfNearExpiry(env, message, expiresAtBeforeAttempt);
		return;
	}

	await env.TOKENS.put(TOKEN_KEY, data.access_token);
	if (typeof data.expires_in !== "number") {
		// access_token 自体は更新できたが expires_in が無く、新しい失効時刻を確定できない。
		// expires_at を更新しないまま health をクリアすると、旧 expires_at が失効間近のとき
		// checkTokenExpiryAndForceRefresh の cooldown が効かず毎分リフレッシュを叩き続けてしまう。
		// そのため health 側は失敗扱いにして cooldown を効かせる。
		const message =
			"response missing expires_in (access_token was refreshed but expiry unknown)";
		console.error(`token-refresh: ${message}`);
		await recordFailureIfNearExpiry(env, message, expiresAtBeforeAttempt);
		return;
	}
	const expiresAt = Date.now() + data.expires_in * 1000;
	await env.TOKENS.put(TOKEN_EXPIRES_KEY, String(expiresAt));
	// 成功したので過去の失敗記録は消す(アラートを解消する)。
	await env.TOKENS.delete(TOKEN_HEALTH_KEY);
	console.log(
		`token-refresh: ig_long_lived refreshed${opts?.forcedByExpiryWatch ? " (forced by expiry watch)" : ""}`,
	);
}

/** 失効間近の状態での失敗のみ health レコードとして残す(遠い将来の失敗は日次再試行に任せる)。 */
async function recordFailureIfNearExpiry(
	env: Env,
	message: string,
	expiresAtBeforeAttempt: number | null,
): Promise<void> {
	const remainingMs =
		expiresAtBeforeAttempt === null
			? null
			: expiresAtBeforeAttempt - Date.now();
	const isNearExpiry =
		remainingMs !== null && remainingMs < TOKEN_EXPIRY_WARNING_THRESHOLD_MS;
	if (!isNearExpiry) {
		return;
	}
	const record: TokenHealthRecord = {
		lastRefreshError: message,
		failedAt: Date.now(),
	};
	await env.TOKENS.put(TOKEN_HEALTH_KEY, JSON.stringify(record));
}

/**
 * 毎分の cron から呼ぶ。expires_at の残余期間が閾値を下回っていれば、
 * 毎日3時の通常周期を待たずに強制リフレッシュを試みる。
 * 直近の失敗記録が cooldown 内であれば、Graph API への過剰呼び出しを避けるため間引く。
 */
export async function checkTokenExpiryAndForceRefresh(env: Env): Promise<void> {
	const expiresAt = await readExpiresAt(env);
	if (expiresAt === null) {
		// 期限メタが無い(未リフレッシュ等)場合は判定不能。通常の日次サイクルに任せる。
		return;
	}
	const remainingMs = expiresAt - Date.now();
	if (remainingMs >= TOKEN_EXPIRY_WARNING_THRESHOLD_MS) {
		return;
	}

	const health = await readHealthRecord(env);
	if (
		health !== null &&
		Date.now() - health.failedAt < FORCE_REFRESH_RETRY_COOLDOWN_MS
	) {
		return;
	}

	console.warn(
		`token-refresh: expires in ${Math.round(remainingMs / (60 * 60 * 1000))}h, forcing refresh`,
	);
	await refreshTokens(env, { forcedByExpiryWatch: true });
}
