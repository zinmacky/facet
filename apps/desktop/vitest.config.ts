import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { publishSettingsEntryAlias, uploadEntryAlias } from "./edition.build";

// `vite.config.ts` は Tauri dev サーバ向けの設定(固定ポート等)を持つため、
// テスト実行には巻き込まず独立させる。
export default defineConfig({
	plugins: [react()],
	resolve: {
		// テスト実行時の既定 edition は "private"(現行テストを壊さないため)。
		// public 版固有の挙動は各テストファイルで `vi.mock("../lib/edition", …)` により
		// `EDITION`/`isPublicEdition` を差し替えて検証する(§src/App.public-edition.test.tsx)。
		alias: {
			...uploadEntryAlias("private", import.meta.url),
			...publishSettingsEntryAlias("private", import.meta.url),
		},
	},
	define: {
		// §src/lib/edition.ts / vite.config.ts と同じ定数(vitest はここで固定値を注入)。
		__FACET_EDITION__: JSON.stringify("private"),
	},
	test: {
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		css: false,
		restoreMocks: true,
	},
});
