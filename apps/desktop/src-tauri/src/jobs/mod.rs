//! IG(Instagram)予約公開の Rust 実装(Phase 3 本体、docs/desktop-migration-plan.md
//! §6.4・§8 Phase 3・§12.1)。旧 studio 実装(削除済み)の
//! `apps/studio/server/src/services/scheduler-client.ts` +
//! `apps/studio/server/src/routes/publish.ts` の instagram 経路を Rust へ移植する。
//!
//! - [`manifest`]: `packages/contract` の `JobManifest`/`mediaType` に対応する
//!   **暫定手書き型**(typify 疎通は未実装。`crates/media-core/src/spec.rs` 冒頭
//!   コメントと同じ理由・同じ暫定方針)+ enqueue 前バリデーション(§12.1)。
//! - [`sigv4`]: R2(S3 互換)の署名付き PUT URL 生成。`rusty-s3` に委ねる
//!   (選定理由は本モジュール冒頭コメント参照)。
//! - [`r2_upload`]: 署名付き URL への実アップロード(ストリーミング + 進捗 + キャンセル)。
//! - [`scheduler_client`]: `POST /jobs`(Bearer 認証)とエラー分類。
//!
//! invoke 境界(`ig_publish_start`/`ig_publish_cancel`)は
//! `crate::commands::publish::ig` に置く(このモジュールは Tauri に依存しない
//! 純粋なビジネスロジック層 — `media_core` が Tauri 非依存であるのと同じ位置づけ)。
//!
//! ## crate 選定: R2(S3 互換)署名になぜ `rusty-s3` を使うか
//!
//! 検討した候補は 2 つ(§実装指示で挙げられた候補そのもの):
//!
//! 1. **aws-sigv4**(aws-smithy-rs のスタンドアロン署名クレート): AWS SDK 本体ではないが
//!    `aws-smithy-runtime-api`/`aws-smithy-http`/`aws-credential-types`/`tracing` 等、
//!    smithy コード生成エコシステム一式を伴う。ヘッダ署名(Authorization ヘッダ方式)。
//! 2. **rusty-s3**: Sans-IO(HTTP クライアントを同梱しない)な S3 署名専用クレート。
//!    `rustcrypto` feature のみなら依存は事実上 `hmac`+`sha2`(+ `url`)に閉じる。
//!    S3 互換 API(R2 を含む)向けの presigned URL 生成に特化した API
//!    (`Bucket::new` + `Credentials::new` + `bucket.put_object(...).sign(expires_in)`)を持つ。
//!
//! **rusty-s3 を採用した。** 理由:
//! - 依存の軽さで優る(smithy 系ランタイム・`tracing` 等を引き込まない)。
//! - presigned URL 方式は「署名済み URL に対して reqwest で素の PUT を投げる」だけで済み、
//!   Authorization ヘッダ方式(aws-sigv4)より呼び出し側の実装がシンプルになる
//!   (署名対象ヘッダの選定・`x-amz-content-sha256` 等の付与を自前で気にする必要がない)。
//! - R2 は S3 互換 API のため、S3 特化クレートである rusty-s3 がそのまま使える
//!   (`UrlStyle::Path` で `https://<accountid>.r2.cloudflarestorage.com/<bucket>/<key>` 形式、
//!   旧 TS 実装の `putUrl` 組み立てと同形)。
//!
//! 署名アルゴリズム自体の正しさは rusty-s3 のテストスイートに委ね、本リポジトリ側の
//! テスト([`sigv4`] のテスト)は「自分の呼び出しコード(bucket/region/credentials の
//! 組み立て、presigned URL のパラメータ)が正しい」ことを、AWS 公式ドキュメントの
//! 既知テストベクタ(SigV4 のリファレンス実装が広く使う値)で検証する
//! (旧 TS 側にはこの署名自体のテストが無かった — `scheduler-client.test.ts` は
//! `buildR2Key` のみを検証していた。§sigv4.rs 冒頭コメント参照)。

#[cfg(feature = "publish")]
pub mod manifest;
#[cfg(feature = "publish")]
pub mod r2_upload;
#[cfg(feature = "publish")]
pub mod scheduler_client;
#[cfg(feature = "publish")]
pub mod sigv4;
