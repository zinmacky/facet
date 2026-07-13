//! Phase 3(IG/YouTube 公開連携)の土台。`publish` cargo feature が有効なビルド
//! (private エディション。build:mac-private 等)でのみコンパイルされる
//! (§commands/mod.rs の `#[cfg(feature = "publish")]`、docs/desktop-migration-plan.md §6.6)。
//!
//! エディション分離(v2.4)の先行タスクとして、feature の骨組みのみをここに用意する。
//! Phase 3 本体で IG(R2 アップロード + POST /jobs)・YouTube(OAuth + アップロード)の
//! コマンドをこのモジュールに実装し、`lib.rs` の `invoke_handler` へ
//! `#[cfg(feature = "publish")]` 付きで登録する予定(現時点ではまだ実コマンド無し)。
