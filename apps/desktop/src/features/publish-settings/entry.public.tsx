import type { ComponentType, ReactNode } from "react";

/**
 * public(配布版)エディションで使うスタブ。`./PublishSettingsSection` /
 * `./PublishGateContext` を含む公開連携一式(publishSettingsClient/schedulerUrlStore/
 * usePublishGate)を一切 import しない — public ビルドのバンドルに投稿系コードを
 * 物理的に含めないための差し替え先(vite.config.ts の `virtual:publish-settings-entry`
 * alias、§src/vite-env.d.ts)。
 *
 * SettingsDialog.tsx / App.tsx は edition に関わらずこのモジュール(または private 側の
 * 実体)を描画するが、public 版は `PublishSettingsSection` が何も表示せず、
 * `PublishGateProvider` は子要素をそのまま透過するだけの no-op になる
 * (JSX(フラグメント)を返すため、他の `entry.public.ts` と異なりこのファイルのみ
 * `.tsx` 拡張子にしている)。
 */
export const PublishSettingsSection: ComponentType = () => null;

export const PublishGateProvider: ComponentType<{ children: ReactNode }> = ({
	children,
}) => <>{children}</>;
