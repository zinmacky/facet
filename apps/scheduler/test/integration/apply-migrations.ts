import { applyD1Migrations, env } from "cloudflare:test";

// vitest.integration.config.ts が `migrations/` から読み取った D1Migration[] を
// TEST_MIGRATIONS という(テスト専用の)バインディング名で注入している。
// ここで実 D1(workerd 上の SQLite)に適用してから各テストファイルを実行する。
// ProvidedEnv の型拡張は同ディレクトリの env.d.ts(アンビエント宣言)が持つ。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
