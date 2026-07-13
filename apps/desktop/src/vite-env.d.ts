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
