export { PublishSettingsSection } from "./PublishSettingsSection";

/**
 * private エディションで使う実体(そのまま `PublishSettingsSection` を再輸出するだけ)。
 * SettingsDialog.tsx は `virtual:publish-settings-entry` からこのモジュールを読む
 * (vite.config.ts / vitest.config.ts の `resolve.alias` が edition に応じてこのファイルと
 * `./entry.public.ts` を差し替える。§features/upload/entry.ts の同種コメント参照 —
 * 動的 import ではなく静的 re-export を使う理由も同じ)。
 */
