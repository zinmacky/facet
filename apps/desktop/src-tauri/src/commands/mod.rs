//! invoke 境界(Tauri コマンド)のモジュール群。
//!
//! Phase 2 Wave 5: `probe` / `reframe_start` / `reframe_cancel` を実装する
//! (docs/desktop-migration-plan.md §7 のディレクトリ構成に合わせて `commands/` に分割)。
//! ジョブの進捗・完了は `reframe` モジュール冒頭コメントの Tauri イベント経由で通知する
//! (renderer 向け API 仕様も同コメントにまとめている)。
//!
//! Phase 2 Wave 4+5 統合: `preview_start` を追加する(`preview` モジュール)。
//! `reframe_start` と同じ `reframe::JobsState` を共有するため、
//! `preview_start` が返したジョブも `reframe_cancel` でキャンセルできる
//! (`preview` モジュール冒頭コメント参照)。

pub mod preview;
pub mod probe;
pub mod reframe;
