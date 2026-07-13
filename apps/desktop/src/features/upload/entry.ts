export { UploadScreen } from "./UploadScreen";

/**
 * private エディションで使う実体(そのまま `UploadScreen` を再輸出するだけ)。
 * App.tsx は `virtual:upload-entry` からこのモジュールを読む
 * (vite.config.ts / vitest.config.ts の `resolve.alias` が edition に応じて
 * このファイルと `./entry.public.ts` を差し替える。§src/lib/edition.ts)。
 *
 * 設計メモ: 当初は `React.lazy` による動的 import で「public バンドルからの除外」も
 * 兼ねる案を検討したが、Rollup は `if (private) import(...)` のような到達しない
 * 分岐内の動的 import でもチャンク自体は物理的に出力してしまう(定数畳み込みで
 * 消えるのは分岐の実行パスだけで、チャンク生成の判定には影響しない)。そのため
 * public 版の除外保証は本ファイルではなく vite.config.ts の alias 差し替え
 * (`virtual:upload-entry` → `entry.public.ts`)そのものが担っており、ここで
 * 動的 import を使う実利は無い。むしろ `React.lazy` は Suspense 境界が必要になり、
 * ステップ遷移時のフォーカス移動(App.tsx の a11y effect — 遷移直後に
 * `wizard-panel-heading-upload` へ同期的にフォーカスする)が初回ナビゲーション時に
 * 競合する(chunk 解決が 1 tick 遅れるため、フォーカス対象の見出しがまだ
 * DOM に無い瞬間がある)。private 版は現行どおり全コードを含む前提のため、
 * 静的 re-export でよい。
 */
