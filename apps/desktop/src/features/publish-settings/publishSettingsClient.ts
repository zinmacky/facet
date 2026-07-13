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
 * トークンは Rust 側がキーチェーンから読み出す(renderer からは渡さない)。
 */
export function checkSchedulerConnection(
	schedulerUrl: string,
): Promise<ConnectionCheckResult> {
	return invoke<ConnectionCheckResult>("check_scheduler_connection", {
		schedulerUrl,
	});
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
