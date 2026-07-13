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
//!
//! エディション分離(v2.4, docs/desktop-migration-plan.md §6.6): `publish` モジュールは
//! Phase 3(IG/YouTube 公開連携)の土台。`publish` feature が有効なビルド
//! (private、build:mac-private 等)でのみコンパイルされ、public(配布版)の
//! バイナリには含まれない。現時点ではまだ実コマンドは無い(空モジュール、
//! `publish.rs` 冒頭コメント参照)。

pub mod preview;
pub mod probe;
#[cfg(feature = "publish")]
pub mod publish;
pub mod reframe;
