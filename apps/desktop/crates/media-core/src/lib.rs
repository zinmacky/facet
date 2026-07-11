//! media-core: libav (ffmpeg-next) ベースのメディアパイプラインを担う crate。
//!
//! 役割(Phase 2 で実装予定):
//! - trim(seek + duration)/ 事前クロップ / blur-pad(sigma=20)/ crop-cover / scale
//! - HW エンコード(VideoToolbox / Media Foundation)+ 同時実行セマフォ(-12903 対策)
//! - デコード/エンコードループの明示的キャンセル機構
//! - プレビュー仮エンコード + キャッシュ
//!
//! Tauri(`src-tauri`)に依存しない独立 crate とし、単体テストの対象にする
//! (docs/desktop-migration-plan.md §6.2 / §7)。
//!
//! **音声は現段階では扱わない**(映像のみ。スパイク `spikes/libav-reframe/src/reframe.rs`
//! と同様)。音声パイプライン(任意音声を AAC ≤48kHz に再エンコード、無音声入力も許容)は
//! Wave 3 の `audio.rs` で追加予定(docs/desktop-migration-plan.md §12.1)。
//!
//! モジュール構成(Wave 1〜4 で順次追加):
//! - Wave 1(このコミット): `error` / `decode` / `fit` / `encode` / `pipeline`
//! - Wave 2: `trim` / `crop` / `encoder_select` / `probe`(`fit` は事前クロップ接続で拡張)
//! - Wave 3: `concurrency` / `cancel` / `progress` / `audio`
//! - Wave 4: `preview`

pub mod decode;
pub mod encode;
pub mod encoder_select;
pub mod error;
pub mod fit;
pub mod pipeline;
pub mod spec;

pub use error::{MediaError, Result};
pub use pipeline::{reframe, Progress, ReframeOptions};
