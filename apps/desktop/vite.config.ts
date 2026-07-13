import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { resolveEdition, uploadEntryAlias } from "./edition.build";

// Tauri が期待する固定ポート。studio/web(5178/5179)と衝突しないよう 5180 を使う。
const TAURI_DEV_PORT = 5180;
// dev:mock(通常ブラウザ用モックモード、下記 mode==="mock" 分岐)専用ポート。
// 5178/5179(studio)・5180(tauri dev)と衝突しないよう 5190 を使う。
const MOCK_DEV_PORT = 5190;
const host = process.env.TAURI_DEV_HOST;

const mockDir = fileURLToPath(new URL("./src/mock/", import.meta.url));

export default defineConfig(({ mode }) => {
	// `pnpm --filter @facet/desktop dev:mock`(= `vite --mode mock`)のときのみ true。
	// 通常の `pnpm build`/`pnpm dev`(= `tauri dev`)は mode が "production"/"development" の
	// ままなのでこの分岐に入らず、`src/mock/` は import グラフに一切含まれない
	// (alias が無ければ `@tauri-apps/api/*` 等は実パッケージのまま解決される)。
	const isMock = mode === "mock";

	// public/private エディション(§lib/edition.ts、edition.build.ts)。
	// `--mode public` を明示したビルド/dev コマンドのみ public、それ以外は既定で
	// private(現行の全機能。dev:mock やテスト実行時の既定もここに含まれる)。
	const edition = resolveEdition(mode);

	return {
		plugins: [react(), tailwindcss()],
		// Rust 側のエラー出力を vite が隠さないようにする
		clearScreen: false,
		resolve: {
			alias: {
				// public 版の投稿系コード除外(virtual:upload-entry の差し替え、
				// §src/vite-env.d.ts)。edition に関わらず常に設定する
				// (private でも entry.ts への解決が必要なため)。
				...uploadEntryAlias(edition, import.meta.url),
				...(isMock
					? {
							// Tauri ランタイムを renderer 内完結のモック実装へ差し替える
							// (§src/mock/README.md)。ブラウザで Tauri ネイティブウィンドウ無しに
							// renderer を起動し、UIUX 確認のスクリーンショットを撮れるようにする。
							"@tauri-apps/api/core": `${mockDir}core.ts`,
							"@tauri-apps/api/event": `${mockDir}event.ts`,
							"@tauri-apps/api/path": `${mockDir}path.ts`,
							"@tauri-apps/plugin-dialog": `${mockDir}dialog.ts`,
							"@tauri-apps/plugin-opener": `${mockDir}opener.ts`,
							"@tauri-apps/plugin-notification": `${mockDir}notification.ts`,
							"@tauri-apps/plugin-updater": `${mockDir}updater.ts`,
							"@tauri-apps/plugin-process": `${mockDir}process.ts`,
						}
					: {}),
			},
		},
		server: {
			port: isMock ? MOCK_DEV_PORT : TAURI_DEV_PORT,
			// Tauri は固定ポートを期待するため、使用不可なら失敗させる(mock モードは
			// 通常ブラウザからの手動アクセスのみなので固定ポート要件は無い)。
			strictPort: !isMock,
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
		define: {
			// §src/lib/edition.ts。文字列リテラルに置換されるため、`EDITION === "private"`
			// のような分岐は minify 時に定数畳み込みされる(未使用ブランチの死コード化)。
			__FACET_EDITION__: JSON.stringify(edition),
		},
		build: {
			// Tauri は Windows で Chromium、macOS/Linux で WebKit を使う
			target:
				process.env.TAURI_ENV_PLATFORM === "windows"
					? "chrome105"
					: "safari13",
			minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
			sourcemap: !!process.env.TAURI_ENV_DEBUG,
		},
	};
});
