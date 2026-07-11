//! media-core: libav (ffmpeg-next) ベースのメディアパイプラインを担う crate。
//!
//! 役割(Phase 2 で実装予定。Phase 1 時点ではプレースホルダ):
//! - trim(seek + duration)/ 事前クロップ / blur-pad(sigma=20)/ crop-cover / scale
//! - HW エンコード(VideoToolbox / Media Foundation)+ 同時実行セマフォ(-12903 対策)
//! - デコード/エンコードループの明示的キャンセル機構
//! - プレビュー仮エンコード + キャッシュ
//!
//! Tauri(`src-tauri`)に依存しない独立 crate とし、単体テストの対象にする
//! (docs/desktop-migration-plan.md §6.2 / §7)。ffmpeg-next はまだ追加しない。
