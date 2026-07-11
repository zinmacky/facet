//! contract-rs: `packages/contract`(zod, 真実の源)から出力される
//! JSON Schema(`packages/contract/schema/*.json`)を typify で codegen した
//! serde 型を re-export する crate。
//!
//! 生成コード自体は非コミットで `src-tauri/build.rs` が OUT_DIR に都度生成する
//! 方針(docs/desktop-migration-plan.md §6.1)。この crate はその生成型への
//! 薄い re-export 層を提供する想定だが、typify 疎通は Phase 0/2 の作業のため
//! Phase 1 時点では未実装のプレースホルダ。
