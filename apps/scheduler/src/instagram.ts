import type { MediaType } from "@facet/contract";
import type { Env } from "./env.js";

/** コンテナの処理状態。Graph API の status_code に対応する。 */
export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED";

/** KV に保管する長期トークンのキー。 */
const TOKEN_KEY = "ig_long_lived";

/**
 * Graph API のエラー。message にレスポンス由来の説明を載せる。
 * DO 側で attempts++ の対象として捕捉する。
 * `code` / `subcode` は Graph の `error.code` / `error.error_subcode`(あれば)を保持し、
 * 文言に依存しないエラー分類(例: 二重 publish 判定)やログ診断に使う。
 */
export class InstagramError extends Error {
	readonly code?: number;
	readonly subcode?: number;

	constructor(message: string, opts?: { code?: number; subcode?: number }) {
		super(message);
		this.name = "InstagramError";
		this.code = opts?.code;
		this.subcode = opts?.subcode;
	}
}

/** KV から長期トークンを取得する。未設定なら例外。 */
export async function getIgToken(env: Env): Promise<string> {
	const token = await env.TOKENS.get(TOKEN_KEY);
	if (token === null || token === "") {
		throw new InstagramError("ig_long_lived token is not set in KV");
	}
	return token;
}

/** Graph API のベース URL を組み立てる。 */
function graphUrl(env: Env, path: string): string {
	return `https://graph.facebook.com/${env.GRAPH_VERSION}/${path}`;
}

/**
 * アクセストークンは URL クエリやボディではなく `Authorization: Bearer` ヘッダで渡す。
 * URL クエリに載せると Worker/プロキシ/Graph 側のアクセスログに残りやすいため
 * (Graph API はヘッダ渡しを正式サポートする)。呼び出し側は返り値を fetch の
 * `headers` にスプレッドして使う。
 */
function authHeader(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

/**
 * Graph API のレスポンスを JSON として読み、エラー形状(`{error:{message}}`)なら例外にする。
 * HTTP ステータスが失敗でも Graph はボディにエラーを載せるため、常にボディを検査する。
 */
async function readGraphJson(res: Response): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		throw new InstagramError(
			`graph API returned non-JSON (status ${res.status})`,
		);
	}
	if (typeof body === "object" && body !== null && "error" in body) {
		const err = (
			body as {
				error?: { message?: string; code?: number; error_subcode?: number };
			}
		).error;
		throw new InstagramError(
			err?.message ?? `graph API error (status ${res.status})`,
			{ code: err?.code, subcode: err?.error_subcode },
		);
	}
	if (!res.ok) {
		throw new InstagramError(
			`graph API request failed with status ${res.status}`,
		);
	}
	return body as Record<string, unknown>;
}

/**
 * コンテナ生成(手順1)。REELS は media_type=REELS、それ以外(VIDEO)も動画として video_url を渡す。
 * コンテナは約24時間で失効するため、公開時刻の到来後にのみ呼ぶこと。
 */
export async function createContainer(
	env: Env,
	token: string,
	params: { videoUrl: string; caption: string; mediaType: MediaType },
): Promise<string> {
	const body = new URLSearchParams({
		media_type: params.mediaType,
		video_url: params.videoUrl,
		caption: params.caption,
	});
	const res = await fetch(graphUrl(env, `${env.IG_USER_ID}/media`), {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...authHeader(token),
		},
		body,
	});
	const json = await readGraphJson(res);
	const id = json.id;
	if (typeof id !== "string") {
		throw new InstagramError("createContainer response missing id");
	}
	return id;
}

/** コンテナの処理完了ポーリング(手順2)。status_code を返す。 */
export async function getContainerStatus(
	env: Env,
	token: string,
	containerId: string,
): Promise<ContainerStatus> {
	const query = new URLSearchParams({
		fields: "status_code",
	});
	const res = await fetch(graphUrl(env, `${containerId}?${query.toString()}`), {
		method: "GET",
		headers: authHeader(token),
	});
	const json = await readGraphJson(res);
	const status = json.status_code;
	if (
		status !== "IN_PROGRESS" &&
		status !== "FINISHED" &&
		status !== "ERROR" &&
		status !== "EXPIRED"
	) {
		throw new InstagramError(`unexpected status_code: ${String(status)}`);
	}
	return status;
}

/** 公開(手順3)。creation_id にコンテナ ID を渡し、media_id を得る。 */
export async function publishContainer(
	env: Env,
	token: string,
	containerId: string,
): Promise<string> {
	const body = new URLSearchParams({
		creation_id: containerId,
	});
	const res = await fetch(graphUrl(env, `${env.IG_USER_ID}/media_publish`), {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...authHeader(token),
		},
		body,
	});
	const json = await readGraphJson(res);
	const id = json.id;
	if (typeof id !== "string") {
		throw new InstagramError("publishContainer response missing id");
	}
	return id;
}
