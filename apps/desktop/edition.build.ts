import { fileURLToPath } from "node:url";

/**
 * public/private エディションの解決とビルド設定(vite.config.ts / vitest.config.ts
 * 共通)。§src/lib/edition.ts(renderer 側から見た型・定数)と対になる、ビルド設定側の
 * 実装。
 */
export type Edition = "public" | "private";

/**
 * vite の `mode` からエディションを解決する。既定は "private"
 * (`--mode public` を明示したときのみ "public")。
 *
 * - `tauri dev`(mode="development", 素の `pnpm dev`)→ private(現行の全機能)
 * - `vite --mode public`(dev:public / build:win-release / build:mac-local)→ public
 * - `vite build --mode private`(build:mac-private)→ private
 * - vitest(mode="test")→ private(vitest.config.ts は edition を固定値で渡すため
 *   このモード解決自体は経由しない)
 */
export function resolveEdition(mode: string): Edition {
	return mode === "public" ? "public" : "private";
}

/**
 * `virtual:upload-entry` の差し替え先(§src/vite-env.d.ts)。
 * public は投稿系コードを一切含まないスタブ(entry.public.ts)、private は実体
 * (entry.ts)を指す。
 */
export function uploadEntryAlias(
	edition: Edition,
	configFileUrl: string,
): Record<string, string> {
	const target =
		edition === "public"
			? "./src/features/upload/entry.public.ts"
			: "./src/features/upload/entry.ts";
	return {
		"virtual:upload-entry": fileURLToPath(new URL(target, configFileUrl)),
	};
}
