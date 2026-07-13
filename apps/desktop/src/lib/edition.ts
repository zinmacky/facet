/**
 * ビルド時に確定するエディション。実体は `__FACET_EDITION__`(vite.config.ts /
 * vitest.config.ts の `define` で注入されるビルド時定数、型は src/vite-env.d.ts 参照)。
 *
 * - "public": 配布版。切り抜き+reframe+書き出しのみ(2 step ウィザード)。
 *   投稿(アップロード)機能のコードはバンドルに一切含まれない
 *   (§features/upload/entry.ts と entry.public.ts、vite.config.ts の
 *   `virtual:upload-entry` alias 差し替え。docs/desktop-migration-plan.md §6.6)。
 * - "private": 開発者/作者版。現行の3 step UI(将来 Phase 3 で投稿機能が載る)。
 *
 * テスト実行時(vitest)の既定値は "private"(現行テストを壊さないため)。
 */
export type Edition = "public" | "private";

export const EDITION: Edition = __FACET_EDITION__;

export const isPublicEdition = EDITION === "public";
