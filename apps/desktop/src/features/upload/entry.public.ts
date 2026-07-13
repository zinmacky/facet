import type { ComponentType } from "react";
import type { UploadScreenProps } from "./UploadScreen";

/**
 * public(配布版)エディションで使うスタブ。`./UploadScreen` を含む投稿系一式
 * (PostDetail/PostRow/BulkPresetsModal/ScheduleSettingsModal 等)を一切 import
 * しない — public ビルドのバンドルに投稿系コードを物理的に含めないための差し替え先
 * (vite.config.ts の `virtual:upload-entry` alias、§src/lib/edition.ts)。
 *
 * public 版のウィザードは "upload" ステップ自体を持たない(App.tsx / WizardShell.tsx)
 * ため、このコンポーネントが実際にレンダリングされることは無い。型シグネチャを
 * private 版(./entry.ts)と一致させるためだけに存在する。
 */
export const UploadScreen: ComponentType<UploadScreenProps> = () => null;
