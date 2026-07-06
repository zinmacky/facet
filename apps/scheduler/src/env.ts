/**
 * Worker のバインディング一式。wrangler.toml の binding / vars / secret に対応する。
 * vars は文字列でしか渡らないため、数値(MAX_ATTEMPTS)も string で受けて利用側でパースする。
 */
export interface Env {
	// バインディング
	DB: D1Database;
	TOKENS: KVNamespace;
	PUBLISH_DO: DurableObjectNamespace;

	// vars
	IG_USER_ID: string;
	IG_APP_ID: string;
	R2_PUBLIC_BASE: string;
	GRAPH_VERSION: string;
	MAX_ATTEMPTS: string;

	// secret(wrangler secret で投入)
	IG_APP_SECRET: string;
}
