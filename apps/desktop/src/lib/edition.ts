/**
 * ビルド時に確定するエディション。実体は `__FACET_EDITION__`(vite.config.ts /
 * vitest.config.ts の `define` で注入されるビルド時定数、型は src/vite-env.d.ts 参照)。
 *
 * ウィザードの step 構成(編集/確認/リフレーム)自体は両エディション共通
 * (§features/wizard/WizardShell.tsx の `WIZARD_STEPS`)。
 *
 * - "public": 配布版。切り抜き+確認+リフレーム(ターゲット別アスペクト/フィットの
 *   選択・レンダリング・フォルダへの保存)まで。投稿(スケジュール・キャプション・
 *   IG/YT 連携)のコードはバンドルに一切含まれない(§features/upload/entry.ts と
 *   entry.public.ts、vite.config.ts の `virtual:upload-entry` alias 差し替え。
 *   docs/desktop-migration-plan.md §6.6)。
 * - "private": 開発者/作者版。上記に加えて投稿機能を持つ。
 *
 * テスト実行時(vitest)の既定値は "private"(現行テストを壊さないため)。
 */
export type Edition = "public" | "private";

export const EDITION: Edition = __FACET_EDITION__;

export const isPublicEdition = EDITION === "public";
