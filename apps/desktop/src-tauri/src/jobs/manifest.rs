//! `packages/contract/src/job-manifest.ts` の `JobManifest`/`mediaType` に対応する
//! **暫定手書き型**(`crates/media-core/src/spec.rs` 冒頭コメントと同じ理由: typify に
//! よる契約コード生成 [`crate::jobs`] は Phase 0/2 のタスクのため未配線。contract-rs
//! 側に生成型が追加され次第、本モジュールはそちらへ差し替える前提)。
//!
//! `mediaType` は contract 上 `"VIDEO" | "REELS"` だが、Instagram Graph API の現行
//! リファレンスに `VIDEO` が存在しない(docs/desktop-migration-plan.md §6.4・§12.1)
//! ため、本実装は **`REELS` に一本化**する(1:1/4:5 の出力も REELS として投稿する)。
//! contract 側の enum 整理自体は Phase 0 のタスクとして据え置かれているため、ここでは
//! 「Rust 側は REELS のみを送出する」という運用上の決定にとどめる(contract の
//! zod スキーマは変更しない)。

use serde::Serialize;
use thiserror::Error;

/// Instagram の公開種別。REELS のみ(§モジュール冒頭コメント)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum MediaType {
	#[serde(rename = "REELS")]
	Reels,
}

/// `POST /jobs` のリクエストボディ(`packages/contract` の `jobManifest` に対応)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobManifest {
	pub idempotency_key: String,
	/// contract 上は `z.literal("instagram")`。将来他プラットフォームが増えても
	/// この構造体は IG 専用のまま(YouTube は別経路、§6.5)なので固定文字列でよい。
	pub platform: &'static str,
	pub r2_key: String,
	pub media_type: MediaType,
	pub caption: String,
	pub publish_at: i64,
}

impl JobManifest {
	pub fn new(idempotency_key: String, r2_key: String, caption: String, publish_at: i64) -> Self {
		Self {
			idempotency_key,
			platform: "instagram",
			r2_key,
			media_type: MediaType::Reels,
			caption,
			publish_at,
		}
	}
}

/// `POST /jobs` のレスポンス(`packages/contract` の `jobCreateResponse` に対応)。
/// `status` は contract の `jobStatus` 列挙をそのまま文字列として受け取る
/// (scheduler 側が将来値を追加してもデシリアライズが壊れないよう、意図的に
/// Rust 側では enum 化しない — renderer は文字列のまま表示できれば十分)。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct JobCreateResponse {
	pub id: String,
	pub status: String,
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

	// ---- JobManifest / MediaType の JSON 形状 ----------------------------------------

	#[test]
	fn job_manifest_serializes_to_contract_shape() {
		let manifest = JobManifest::new(
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
}
