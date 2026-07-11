//! `EditSpec` とその依存型の JSON 互換 serde 構造体。
//!
//! **暫定手書き型**: `crates/contract-rs` は将来 `packages/contract` の JSON Schema
//! から生成する型の re-export を担う想定だが、`EditSpec` は現状
//! `packages/core/src/types.ts`(TS 側の「真実の源」)にのみ定義されており、
//! contract のスキーマ生成対象ではない。将来 contract-rs 側に生成型が追加され
//! 次第、本モジュールはそちらへ差し替える前提の暫定実装。
//!
//! フィールド名・optional 性は `packages/core/src/types.ts` に厳密に合わせている
//! (TS 側の optional プロパティ = `undefined` は JSON.stringify でキー自体が
//! 落ちるため、Rust 側は `Option<T>` + `#[serde(default)]` でキー欠落を
//! `None` として受け付ける)。

use serde::{Deserialize, Serialize};

/// 元動画の実ピクセル寸法。crop 矩形をピクセルに解決するのに使う。
/// TS 側は `EditSpec.source: { width: number; height: number }` という無名型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDimensions {
	pub width: u32,
	pub height: u32,
}

/// イン/アウト点(秒)。end は排他ではなく到達時刻。
/// (`packages/core/src/types.ts` の `Trim` に対応)
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trim {
	pub start: f64,
	pub end: f64,
}

/// ソース側の切り出し矩形。0..1 正規化(元解像度に依存しない)。
/// crop-overlay UI が出す矩形をそのまま表現できる。
/// (`packages/core/src/types.ts` の `CropRect` に対応)
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
	/// 左端 0..1
	pub x: f64,
	/// 上端 0..1
	pub y: f64,
	pub width: f64,
	pub height: f64,
}

/// - "blur-pad": 全体を収め、余白をぼかした自身で埋める(被写体を切らない)
/// - "crop": ターゲットを覆うようにスケールし中央クロップ(余白なし・端は切れる)
///
/// (`packages/core/src/types.ts` の `FitMode` = `"blur-pad" | "crop"` に対応。
/// enum variant は kebab-case でリネームし、TS のリテラル文字列と一致させる)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FitMode {
	BlurPad,
	Crop,
}

/// ターゲットの出力形状。fit で「はみ出しをどう埋めるか」を決める。
/// (`packages/core/src/types.ts` の `Preset` に対応)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
	/// 表示・ファイル名用のラベル。ロジックは width/height/fit のみ使う。
	pub name: String,
	pub width: u32,
	pub height: u32,
	pub fit: FitMode,
}

/// 編集の全指定。core(TS)はこれ 1 つから `FilterPlan` を導出する。
/// media-core(Rust)は同じ JSON をこの型でデシリアライズして扱う。
/// (`packages/core/src/types.ts` の `EditSpec` に対応)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSpec {
	pub source: SourceDimensions,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub trim: Option<Trim>,
	/// ソース側の事前クロップ(手動指定枠)。無指定なら全体を使う。
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub crop: Option<CropRect>,
	pub preset: Preset,
}

#[cfg(test)]
mod tests {
	use super::*;

	/// JSON 文字列を deserialize → serialize → 再 deserialize し、
	/// 1 回目と 2 回目の deserialize 結果が一致することを確認する
	/// (round-trip: JSON 互換性の検証。TS 側が出す JSON をそのまま読めるかが主眼)。
	fn assert_round_trip(json: &str) -> EditSpec {
		let first: EditSpec = serde_json::from_str(json).expect("first deserialize failed");
		let serialized = serde_json::to_string(&first).expect("serialize failed");
		let second: EditSpec =
			serde_json::from_str(&serialized).expect("second deserialize failed");
		assert_eq!(first, second, "round-trip mismatch:\n{serialized}");
		first
	}

	#[test]
	fn round_trip_full_spec() {
		// フル指定: source / trim / crop / preset すべてあり(9:16 blur-pad 相当)。
		let json = r#"{
			"source": { "width": 1920, "height": 1080 },
			"trim": { "start": 1.5, "end": 9.0 },
			"crop": { "x": 0.25, "y": 0, "width": 0.5, "height": 1 },
			"preset": { "name": "9:16", "width": 1080, "height": 1920, "fit": "blur-pad" }
		}"#;
		let spec = assert_round_trip(json);
		assert_eq!(
			spec.source,
			SourceDimensions {
				width: 1920,
				height: 1080
			}
		);
		assert_eq!(
			spec.trim,
			Some(Trim {
				start: 1.5,
				end: 9.0
			})
		);
		assert_eq!(
			spec.crop,
			Some(CropRect {
				x: 0.25,
				y: 0.0,
				width: 0.5,
				height: 1.0
			})
		);
		assert_eq!(spec.preset.fit, FitMode::BlurPad);
	}

	#[test]
	fn round_trip_minimal_spec() {
		// 最小指定: source + preset のみ(trim/crop はキー自体が無い = TS の undefined)。
		let json = r#"{
			"source": { "width": 1920, "height": 1080 },
			"preset": { "name": "1:1", "width": 1080, "height": 1080, "fit": "crop" }
		}"#;
		let spec = assert_round_trip(json);
		assert_eq!(spec.trim, None);
		assert_eq!(spec.crop, None);
		assert_eq!(spec.preset.fit, FitMode::Crop);
	}

	#[test]
	fn round_trip_without_crop() {
		// crop なし: 事前クロップを使わないケース。
		let json = r#"{
			"source": { "width": 1280, "height": 720 },
			"trim": { "start": 0, "end": 5 },
			"preset": { "name": "4:5", "width": 1080, "height": 1350, "fit": "blur-pad" }
		}"#;
		let spec = assert_round_trip(json);
		assert_eq!(spec.crop, None);
		assert_eq!(
			spec.trim,
			Some(Trim {
				start: 0.0,
				end: 5.0
			})
		);
	}

	#[test]
	fn round_trip_without_trim() {
		// trim なし: 全尺を使うケース。
		let json = r#"{
			"source": { "width": 3840, "height": 2160 },
			"crop": { "x": 0, "y": 0.1, "width": 1, "height": 0.8 },
			"preset": { "name": "9:16", "width": 1080, "height": 1920, "fit": "crop" }
		}"#;
		let spec = assert_round_trip(json);
		assert_eq!(spec.trim, None);
		assert_eq!(
			spec.crop,
			Some(CropRect {
				x: 0.0,
				y: 0.1,
				width: 1.0,
				height: 0.8
			})
		);
	}
}
