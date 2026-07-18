//! `packages/contract/src/job-manifest.ts` の `JobManifest`/`JobCreateResponse` に
//! 対応する型は `contract-rs`(`packages/contract/schema/job-manifest.json` から
//! typify で codegen する crate、Issue #93)からの生成型を re-export して使う。
//!
//! 生成型は他クレート(`contract-rs`)で定義されているため、Rust の orphan rule に
//! より本モジュールから `impl JobManifest { .. }` のような inherent impl を追加
//! できない。そのため旧 `JobManifest::new` 相当は [`new_job_manifest`] という
//! フリー関数として提供する(呼び出し側は本モジュールの他のヘルパー
//! (`build_r2_key`/`validate_*`)と同じ `manifest::foo(...)` の形で呼べる)。
//!
//! `mediaType` は contract 上 `"VIDEO" | "REELS"` だが、Instagram Graph API の現行
//! リファレンスに `VIDEO` が存在しない(docs/desktop-migration-plan.md §6.4・§12.1)
//! ため、本実装は生成された `MediaType` enum のうち **`Reels` variant に一本化**
//! する(1:1/4:5 の出力も REELS として投稿する)。contract 側の enum 整理自体は
//! Phase 0 のタスクとして据え置かれているため、ここでは「Rust 側は REELS のみを
//! 送出する」という運用上の決定にとどめる(contract の zod スキーマは変更しない)。
//!
//! `JobCreateResponse.status` を敢えて `JobStatus` enum ではなく `String` として
//! 生成させている理由は `crates/contract-rs/build.rs` 冒頭コメント参照
//! (scheduler が新しい status 値を追加しても、自動更新にタイムラグのある desktop
//! 側のデシリアライズが壊れないようにするため)。

use std::num::NonZeroU64;

use contract_rs::MediaType;
pub use contract_rs::{JobCreateResponse, JobManifest};
use thiserror::Error;

/// `POST /jobs` のリクエストボディ(contract-rs の生成型 `JobManifest`)を組み立てる。
///
/// 各フィールドは呼び出し前に以下の検証を通過している前提で `.expect()` する
/// (契約上不正な値を渡すと生成型のコンストラクタ相当がここでパニックする —
/// 検証は呼び出し側の責務):
/// - `caption`: [`validate_caption`](2200 UTF-16 単位以下)
/// - `r2_key`: [`build_r2_key`] が常に1文字以上を生成する
/// - `publish_at_ms`: [`validate_publish_at`](正の値)
/// - `idempotency_key`: 呼び出し側(`commands::publish::ig::derive_idempotency_key`)が
///   常に UUID 文字列を渡す
pub fn new_job_manifest(
	idempotency_key: String,
	r2_key: String,
	caption: String,
	publish_at_ms: i64,
) -> JobManifest {
	JobManifest {
		idempotency_key: idempotency_key
			.parse()
			.expect("idempotency_key は呼び出し側が常に UUID 文字列を渡す前提"),
		platform: "instagram".to_string(),
		r2_key: r2_key
			.try_into()
			.expect("r2_key は build_r2_key が常に1文字以上を生成する前提"),
		media_type: MediaType::Reels, // モジュール冒頭コメント参照: REELS に一本化。
		caption: caption
			.try_into()
			.expect("caption は validate_caption で ≤2200 UTF-16 単位を検証済みの前提"),
		publish_at: NonZeroU64::new(publish_at_ms as u64)
			.expect("publish_at は validate_publish_at で正の値を検証済みの前提"),
	}
}

/// R2 オブジェクトキーを生成する。
/// 形式: `posts/<YYYY-MM-DD>/<uuid>.mp4` 。日付は `publish_at_ms` を UTC で解釈する
/// (旧 TS 実装 `scheduler-client.ts` の `buildR2Key` と同じ規則。§テスト参照)。
/// `uuid` の採番方法は呼び出し側の責務(`commands::publish::ig::run_ig_publish` は
/// job_id からの決定的導出に変更済み。GHSA-6cx9-j28r-f866 対応)。
pub fn build_r2_key(publish_at_ms: i64, uuid: uuid::Uuid) -> String {
	let date = unix_ms_to_utc_date(publish_at_ms);
	format!("posts/{date}/{uuid}.mp4")
}

/// unix ms から `YYYY-MM-DD`(UTC)を組み立てる。`time`/`chrono` 等の日付クレートを
/// 増やさないため、うるう年を含む素朴なカレンダー計算を自前で行う
/// (1970-01-01 からの通日を積み上げるだけの標準的なアルゴリズム)。
fn unix_ms_to_utc_date(unix_ms: i64) -> String {
	let days = unix_ms.div_euclid(86_400_000);
	let (year, month, day) = civil_from_days(days);
	format!("{year:04}-{month:02}-{day:02}")
}

/// Howard Hinnant の "chrono-Compatible Low-Level Date Algorithms"
/// (<https://howardhinnant.github.io/date_algorithms.html>)の `civil_from_days` 移植。
/// グレゴリオ暦の通日 <-> (年, 月, 日) 変換として広く使われるアルゴリズム。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
	let z = z + 719_468;
	let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
	let doe = (z - era * 146_097) as u64; // [0, 146096]
	let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
	let y = yoe as i64 + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
	let mp = (5 * doy + 2) / 153; // [0, 11]
	let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
	let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
	let year = if m <= 2 { y + 1 } else { y };
	(year, m, d)
}

// ---- enqueue 前バリデーション(§12.1・実装指示 3) --------------------------------

/// Instagram のファイルサイズ上限(300MB)。
pub const MAX_FILE_SIZE_BYTES: u64 = 300 * 1024 * 1024;
/// Instagram の最小尺(3秒)。
pub const MIN_DURATION_SECS: f64 = 3.0;
/// Instagram の最大尺(15分)。
pub const MAX_DURATION_SECS: f64 = 15.0 * 60.0;
/// contract `jobManifest.caption` の上限(`z.string().max(2200)`)。JS の `.length`
/// (UTF-16 コード単位数)に合わせるため、呼び出し側は `str::encode_utf16().count()` で
/// 数える(§validate_caption)。
pub const MAX_CAPTION_UTF16_LEN: usize = 2200;

#[derive(Debug, Clone, Copy, PartialEq, Error)]
pub enum ValidationError {
	#[error(
		"ファイルサイズが上限を超えています({size_mb:.1}MB > {max_mb:.0}MB)。Instagram の上限は300MBです。"
	)]
	FileTooLarge { size_mb: f64, max_mb: f64 },
	#[error(
		"動画が短すぎます({seconds:.1}秒 < {min_seconds:.0}秒)。Instagram の最小尺は{min_seconds:.0}秒です。"
	)]
	DurationTooShort { seconds: f64, min_seconds: f64 },
	#[error(
		"動画が長すぎます({seconds:.1}秒 > {max_seconds:.0}秒)。Instagram の最大尺は{max_seconds:.0}秒(15分)です。"
	)]
	DurationTooLong { seconds: f64, max_seconds: f64 },
	#[error("キャプションが長すぎます({len}文字 > {max}文字)。")]
	CaptionTooLong { len: usize, max: usize },
	/// contract `jobManifest.publishAt`(`z.number().int().positive()`)違反。
	/// 生成型 `JobManifest.publish_at` が `NonZeroU64` のため、[`new_job_manifest`] に
	/// 渡す前にここで検証しておかないと 0/負値でパニックしてしまう。
	#[error("公開時刻が不正です({value})。正の unix ms(1970-01-01 以降)である必要があります。")]
	InvalidPublishAt { value: i64 },
}

/// ファイルサイズ(バイト)を検証する。R2 アップロード開始前に呼ぶこと
/// (実装指示 §3: 違反は R2 に上がる前に検出する)。
pub fn validate_file_size(size_bytes: u64) -> Result<(), ValidationError> {
	if size_bytes > MAX_FILE_SIZE_BYTES {
		return Err(ValidationError::FileTooLarge {
			size_mb: size_bytes as f64 / (1024.0 * 1024.0),
			max_mb: MAX_FILE_SIZE_BYTES as f64 / (1024.0 * 1024.0),
		});
	}
	Ok(())
}

/// 尺(秒)を検証する。`media_core::probe` の結果を渡す想定(実装指示 §3)。
pub fn validate_duration(duration_secs: f64) -> Result<(), ValidationError> {
	if duration_secs < MIN_DURATION_SECS {
		return Err(ValidationError::DurationTooShort {
			seconds: duration_secs,
			min_seconds: MIN_DURATION_SECS,
		});
	}
	if duration_secs > MAX_DURATION_SECS {
		return Err(ValidationError::DurationTooLong {
			seconds: duration_secs,
			max_seconds: MAX_DURATION_SECS,
		});
	}
	Ok(())
}

/// キャプション長を検証する(contract `jobManifest.caption` の `.max(2200)` と同じ基準、
/// UTF-16 コード単位で数える)。
pub fn validate_caption(caption: &str) -> Result<(), ValidationError> {
	let len = caption.encode_utf16().count();
	if len > MAX_CAPTION_UTF16_LEN {
		return Err(ValidationError::CaptionTooLong {
			len,
			max: MAX_CAPTION_UTF16_LEN,
		});
	}
	Ok(())
}

/// 公開時刻(unix ms)を検証する(contract `jobManifest.publishAt` と同じ基準、正の値のみ)。
pub fn validate_publish_at(publish_at_ms: i64) -> Result<(), ValidationError> {
	if publish_at_ms <= 0 {
		return Err(ValidationError::InvalidPublishAt {
			value: publish_at_ms,
		});
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	// ---- build_r2_key(旧 TS `scheduler-client.test.ts` と同じテストベクタ) --------

	#[test]
	fn build_r2_key_matches_ts_test_vector() {
		// 2026-07-10T12:34:56Z の unix ms(旧 TS テストと同じ日時)。
		let publish_at_ms = 1_783_686_896_000_i64;
		let uuid = uuid::Uuid::parse_str("11111111-2222-3333-4444-555555555555").unwrap();
		assert_eq!(
			build_r2_key(publish_at_ms, uuid),
			"posts/2026-07-10/11111111-2222-3333-4444-555555555555.mp4"
		);
	}

	#[test]
	fn build_r2_key_uses_utc_date_across_local_boundary() {
		// UTC では 2026-07-10 00:30(旧 TS テストの「ローカルタイムゾーンでは前日夜」ケース)。
		let publish_at_ms = 1_783_643_400_000_i64; // 2026-07-10T00:30:00Z
		let uuid = uuid::Uuid::parse_str("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap();
		assert_eq!(
			build_r2_key(publish_at_ms, uuid),
			"posts/2026-07-10/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4"
		);
	}

	#[test]
	fn civil_from_days_matches_unix_epoch() {
		assert_eq!(unix_ms_to_utc_date(0), "1970-01-01");
	}

	// ---- validate_file_size 境界値 --------------------------------------------------

	#[test]
	fn file_size_exactly_at_limit_is_valid() {
		assert!(validate_file_size(MAX_FILE_SIZE_BYTES).is_ok());
	}

	#[test]
	fn file_size_one_byte_over_limit_is_invalid() {
		assert!(validate_file_size(MAX_FILE_SIZE_BYTES + 1).is_err());
	}

	// ---- validate_duration 境界値 -----------------------------------------------------

	#[test]
	fn duration_exactly_min_is_valid() {
		assert!(validate_duration(MIN_DURATION_SECS).is_ok());
	}

	#[test]
	fn duration_just_under_min_is_invalid() {
		let err = validate_duration(MIN_DURATION_SECS - 0.001).unwrap_err();
		assert!(matches!(err, ValidationError::DurationTooShort { .. }));
	}

	#[test]
	fn duration_exactly_max_is_valid() {
		assert!(validate_duration(MAX_DURATION_SECS).is_ok());
	}

	#[test]
	fn duration_just_over_max_is_invalid() {
		let err = validate_duration(MAX_DURATION_SECS + 0.001).unwrap_err();
		assert!(matches!(err, ValidationError::DurationTooLong { .. }));
	}

	// ---- validate_caption 境界値 ------------------------------------------------------

	#[test]
	fn caption_exactly_at_limit_is_valid() {
		let caption = "a".repeat(MAX_CAPTION_UTF16_LEN);
		assert!(validate_caption(&caption).is_ok());
	}

	#[test]
	fn caption_one_over_limit_is_invalid() {
		let caption = "a".repeat(MAX_CAPTION_UTF16_LEN + 1);
		assert!(validate_caption(&caption).is_err());
	}

	// ---- validate_publish_at 境界値 ---------------------------------------------------

	#[test]
	fn publish_at_positive_is_valid() {
		assert!(validate_publish_at(1).is_ok());
	}

	#[test]
	fn publish_at_zero_is_invalid() {
		assert!(validate_publish_at(0).is_err());
	}

	#[test]
	fn publish_at_negative_is_invalid() {
		let err = validate_publish_at(-1).unwrap_err();
		assert!(matches!(
			err,
			ValidationError::InvalidPublishAt { value: -1 }
		));
	}

	// ---- JobManifest / MediaType の JSON 形状(リテラル値の固定) ----------------------

	#[test]
	fn job_manifest_serializes_to_contract_shape() {
		let manifest = new_job_manifest(
			"11111111-2222-3333-4444-555555555555".to_string(),
			"posts/2026-07-10/uuid.mp4".to_string(),
			"caption".to_string(),
			1_783_686_896_000,
		);
		let json = serde_json::to_value(&manifest).unwrap();
		assert_eq!(json["platform"], "instagram");
		assert_eq!(json["mediaType"], "REELS");
		assert_eq!(json["r2Key"], "posts/2026-07-10/uuid.mp4");
		assert_eq!(
			json["idempotencyKey"],
			"11111111-2222-3333-4444-555555555555"
		);
		assert_eq!(json["publishAt"], 1_783_686_896_000_i64);
	}

	#[test]
	fn job_create_response_deserializes_from_scheduler_shape() {
		let json = r#"{"id":"job-1","status":"pending"}"#;
		let resp: JobCreateResponse = serde_json::from_str(json).unwrap();
		assert_eq!(resp.id, "job-1");
		assert_eq!(resp.status, "pending");
	}

	/// `crates/contract-rs/build.rs` の `JobStatus`→`String` 差し替え設定の意図そのものを
	/// 固定する回帰テスト。差し替えが typify のバージョン更新や `$defs` 名変更で無効化
	/// されると `JobCreateResponse.status` が `enum JobStatus` に戻り、契約に無い
	/// 未知の status 値でこのテストが失敗するようになる(既存テストは "pending" 等の
	/// 既知の値しか使わないため、差し替えが壊れても気付けない — レビュー指摘対応)。
	#[test]
	fn job_create_response_accepts_unknown_status_value_forward_compat() {
		let json = r#"{"id":"job-1","status":"some-future-status-not-yet-known"}"#;
		let resp: JobCreateResponse = serde_json::from_str(json).expect(
			"status は String のため契約に無い未知の値でも desktop 側のデシリアライズは壊れない",
		);
		assert_eq!(resp.status, "some-future-status-not-yet-known");
	}

	/// 未知の**トップレベルフィールド**の許容(旧手書き型の寛容さ)を固定する回帰テスト。
	/// contract の zod スキーマは `.strict()` を使っておらず未知キーを黙って無視する
	/// (strip)ため、schema/*.json は `additionalProperties` を出力せず、typify の
	/// 生成型にも `#[serde(deny_unknown_fields)]` が付かない
	/// (`crates/contract-rs/build.rs` の「未知フィールドの許容」コメント参照)。
	/// これが退行する(生成スキーマに `additionalProperties: false` が復活する等)と、
	/// scheduler が応答にフィールドを追加した瞬間、自動更新にタイムラグのある旧バージョン
	/// の desktop でデシリアライズが失敗するようになるため、このテストで固定する。
	#[test]
	fn job_create_response_ignores_unknown_fields_forward_compat() {
		let json = r#"{"id":"job-1","status":"pending","someFutureField":{"nested":true}}"#;
		let resp: JobCreateResponse = serde_json::from_str(json).expect(
			"未知のトップレベルフィールドは無視され、デシリアライズは成功する(旧手書き型と同じ寛容さ)",
		);
		assert_eq!(resp.id, "job-1");
		assert_eq!(resp.status, "pending");
	}

	// ---- 旧手書き型時代の JSON フィクスチャの roundtrip(typify 配線の互換性固定) -----
	//
	// typify 配線(contract-rs の生成型への置き換え)の前後でワイヤ形式が1バイトも
	// 変わっていないことを、旧手書き型が実際に出力していた JSON リテラルを
	// デシリアライズ→再シリアライズして固定する(実装指示 パート A-4)。

	#[test]
	fn job_manifest_roundtrips_legacy_handwritten_fixture() {
		let legacy_json = serde_json::json!({
			"idempotencyKey": "11111111-2222-3333-4444-555555555555",
			"platform": "instagram",
			"r2Key": "posts/2026-07-10/uuid.mp4",
			"mediaType": "REELS",
			"caption": "caption",
			"publishAt": 1_783_686_896_000_i64,
		});
		let manifest: JobManifest = serde_json::from_value(legacy_json.clone())
			.expect("旧手書き型時代の JSON フィクスチャが生成型でもデシリアライズできること");
		let roundtripped = serde_json::to_value(&manifest).unwrap();
		assert_eq!(
			roundtripped, legacy_json,
			"typify 配線後もワイヤ形式(シリアライズ結果)が変わっていないこと"
		);
	}

	#[test]
	fn job_create_response_roundtrips_legacy_handwritten_fixture() {
		let legacy_json = serde_json::json!({ "id": "job-1", "status": "pending" });
		let resp: JobCreateResponse = serde_json::from_value(legacy_json.clone())
			.expect("旧手書き型時代の JSON フィクスチャが生成型でもデシリアライズできること");
		let roundtripped = serde_json::to_value(&resp).unwrap();
		assert_eq!(roundtripped, legacy_json);
	}

	// ---- 契約スキーマとの整合性検証(GHSA-6w5m-8gcr-rf63 / Issue #93) ------------------
	//
	// typify 配線後は `JobManifest`/`JobCreateResponse` 自体が
	// `packages/contract/schema/job-manifest.json` から生成された型になったため、
	// 以下のテストは「手書き型が契約から乖離していないか」ではなく「typify の生成結果
	// (`JobStatus` を `String` に差し替える設定を含む)が意図通りの JSON 表現に
	// なっているか」の回帰確認として引き続き維持する
	// (`crates/contract-rs/build.rs` 冒頭コメント参照)。

	use std::collections::BTreeSet;

	/// `packages/contract/schema/job-manifest.json` の内容そのもの。ワークスペース外
	/// (`apps/desktop` の外)のファイルを参照するため、`include_str!` のパスは
	/// `CARGO_MANIFEST_DIR` ではなく本ソースファイルからの相対パスになる点に注意。
	const JOB_MANIFEST_SCHEMA_JSON: &str =
		include_str!("../../../../../packages/contract/schema/job-manifest.json");

	fn contract_schema() -> serde_json::Value {
		serde_json::from_str(JOB_MANIFEST_SCHEMA_JSON)
			.expect("packages/contract/schema/job-manifest.json must be valid JSON")
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

	/// 単一フィールドの schema(`$ref`/`const`/`enum`/`type` のいずれか)を `value` と
	/// 照合する。本契約で使われる範囲(§検証範囲コメント)のみサポートする簡易実装。
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
			assert_field_matches_schema(root, schema_def(root, def_name), value, path);
			return;
		}
		if let Some(const_value) = field_schema.get("const") {
			assert_eq!(value, const_value, "{path}: const と不一致");
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
			.unwrap_or_else(|| panic!("{path}: $ref/const/enum/type のいずれも無い"));
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

	/// `actual`(オブジェクト)を `schema` の `$defs.<def_name>` と突き合わせる。
	/// 本関数が「契約の正」に対する実行時強制の中核(§モジュールコメント)。
	fn assert_object_matches_contract_schema(
		schema: &serde_json::Value,
		def_name: &str,
		actual: &serde_json::Value,
	) {
		let def_schema = schema_def(schema, def_name);
		let properties = def_schema["properties"]
			.as_object()
			.unwrap_or_else(|| panic!("{def_name}: properties が object ではない"));
		let required: BTreeSet<&str> = def_schema["required"]
			.as_array()
			.unwrap_or_else(|| panic!("{def_name}: required が array ではない"))
			.iter()
			.map(|v| v.as_str().unwrap())
			.collect();
		let actual_obj = actual
			.as_object()
			.unwrap_or_else(|| panic!("{def_name}: シリアライズ結果が object ではない"));

		// (a) キー集合が過不足なく一致する。
		let actual_keys: BTreeSet<&str> = actual_obj.keys().map(String::as_str).collect();
		let schema_keys: BTreeSet<&str> = properties.keys().map(String::as_str).collect();
		assert_eq!(
			actual_keys, schema_keys,
			"{def_name}: キー集合が契約スキーマと不一致(contract-rs の生成型が乖離しています)"
		);

		// (b) required がすべて出力に存在する(上の (a) で集合一致を見ているため、
		// required ⊆ properties である契約であれば実質冗長だが、将来 required だけが
		// properties の部分集合になるケースに備えて独立に検証する)。
		for key in &required {
			assert!(
				actual_obj.contains_key(*key),
				"{def_name}.{key} は契約上 required だが出力に無い"
			);
		}

		// (c) 各フィールドの型が一致する。
		for (key, field_schema) in properties {
			let value = &actual_obj[key];
			assert_field_matches_schema(schema, field_schema, value, &format!("{def_name}.{key}"));
		}
	}

	#[test]
	fn job_manifest_conforms_to_contract_schema() {
		let manifest = new_job_manifest(
			"11111111-2222-3333-4444-555555555555".to_string(),
			"posts/2026-07-10/uuid.mp4".to_string(),
			"caption".to_string(),
			1_783_686_896_000,
		);
		let actual = serde_json::to_value(&manifest).unwrap();
		assert_object_matches_contract_schema(&contract_schema(), "jobManifest", &actual);
	}

	#[test]
	fn job_create_response_conforms_to_contract_schema() {
		// `JobCreateResponse` は scheduler からの受信専用のため、ワイヤ表現
		// (scheduler が実際に返す JSON)側から出発して `serde_json::from_value` に
		// 通すことで、「このキー名で実際にデシリアライズできるか」自体も検証する。
		let wire = serde_json::json!({ "id": "job-1", "status": "pending" });
		let resp: JobCreateResponse = serde_json::from_value(wire.clone())
			.expect("wire JSON から JobCreateResponse へデシリアライズできること");
		assert_eq!(resp.id, "job-1");
		assert_eq!(resp.status, "pending");

		assert_object_matches_contract_schema(&contract_schema(), "jobCreateResponse", &wire);
	}
}
