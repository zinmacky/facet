import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// `vite.config.ts` は Tauri dev サーバ向けの設定(固定ポート等)を持つため、
// テスト実行には巻き込まず独立させる。
export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		css: false,
		restoreMocks: true,
	},
});
