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
//! バイナリには含まれない。資格情報設定 + OS キーチェーン + scheduler 疎通チェック
//! (§11-3)を実装済み。IG/YouTube 本体のコマンドは後続 PR で追加する
//! (`publish/mod.rs` 冒頭コメント参照)。
//!
//! アーキテクチャレビュー指摘対応: `job_state` は実行中ジョブの `CancelToken` を保持する
//! State の共通実装(`reframe`/`preview` 共有・`publish::ig`・`publish::youtube` の3箇所で
//! 重複していたものを統一)。`publish` feature の有無に関わらずコンパイルする必要がある
//! (`reframe`/`preview` は feature 無効でも常にコンパイルされるため)ため、`publish`
//! feature 限定の `jobs` モジュール(`lib.rs` 参照)とは別に `commands` 直下に置く
//! (`job_state` モジュール冒頭コメント「統一した経緯」参照)。

pub(crate) mod job_state;
pub mod preview;
pub mod probe;
#[cfg(feature = "publish")]
pub mod publish;
pub mod reframe;
