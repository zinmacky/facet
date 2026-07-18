//! contract-rs: `packages/contract`(zod, 真実の源)から出力される
//! JSON Schema(`packages/contract/schema/job-manifest.json`)を typify で codegen した
//! serde 型を re-export する crate。
//!
//! 生成コード自体は非コミットで、この crate 自身の `build.rs` が `OUT_DIR` に都度
//! 生成する(docs/desktop-migration-plan.md §6.1)。`JobStatus` を `String` へ
//! 差し替えている理由は `build.rs` 冒頭コメント参照。
//!
//! 生成コードは typify 側の実装都合(命名規則・derive 構成等)に従うため、この
//! crate 自身の lint は緩める(手書きコードではないため)。
#![allow(missing_docs, clippy::all)]

include!(concat!(env!("OUT_DIR"), "/codegen.rs"));
