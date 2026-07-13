/// <reference types="vite/client" />

/**
 * ビルド時に確定するエディション定数。vite.config.ts / vitest.config.ts の
 * `define` で注入する(§src/lib/edition.ts)。値そのものは "public" | "private" の
 * リテラルに置換されるため、未使用分岐は minify/tree-shaking で落ちる。
 */
declare const __FACET_EDITION__: "public" | "private";

/**
 * アップロード(投稿)機能のエントリポイント。実体は vite.config.ts /
 * vitest.config.ts の `resolve.alias` で edition ごとに差し替える:
 * - private: `features/upload/entry.ts`(React.lazy 経由の動的 import)
 * - public : `features/upload/entry.public.ts`(投稿系コードを含まないスタブ)
 * どちらも同じ型(`UploadScreenProps`)を満たす。
 */
declare module "virtual:upload-entry" {
	import type { ComponentType } from "react";
	import type { UploadScreenProps } from "./features/upload/UploadScreen";

	export const UploadScreen: ComponentType<UploadScreenProps>;
}

/**
 * 公開連携(scheduler URL / API トークン / 疎通チェック / R2 資格情報)の設定セクション
 * + 実行時ゲートの共有 Provider。実体は vite.config.ts / vitest.config.ts の
 * `resolve.alias` で edition ごとに差し替える:
 * - private: `features/publish-settings/entry.ts`(実体)
 * - public : `features/publish-settings/entry.public.tsx`(何もレンダリングしない
 *   スタブ + 子要素をそのまま透過するだけの no-op Provider)
 * SettingsDialog.tsx / App.tsx はこのモジュール経由で描画するため、edition 分岐を持たない。
 */
declare module "virtual:publish-settings-entry" {
	import type { ComponentType, ReactNode } from "react";

	export const PublishSettingsSection: ComponentType;
	export const PublishGateProvider: ComponentType<{ children: ReactNode }>;
}
