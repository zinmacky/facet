import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	defineWorkersConfig,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// real D1 / Durable Object(workerd 上の miniflare)で動かす統合テスト用設定。
// 通常の `pnpm test`(vitest.config.ts、フェイクベースで高速)とは別プロジェクトとして
// `test:integration` スクリプトからのみ起動する。
//
// wrangler.toml はデプロイ用で database_id/kv id がプレースホルダのため参照しない。
// バインディングはここで直接定義し、miniflare が管理するテスト専用のローカル
// D1/KV/DO を都度生成する(コミット済み wrangler.toml の実 ID には触れない)。
export default defineWorkersConfig(async () => {
	const migrations = await readD1Migrations(
		path.join(dirname, "migrations"),
	);

	return {
		test: {
			include: ["test/integration/**/*.test.ts"],
			setupFiles: ["./test/integration/apply-migrations.ts"],
			poolOptions: {
				workers: {
					main: "./src/index.ts",
					miniflare: {
						compatibilityDate: "2024-09-23",
						compatibilityFlags: ["nodejs_compat"],
						d1Databases: ["DB"],
						kvNamespaces: ["TOKENS"],
						durableObjects: {
							PUBLISH_DO: "PublishDO",
						},
						bindings: {
							IG_USER_ID: "test-ig-user",
							IG_APP_ID: "test-ig-app",
							R2_PUBLIC_BASE: "https://media.example.test",
							GRAPH_VERSION: "v21.0",
							MAX_ATTEMPTS: "5",
							IG_APP_SECRET: "test-app-secret",
							SCHEDULER_API_TOKEN: "test-scheduler-token",
							// マイグレーション適用(test/integration/apply-migrations.ts)専用。
							// アプリの Env には存在しないテストだけのバインディング。
							TEST_MIGRATIONS: migrations,
						},
					},
				},
			},
		},
	};
});
