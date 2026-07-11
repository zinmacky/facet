//! invoke 境界(Tauri コマンド)のモジュール群。
//!
//! Phase 2 Wave 5: `probe` / `reframe_start` / `reframe_cancel` を実装する
//! (docs/desktop-migration-plan.md §7 のディレクトリ構成に合わせて `commands/` に分割)。
//! ジョブの進捗・完了は `reframe` モジュール冒頭コメントの Tauri イベント経由で通知する
//! (renderer 向け API 仕様も同コメントにまとめている)。

pub mod probe;
pub mod reframe;
