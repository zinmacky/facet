import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// Tauri が期待する固定ポート。studio/web(5178/5179)と衝突しないよう 5180 を使う。
const TAURI_DEV_PORT = 5180;
const host = process.env.TAURI_DEV_HOST;

// dev proxy: studio/web と同じく studio server(:5178)を /api・/files 経由で叩く。
// renderer 側の fetch 呼び出しは Phase 1 では書き換えないため、server が起動していれば
// このプロキシ経由でそのまま疎通する(未起動なら 404 になるだけで Phase 1 としては想定内)。
const SERVER_ORIGIN = "http://localhost:5178";

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
		proxy: {
			// /api/* → server の /*(プレフィックスを剥がす)
			"/api": {
				target: SERVER_ORIGIN,
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api/, ""),
			},
			// /files/* はローカルのメディア配信。パスはそのまま素通しする(rewrite 不要)。
			"/files": {
				target: SERVER_ORIGIN,
				changeOrigin: true,
			},
		},
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
