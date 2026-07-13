import type { ComponentType } from "react";

/**
 * public(配布版)エディションで使うスタブ。`./PublishSettingsSection` を含む公開連携
 * 設定一式(publishSettingsClient/schedulerUrlStore/usePublishGate)を一切 import
 * しない — public ビルドのバンドルに投稿系コードを物理的に含めないための差し替え先
 * (vite.config.ts の `virtual:publish-settings-entry` alias、§src/vite-env.d.ts)。
 *
 * SettingsDialog.tsx は edition に関わらずこのモジュール(または private 側の実体)を
 * 描画するが、public 版はこのコンポーネントが何も表示しない。
 */
export const PublishSettingsSection: ComponentType = () => null;
