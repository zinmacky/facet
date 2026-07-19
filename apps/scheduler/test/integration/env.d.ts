import type { Env } from "../../src/env.js";

// `cloudflare:test` の env をアプリの Env 型で受けられるようにするアンビエント宣言。
// TEST_MIGRATIONS は apply-migrations.ts 専用でアプリの Env には無いため別途足す。
declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {
		TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers/config").D1Migration[];
	}
}
