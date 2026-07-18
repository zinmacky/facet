//! contract-rs のコード生成(typify)。
//!
//! `packages/contract/schema/job-manifest.json`(zod スキーマから `pnpm build` 時に
//! 生成される、コミット対象の JSON Schema。`jobManifest`/`jobRecord`/`jobStatus`/
//! `jobCreateResponse`/`mediaType` の 5 定義を `$defs` に持つ)を typify で Rust の
//! serde 型へ変換し、`$OUT_DIR/codegen.rs` に書き出す。生成コードは非コミット
//! (docs/desktop-migration-plan.md §6.1)。`lib.rs` がこれを `include!` して
//! re-export する。
//!
//! ## `JobStatus` を敢えて生成せず `String` へ差し替える理由
//!
//! contract の `jobCreateResponse.status` / `jobRecord.status` は zod の `jobStatus`
//! enum(`$defs/jobStatus`)を参照するため、素直に typify へ通すと
//! `JobCreateResponse.status` が `enum JobStatus { Pending, Creating, ... }` になる。
//! scheduler(Cloudflare Workers)と desktop アプリは別々にデプロイされ、desktop 側は
//! 自動更新までタイムラグがある配布物のため、scheduler が新しい status 値を追加した
//! 直後に旧バージョンの desktop が `POST /jobs` の応答を受け取ると、未知の enum
//! variant でデシリアライズそのものが失敗しうる。手書き実装時代から同じ理由で
//! 意図的に `status: String` としていた(旧 `jobs/manifest.rs` の
//! `JobCreateResponse` コメント参照)ため、この意図を保つべく typify の
//! `with_replacement` で `JobStatus` 型の生成を取りやめ `String` に強制する。
//! この差し替えは `jobStatus` を参照する側(`jobCreateResponse`/`jobRecord`)にのみ
//! 影響し、`jobManifest.mediaType`(`$defs/mediaType` を参照)には影響しない —
//! `MediaType` は素直に生成させ、呼び出し側(`jobs/manifest.rs`)が `Reels`
//! variant のみを使う運用でスコープする(実装指示 §4 参照)。
//!
//! ## 未知フィールドの許容(`deny_unknown_fields` を生成させない)
//!
//! `packages/contract` の各 `z.object()` は `.strict()` を呼んでおらず、zod の実行時
//! 挙動は既定の「未知キーは黙って無視する(strip)」。ところが `zod-to-json-schema` の
//! 既定設定はこの strip モードを `additionalProperties: false` として出力してしまい
//! (zod の意味論より厳しいスキーマになる)、typify がそれを見て各構造体に
//! `#[serde(deny_unknown_fields)]` を付与するため、`JobCreateResponse` のデシリアライズ
//! (scheduler → desktop 受信経路)が scheduler の将来のフィールド追加で壊れる
//! 後方互換性の後退が起きていた(旧手書き型はこの制約を持たなかった)。
//! この問題は typify 側では対処できない(JSON Schema 生成側の忠実性の問題)ため、
//! `packages/contract/scripts/generate-schema.mjs` の `zodToJsonSchema` 呼び出しに
//! `removeAdditionalStrategy: "strict"` + `allowedAdditionalProperties: undefined` を
//! 指定して `additionalProperties` キー自体を出力しないよう是正済み(JSON Schema の
//! 既定 = 未知キー許容、と zod の実挙動が一致する)。生成型が未知のトップレベル
//! フィールドを許容することは `jobs/manifest.rs` の
//! `job_create_response_ignores_unknown_fields_forward_compat` テストが固定する。

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::PathBuf;

use typify::{TypeSpace, TypeSpaceImpl, TypeSpaceSettings};

fn main() {
	let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo");
	// apps/desktop/crates/contract-rs から見て4つ上がリポジトリルート
	// (crates → desktop → apps → root)。
	let schema_path =
		PathBuf::from(&manifest_dir).join("../../../../packages/contract/schema/job-manifest.json");
	println!("cargo:rerun-if-changed={}", schema_path.display());

	let content = fs::read_to_string(&schema_path).unwrap_or_else(|err| {
        panic!(
            "{} の読み込みに失敗しました(先に `pnpm --filter @facet/contract build` を実行したか確認してください): {err}",
            schema_path.display()
        )
    });
	let raw: serde_json::Value = serde_json::from_str(&content)
		.expect("job-manifest.json は valid JSON である必要があります");
	let defs_value = raw
		.get("$defs")
		.expect("job-manifest.json はトップレベルに $defs を持つ必要があります");
	let defs: BTreeMap<String, schemars::schema::Schema> =
		serde_json::from_value(defs_value.clone())
			.expect("$defs の各エントリは valid な JSON Schema オブジェクトである必要があります");

	let mut settings = TypeSpaceSettings::default();
	settings.with_replacement(
		"JobStatus",
		"::std::string::String",
		std::iter::empty::<TypeSpaceImpl>(),
	);

	let mut type_space = TypeSpace::new(&settings);
	type_space
		.add_ref_types(defs)
		.expect("packages/contract/schema/job-manifest.json の typify 変換に失敗しました");

	let contents = prettyplease::unparse(
		&syn::parse2::<syn::File>(type_space.to_stream())
			.expect("typify が生成したコードが不正な Rust 構文です"),
	);

	let mut out_file = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
	out_file.push("codegen.rs");
	fs::write(&out_file, contents)
		.unwrap_or_else(|err| panic!("{} への書き込みに失敗しました: {err}", out_file.display()));
}
