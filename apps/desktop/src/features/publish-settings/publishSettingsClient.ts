import { invoke } from "@tauri-apps/api/core";

/**
 * `apps/desktop/src-tauri/src/commands/publish/` の invoke 境界に薄く対応する
 * renderer 側モジュール(§docs/desktop-migration-plan.md §11-3)。
 *
 * トークンの値そのものを取得する API は存在しない(Rust 側も返さない設計)。
 * 「保存済みか」の boolean と、疎通チェックの判別可能な結果のみを扱う。
 */

/** Rust 側 `ConnectionCheckResult`(serde の internally-tagged enum)と同形。 */
export type ConnectionCheckResult =
	| { status: "ok" }
	| { status: "no_url" }
	| { status: "no_token" }
	| { status: "unreachable"; detail: string }
	| { status: "unauthorized" }
	| { status: "service_unavailable" }
	| { status: "unexpected_status"; code: number };

/** scheduler の Bearer トークンをキーチェーンへ保存する(既存値は上書き)。 */
export function setSchedulerApiToken(token: string): Promise<void> {
	return invoke<void>("set_scheduler_api_token", { token });
}

/** トークンが保存済みかどうかだけを返す(値そのものは返らない)。 */
export function hasSchedulerApiToken(): Promise<boolean> {
	return invoke<boolean>("has_scheduler_api_token");
}

/** 保存済みトークンを削除する(未保存でも成功扱い)。 */
export function deleteSchedulerApiToken(): Promise<void> {
	return invoke<void>("delete_scheduler_api_token");
}

/**
 * scheduler への疎通を2段階(health → Bearer 認証)で確認する。
 * URL・トークンいずれも Rust 側がキーチェーンから読み出す(renderer からは渡さない —
 * GHSA-j74q-9v5x-87w3 対応: renderer が任意の URL を指定できると、WebView 侵害時に
 * 任意ホストへの疎通チェックを誘発できてしまう)。URL 未設定時は `{ status: "no_url" }`
 * が返る。
 */
export function checkSchedulerConnection(): Promise<ConnectionCheckResult> {
	return invoke<ConnectionCheckResult>("check_scheduler_connection");
}

/** R2(Cloudflare, S3 互換)資格情報の入力(§6.4)。 */
export interface R2CredentialsInput {
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** 空文字列なら Rust 側で既定値("facet-media")を使う。 */
	bucket: string;
}

/** R2 資格情報をキーチェーンへ保存する(既存値は上書き)。 */
export function setR2Credentials({
	accountId,
	accessKeyId,
	secretAccessKey,
	bucket,
}: R2CredentialsInput): Promise<void> {
	return invoke<void>("set_r2_credentials", {
		accountId,
		accessKeyId,
		secretAccessKey,
		bucket,
	});
}

/** R2 資格情報が保存済みかどうかだけを返す(値そのものは返らない)。 */
export function hasR2Credentials(): Promise<boolean> {
	return invoke<boolean>("has_r2_credentials");
}

/** 保存済みの R2 資格情報を削除する(未保存でも成功扱い)。 */
export function deleteR2Credentials(): Promise<void> {
	return invoke<void>("delete_r2_credentials");
}

/**
 * Rust 側 `YoutubeOauthStatus`(serde の internally-tagged enum)と同形。
 * - `not_configured`: クライアントID/シークレット未設定。
 * - `configured`: クライアント設定済みだが未接続(トークン未取得)。
 * - `connected`: 接続済み(トークンキャッシュあり)。
 */
export type YoutubeOauthStatus =
	| { status: "not_configured" }
	| { status: "configured" }
	| { status: "connected" };

/**
 * YouTube の OAuth クライアント(ユーザー自身の Google Cloud アプリの
 * client_id/client_secret)をキーチェーンへ保存する(既存値は上書き)。
 */
export function setYoutubeOauthClient(
	clientId: string,
	clientSecret: string,
): Promise<void> {
	return invoke<void>("set_youtube_oauth_client", { clientId, clientSecret });
}

/**
 * 保存済みの OAuth クライアントを削除する(キャッシュ済みトークンも道連れで削除される、
 * §src-tauri/src/commands/publish/youtube_oauth.rs)。
 */
export function deleteYoutubeOauthClient(): Promise<void> {
	return invoke<void>("delete_youtube_oauth_client");
}

/** 現在の YouTube 接続状態を返す(トークン値そのものは返らない)。 */
export function youtubeOauthStatus(): Promise<YoutubeOauthStatus> {
	return invoke<YoutubeOauthStatus>("youtube_oauth_status");
}

/**
 * 「Google と接続」の本体。ブラウザで OAuth 同意フローを行い、成功すればトークンが
 * キーチェーンへ保存される(値は renderer へ一切渡らない)。ユーザーがブラウザを
 * 放置した場合は Rust 側のタイムアウト(5分)で reject される。
 */
export function youtubeOauthConnect(): Promise<void> {
	return invoke<void>("youtube_oauth_connect");
}

/** 接続を切断する(トークンキャッシュのみ削除。クライアント設定は保持)。 */
export function youtubeOauthDisconnect(): Promise<void> {
	return invoke<void>("youtube_oauth_disconnect");
}
