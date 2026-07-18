//! `media_core::spec::EditSpec`(とその依存型)が
//! `packages/contract/schema/edit-spec.json`(`packages/contract/src/edit-spec.ts` の
//! zod スキーマから生成)と乖離していないかを検証する契約テスト
//! (アーキテクチャレビュー指摘対応)。
//!
//! `EditSpec` は `media-core`(Rust 側の真実の源の一つ)で定義されており、
//! `media-core` は contract に依存しない層構造(`spec.rs` モジュール冒頭コメント参照)
//! のため、契約スキーマとの突き合わせは `media-core` を利用する側であるここ
//! (`src-tauri`)で行う。`commands::publish::ig`/`jobs::manifest` の契約整合テストと
//! 同じ流儀(typify を介さず `include_str!` + `serde_json` のみで検証、新規依存を
//! 増やさない)を踏襲するが、それらのトップレベル型は平坦なオブジェクトだったのに対し
//! `EditSpec` は `source`/`crop`/`preset` がネストしたオブジェクトで `preset.fit` が
//! さらに enum を参照するため、`$ref` を再帰的に辿ってネストしたオブジェクトの
//! `properties`/`required` まで検証する汎用マッチャーをここに持つ
//! (`jobs::manifest::assert_field_matches_schema` は $ref が指す先がオブジェクトでも
//! 「type: object」の表面チェックで止まっていたが、本モジュールはそれをオブジェクトの
//! 中身まで再帰させたもの)。

#[cfg(test)]
mod tests {
	use std::collections::BTreeSet;

	use media_core::spec::{CropRect, EditSpec, FitMode, Preset, SourceDimensions, Trim};

	/// `packages/contract/schema/edit-spec.json` の内容そのもの。ワークスペース外
	/// (`apps/desktop` の外)のファイルを参照するため、`include_str!` のパスは
	/// `CARGO_MANIFEST_DIR` ではなく本ソースファイルからの相対パスになる点に注意
	/// (`jobs/manifest.rs`/`commands/publish/ig.rs` と同じ流儀)。
	const EDIT_SPEC_SCHEMA_JSON: &str =
		include_str!("../../../../../packages/contract/schema/edit-spec.json");

	fn contract_schema() -> serde_json::Value {
		serde_json::from_str(EDIT_SPEC_SCHEMA_JSON)
			.expect("packages/contract/schema/edit-spec.json must be valid JSON")
	}

	/// `$defs.<name>` を取り出す。無ければ契約側のスキーマ構造自体が変わったということ
	/// なので、テストを失敗させて気付けるようにする。
	fn schema_def<'a>(schema: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
		schema
			.get("$defs")
			.and_then(|defs| defs.get(name))
			.unwrap_or_else(|| panic!("契約スキーマに $defs.{name} が見つかりません"))
	}

	fn json_type_name(value: &serde_json::Value) -> &'static str {
		match value {
			serde_json::Value::Null => "null",
			serde_json::Value::Bool(_) => "boolean",
			serde_json::Value::Number(n) => {
				if n.is_i64() || n.is_u64() {
					"integer"
				} else {
					"number"
				}
			}
			serde_json::Value::String(_) => "string",
			serde_json::Value::Array(_) => "array",
			serde_json::Value::Object(_) => "object",
		}
	}

	/// `field_schema`(`$ref`/`enum`/`type` のいずれか)を `value` と照合する。
	/// `$ref` がオブジェクト定義(`properties` を持つ)を指す場合は
	/// [`assert_object_matches_schema`] へ再帰し、ネストしたオブジェクトの
	/// `properties`/`required` まで検証する。
	fn assert_field_matches_schema(
		root: &serde_json::Value,
		field_schema: &serde_json::Value,
		value: &serde_json::Value,
		path: &str,
	) {
		if let Some(ref_path) = field_schema.get("$ref").and_then(|v| v.as_str()) {
			let def_name = ref_path
				.rsplit('/')
				.next()
				.unwrap_or_else(|| panic!("{path}: 不正な $ref: {ref_path}"));
			let def_schema = schema_def(root, def_name);
			if def_schema.get("properties").is_some() {
				assert_object_matches_schema(root, def_schema, value, path);
			} else {
				// enum(fitMode 等)への $ref。
				assert_field_matches_schema(root, def_schema, value, path);
			}
			return;
		}
		if let Some(enum_values) = field_schema.get("enum").and_then(|v| v.as_array()) {
			assert!(
				enum_values.contains(value),
				"{path}: {value:?} が enum {enum_values:?} に含まれない"
			);
			return;
		}
		let type_field = field_schema
			.get("type")
			.unwrap_or_else(|| panic!("{path}: $ref/enum/type のいずれも無い"));
		let allowed_types: Vec<&str> = match type_field {
			serde_json::Value::String(s) => vec![s.as_str()],
			serde_json::Value::Array(arr) => arr.iter().map(|v| v.as_str().unwrap()).collect(),
			_ => panic!("{path}: type フィールドの形式が不正: {type_field:?}"),
		};
		let actual_type = json_type_name(value);
		assert!(
			allowed_types.contains(&actual_type),
			"{path}: 型不一致(schema={allowed_types:?}, actual={actual_type}, value={value:?})"
		);
	}

	/// `actual`(オブジェクト)を `object_schema`(`properties`/`required` を持つ、
	/// `$defs` の1エントリそのもの)と再帰的に突き合わせる。
	fn assert_object_matches_schema(
		root: &serde_json::Value,
		object_schema: &serde_json::Value,
		actual: &serde_json::Value,
		path: &str,
	) {
		let properties = object_schema["properties"]
			.as_object()
			.unwrap_or_else(|| panic!("{path}: properties が object ではない"));
		// zod-to-json-schema はオブジェクトの全プロパティが optional な場合 `required`
		// キー自体を省略しうる(空配列と等価)。無ければ空集合として扱う(存在すれば
		// array である前提は崩さない — 型が不正ならここで panic する)。
		let required: BTreeSet<&str> = match object_schema.get("required") {
			Some(value) => value
				.as_array()
				.unwrap_or_else(|| panic!("{path}: required が array ではない"))
				.iter()
				.map(|v| v.as_str().unwrap())
				.collect(),
			None => BTreeSet::new(),
		};
		let actual_obj = actual
			.as_object()
			.unwrap_or_else(|| panic!("{path}: シリアライズ結果が object ではない"));

		// `job-manifest.rs`/`ig.rs` の同種ヘルパは「required が properties 全体と
		// 一致する(= optional なプロパティが無い)」スキーマしか扱っていなかったため
		// キー集合の完全一致で足りたが、`EditSpec` は `trim`/`crop` が実際に optional
		// (undefined 時はキー自体が無い)なので、ここでは (a) 実際のキーが契約の
		// properties の部分集合であること(契約に無い余剰キーが無い)、(b) 契約上の
		// required が実際のキーの部分集合であること(必須キー欠落が無い)の2つを
		// 個別に検証する(完全一致は要求しない)。
		let actual_keys: BTreeSet<&str> = actual_obj.keys().map(String::as_str).collect();
		let schema_keys: BTreeSet<&str> = properties.keys().map(String::as_str).collect();
		assert!(
			actual_keys.is_subset(&schema_keys),
			"{path}: 契約スキーマに無いキーが出力に含まれる(actual={actual_keys:?}, schema={schema_keys:?})"
		);
		for key in &required {
			assert!(
				actual_obj.contains_key(*key),
				"{path}.{key} は契約上 required だが出力に無い"
			);
		}

		// 出力に実際に含まれるキーのみ照合する(optional プロパティは省略されうる —
		// 上の (a)(b) でキー集合自体の整合は検証済み)。
		for (key, value) in actual_obj {
			let field_schema = properties
				.get(key.as_str())
				.unwrap_or_else(|| panic!("{path}.{key}: 契約スキーマに properties.{key} が無い"));
			assert_field_matches_schema(root, field_schema, value, &format!("{path}.{key}"));
		}
	}

	fn assert_edit_spec_conforms_to_contract_schema(spec: &EditSpec) {
		let actual = serde_json::to_value(spec).unwrap();
		let schema = contract_schema();
		let def = schema_def(&schema, "editSpec");
		assert_object_matches_schema(&schema, def, &actual, "editSpec");
	}

	#[test]
	fn full_spec_conforms_to_contract_schema() {
		// フル指定: source / trim / crop / preset すべてあり(9:16 blur-pad 相当)。
		// `spec.rs::tests::round_trip_full_spec` と同じフィクスチャ。
		let spec = EditSpec {
			source: SourceDimensions {
				width: 1920,
				height: 1080,
			},
			trim: Some(Trim {
				start: 1.5,
				end: 9.0,
			}),
			crop: Some(CropRect {
				x: 0.25,
				y: 0.0,
				width: 0.5,
				height: 1.0,
			}),
			preset: Preset {
				name: "9:16".to_string(),
				width: 1080,
				height: 1920,
				fit: FitMode::BlurPad,
			},
		};
		assert_edit_spec_conforms_to_contract_schema(&spec);
	}

	#[test]
	fn minimal_spec_without_trim_or_crop_conforms_to_contract_schema() {
		// 最小指定: source + preset のみ(trim/crop はキー自体が無い = TS の undefined)。
		let spec = EditSpec {
			source: SourceDimensions {
				width: 1920,
				height: 1080,
			},
			trim: None,
			crop: None,
			preset: Preset {
				name: "1:1".to_string(),
				width: 1080,
				height: 1080,
				fit: FitMode::Crop,
			},
		};
		assert_edit_spec_conforms_to_contract_schema(&spec);
	}

	#[test]
	fn spec_without_crop_conforms_to_contract_schema() {
		let spec = EditSpec {
			source: SourceDimensions {
				width: 1280,
				height: 720,
			},
			trim: Some(Trim {
				start: 0.0,
				end: 5.0,
			}),
			crop: None,
			preset: Preset {
				name: "4:5".to_string(),
				width: 1080,
				height: 1350,
				fit: FitMode::BlurPad,
			},
		};
		assert_edit_spec_conforms_to_contract_schema(&spec);
	}

	#[test]
	fn spec_without_trim_conforms_to_contract_schema() {
		let spec = EditSpec {
			source: SourceDimensions {
				width: 3840,
				height: 2160,
			},
			trim: None,
			crop: Some(CropRect {
				x: 0.0,
				y: 0.1,
				width: 1.0,
				height: 0.8,
			}),
			preset: Preset {
				name: "9:16".to_string(),
				width: 1080,
				height: 1920,
				fit: FitMode::Crop,
			},
		};
		assert_edit_spec_conforms_to_contract_schema(&spec);
	}

	// ---- マッチャ自体の自己テスト(コードレビュー指摘対応) --------------------------
	//
	// 上記4テストはいずれも正常系(契約に適合する EditSpec)のみを検証しており、
	// `assert_object_matches_schema`/`assert_field_matches_schema` の判定ロジック自体が
	// 反転する等の回帰があっても(例: subset 判定を逆にしてしまう)全テストが緑のまま
	// 検知できない。ここでは意図的に契約から外れた JSON を作り、マッチャが実際に
	// panic する(= 不整合を検出する)ことを固定する。

	fn minimal_valid_edit_spec_json() -> serde_json::Value {
		let spec = EditSpec {
			source: SourceDimensions {
				width: 1920,
				height: 1080,
			},
			trim: None,
			crop: None,
			preset: Preset {
				name: "1:1".to_string(),
				width: 1080,
				height: 1080,
				fit: FitMode::Crop,
			},
		};
		serde_json::to_value(spec).unwrap()
	}

	#[test]
	fn matcher_detects_extra_key_not_in_contract_schema() {
		let mut actual = minimal_valid_edit_spec_json();
		actual
			.as_object_mut()
			.unwrap()
			.insert("unknownField".to_string(), serde_json::json!(true));

		let schema = contract_schema();
		let def = schema_def(&schema, "editSpec").clone();
		let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
			assert_object_matches_schema(&schema, &def, &actual, "editSpec");
		}));
		assert!(
			result.is_err(),
			"契約に無いキーを含む Value はマッチャが panic して検出するはず"
		);
	}

	#[test]
	fn matcher_detects_missing_required_key() {
		let mut actual = minimal_valid_edit_spec_json();
		actual.as_object_mut().unwrap().remove("preset");

		let schema = contract_schema();
		let def = schema_def(&schema, "editSpec").clone();
		let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
			assert_object_matches_schema(&schema, &def, &actual, "editSpec");
		}));
		assert!(
			result.is_err(),
			"required キーを欠いた Value はマッチャが panic して検出するはず"
		);
	}
}
