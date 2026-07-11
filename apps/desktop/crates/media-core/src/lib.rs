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
//!
//! 予定モジュール(Wave 1〜4 で実ファイルと共に順次追加。空モジュールを先行
//! コミットすると clippy が unused 系で騒ぐため、ここではコメントのみに留める):
//! - Wave 1: decode / fit / encode / pipeline
//! - Wave 2: trim / crop / encoder_select / probe(fit は拡張)
//! - Wave 3: concurrency / cancel / progress / audio
//! - Wave 4: preview

pub mod spec;
