import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// Tauri が期待する固定ポート。studio/web(5178/5179)と衝突しないよう 5180 を使う。
const TAURI_DEV_PORT = 5180;
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// Rust 側のエラー出力を vite が隠さないようにする
	clearScreen: false,
	server: {
		port: TAURI_DEV_PORT,
		// Tauri は固定ポートを期待するため、使用不可なら失敗させる
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			// src-tauri の変更で vite の再読み込みを走らせない
			ignored: ["**/src-tauri/**"],
		},
		// renderer は studio-server(HTTP)を持たない — 元動画/書き出し/投稿は
		// すべて Tauri invoke(`lib/tauri.ts`)経由で行うため dev proxy は不要
		// (bulk-download バグ修正で studio-server 依存の fetch 呼び出しを撤去した)。
	},
	envPrefix: ["VITE_", "TAURI_ENV_*"],
	build: {
		// Tauri は Windows で Chromium、macOS/Linux で WebKit を使う
		target:
			process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
		minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
		sourcemap: !!process.env.TAURI_ENV_DEBUG,
	},
});
