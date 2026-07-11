fn main() {
	tauri_build::build();

	// TODO(Phase 0/2): packages/contract/schema/*.json (JSON Schema) から
	// typify で crates/contract-rs 向けの serde 型を OUT_DIR に生成する処理を
	// ここに追加する。現時点(Phase 1: スキャフォルドのみ)では未実装。
}
