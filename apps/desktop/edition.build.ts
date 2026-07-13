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
 * どちらも共通の `ReframeScreen`(ターゲット別アスペクト/フィットの選択・
 * レンダリング・フォルダへの保存)を描画する。private は投稿系スロットを埋めた
 * 版(entry.ts → UploadScreenPrivate)、public は投稿系コードを一切含まないまま
 * `ReframeScreen` をそのまま使う版(entry.public.ts)を指す。
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

/**
 * `virtual:publish-settings-entry` の差し替え先(§src/vite-env.d.ts)。
 * 設定ダイアログ(SettingsDialog.tsx)に差し込む「公開連携」設定セクション
 * (scheduler URL / API トークン / 疎通チェック、§11-3)+ `App.tsx` が使う
 * `PublishGateProvider`(usePublishGate インスタンス分散の解消、§6.4)を
 * public/private で出し分ける。public は投稿系コードを一切含まないスタブ
 * (entry.public.tsx — `PublishGateProvider` が JSX フラグメントを返すため `.tsx`)、
 * private は実体(entry.ts)を指す。
 * SettingsDialog.tsx / App.tsx 自体は edition に関わらず常に描画されるため、
 * `virtual:upload-entry` と同様にエントリ側の alias 差し替えで物理的に除外する
 * (SettingsDialog.tsx / App.tsx 本体に edition 分岐を持ち込まない)。
 */
export function publishSettingsEntryAlias(
	edition: Edition,
	configFileUrl: string,
): Record<string, string> {
	const target =
		edition === "public"
			? "./src/features/publish-settings/entry.public.tsx"
			: "./src/features/publish-settings/entry.ts";
	return {
		"virtual:publish-settings-entry": fileURLToPath(
			new URL(target, configFileUrl),
		),
	};
}
