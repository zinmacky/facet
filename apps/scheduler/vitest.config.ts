import { defaultExclude, defineConfig } from "vitest/config";

// 通常の単体テスト用設定。real D1/DO を使う統合テストは vitest.integration.config.ts
// (test:integration) 側の別プロジェクトに分離し、こちらの `pnpm test`(高速・フェイク前提)
// には含めない。test/integration/ 配下は vitest-pool-workers 専用のため、こちら側の
// デフォルト include(**/*.test.ts)から明示的に除外する。
export default defineConfig({
	test: {
		exclude: [...defaultExclude, "test/integration/**"],
	},
});
