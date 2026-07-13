export { PublishSettingsSection } from "./PublishSettingsSection";
export { PublishGateProvider } from "./PublishGateContext";

/**
 * private エディションで使う実体(そのまま再輸出するだけ)。
 * SettingsDialog.tsx / App.tsx は `virtual:publish-settings-entry` からこのモジュールを読む
 * (vite.config.ts / vitest.config.ts の `resolve.alias` が edition に応じてこのファイルと
 * `./entry.public.ts` を差し替える。§features/upload/entry.ts の同種コメント参照 —
 * 動的 import ではなく静的 re-export を使う理由も同じ)。
 *
 * `PublishGateProvider`(§PublishGateContext.tsx)を App.tsx から使うために追加した
 * (usePublishGate インスタンス分散の解消 — 前 PR からの申し送り事項)。App.tsx は
 * public/private 共通のファイルのため、実体(usePublishGate 等の投稿系コードを import
 * する)を直接 import せず、この edition alias 経由で public 版には無害な no-op
 * (`entry.public.ts`)に差し替わるようにする。
 */
