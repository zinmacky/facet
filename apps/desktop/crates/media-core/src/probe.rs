//! ffprobe 相当のメディア情報取得。
//!
//! 移植元(真実の源): `packages/ffmpeg-runner/src/probe.ts`。TS 版は `ffprobe` を
//! spawn し JSON 出力をパースするが、こちらは libav (`format::input`) から直接
//! メタデータを読む。返す構造体([`MediaInfo`])のフィールド名は TS 版
//! `ProbeResult`(camelCase)に合わせてあり、将来 Tauri コマンドから
//! そのまま `serde_json` で renderer へ返せる。
//!
//! 入力オープン〜映像ストリーム選択〜デコーダ構築は `decode::open_input` を再利用する
//! (`DecodeContext.input`/`stream_index` はどちらも公開フィールドなので、
//! フレームレートや尺の取得のためにコンテナのストリーム情報へ再アクセスできる)。
//!
//! `dar`(表示アスペクト比)について: TS 版は ffprobe が計算した
//! `display_aspect_ratio` を優先し、無ければ `computeDar(width, height)`
//! (SAR を無視した単純な width:height の既約分数)にフォールバックする。
//! libav の `AVStream` には ffprobe が計算する `display_aspect_ratio` 相当の
//! フィールドが存在しない(ffprobe 側で都度計算される値)ため、こちらは常に
//! `compute_dar` のフォールバック経路のみを使う。SAR が 1:1 でない(非正方画素)
//! 入力では TS 版の ffprobe 優先経路と値がずれ得る点に注意(統合時の申し送り事項)。

use std::path::Path;

use ffmpeg_next::media;
use serde::Serialize;

use crate::decode;
use crate::error::{MediaError, Result};

/// probe が返す正規化済みメディア情報。TS 版 `ProbeResult` と同一フィールド。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
	/// 尺(秒)。
	pub duration: f64,
	/// 映像の幅(ピクセル)。
	pub width: u32,
	/// 映像の高さ(ピクセル)。
	pub height: u32,
	/// サンプルアスペクト比(例 "1:1")。不明なら "1:1"。
	pub sar: String,
	/// 表示アスペクト比(例 "16:9")。width/height から計算(上記モジュール doc 参照)。
	pub dar: String,
	/// フレームレート(fps)。`r_frame_rate` を評価した値。
	pub fps: f64,
	/// 音声ストリームの有無。
	pub has_audio: bool,
	/// 映像コーデック名(例 "h264")。
	pub codec: String,
}

/// 入力ファイルを解析してメディア情報を返す。
///
/// 映像ストリームが無い/寸法が取得できない場合は明確なエラーを返す
/// (TS 版 `probe()` と同じ失敗条件)。
pub fn probe(path: &Path) -> Result<MediaInfo> {
	// `pipeline::reframe` 同様、公開 API の入り口で libav の初期化を保証する
	// (`decode::open_input` 自体は初期化を前提とするだけで呼ばない設計 — decode.rs 冒頭コメント参照)。
	decode::init()?;
	let ctx = decode::open_input(path)?;

	let width = ctx.decoder.width();
	let height = ctx.decoder.height();
	if width == 0 || height == 0 {
		return Err(MediaError::InvalidDimensions {
			path: path.to_path_buf(),
		});
	}

	let sar_ratio = decode::sample_aspect_ratio(&ctx.decoder);
	let sar = ratio_to_string(sar_ratio.numerator(), sar_ratio.denominator());
	let dar = compute_dar(width, height);

	let codec = ctx.decoder.id().name().to_string();

	let has_audio = ctx
		.input
		.streams()
		.any(|stream| stream.parameters().medium() == media::Type::Audio);

	let video_stream =
		ctx.input
			.stream(ctx.stream_index)
			.ok_or_else(|| MediaError::InputStreamMissing {
				path: path.to_path_buf(),
				index: ctx.stream_index,
			})?;

	let rate = video_stream.rate();
	let fps = parse_frame_rate(Some(&format!(
		"{}/{}",
		rate.numerator(),
		rate.denominator()
	)));

	let duration = duration_seconds(&ctx, &video_stream);

	Ok(MediaInfo {
		duration,
		width,
		height,
		sar,
		dar,
		fps,
		has_audio,
		codec,
	})
}

/// コンテナ全体の尺(秒)。TS 版が `format.duration` を優先し、無ければ映像ストリーム
/// 側の `duration` にフォールバックするのと同じ優先順位。
/// どちらも不明・不正(0 以下 / 非有限)なら 0 を返す(TS 版の `Number.isFinite` ガードと同じ)。
///
/// `pub(crate)`: pipeline.rs が trim 適用後の `Progress.total_frames` を見積もる際、
/// probe 用に別途ファイルを開き直さず同じ `decode::DecodeContext` から尺を得るために使う
/// (Wave 2 配線)。
pub(crate) fn duration_seconds(
	ctx: &decode::DecodeContext,
	video_stream: &ffmpeg_next::Stream<'_>,
) -> f64 {
	let container = positive_duration(ctx.input.duration(), ffmpeg_next::rescale::TIME_BASE);
	let stream = positive_duration(video_stream.duration(), ctx.time_base);
	let duration = container.or(stream).unwrap_or(0.0);
	if duration.is_finite() {
		duration
	} else {
		0.0
	}
}

/// libav の `raw`(`time_base` 単位の整数尺)を秒に変換する。`raw` が 0 以下
/// (未申告 = `AV_NOPTS_VALUE` を含む)、または `time_base` の分母が 0 の場合は `None`。
fn positive_duration(raw: i64, time_base: ffmpeg_next::Rational) -> Option<f64> {
	if raw <= 0 || time_base.denominator() == 0 {
		return None;
	}
	Some(raw as f64 * time_base.numerator() as f64 / time_base.denominator() as f64)
}

/// `num:den` 形式の比率文字列を作る(`sar`/`dar` 表示用。TS 版の `"1:1"`/`"16:9"`
/// 形式に合わせる)。
fn ratio_to_string(num: i32, den: i32) -> String {
	format!("{num}:{den}")
}

/// "30000/1001" や "30/1" 形式の分数文字列を fps に評価する。0 除算・不正時は 0。
/// TS 版 `parseFrameRate`(`packages/ffmpeg-runner/src/probe.ts`)と同値。
fn parse_frame_rate(value: Option<&str>) -> f64 {
	let Some(value) = value else {
		return 0.0;
	};
	let mut parts = value.split('/');
	let num = parts.next().map(js_number);
	let den = match parts.next() {
		Some(raw) => Some(js_number(raw)),
		None => Some(1.0),
	};
	match (num, den) {
		(Some(num), Some(den)) if num.is_finite() && den.is_finite() && den != 0.0 => num / den,
		_ => 0.0,
	}
}

/// TS の `Number(string)` に寄せた変換(空文字/空白のみは 0、それ以外は f64 パース。
/// 失敗時は `NaN` を返し、呼び出し側の `is_finite` ガードに委ねる)。
fn js_number(raw: &str) -> f64 {
	let trimmed = raw.trim();
	if trimmed.is_empty() {
		0.0
	} else {
		trimmed.parse::<f64>().unwrap_or(f64::NAN)
	}
}

/// 2 数の最大公約数(dar 計算用)。TS 版 `gcd` と同値。
fn gcd(a: i64, b: i64) -> i64 {
	let mut x = a.abs();
	let mut y = b.abs();
	while y != 0 {
		let r = x % y;
		x = y;
		y = r;
	}
	x
}

/// width/height から表示アスペクト比文字列("16:9" 形式)を導く。
/// TS 版 `computeDar` と同値(SAR は考慮しない、上記モジュール doc 参照)。
fn compute_dar(width: u32, height: u32) -> String {
	if width == 0 || height == 0 {
		return "1:1".to_string();
	}
	let g = gcd(width as i64, height as i64);
	let g = if g == 0 { 1 } else { g };
	format!("{}:{}", width as i64 / g, height as i64 / g)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_frame_rate_ntsc_fraction() {
		let fps = parse_frame_rate(Some("30000/1001"));
		assert!((fps - 29.970_029_970_029_97).abs() < 1e-9);
	}

	#[test]
	fn parse_frame_rate_integer_ratio() {
		assert_eq!(parse_frame_rate(Some("30/1")), 30.0);
	}

	#[test]
	fn parse_frame_rate_no_denominator_defaults_to_one() {
		assert_eq!(parse_frame_rate(Some("25")), 25.0);
	}

	#[test]
	fn parse_frame_rate_zero_denominator_is_zero() {
		assert_eq!(parse_frame_rate(Some("30/0")), 0.0);
	}

	#[test]
	fn parse_frame_rate_none_is_zero() {
		assert_eq!(parse_frame_rate(None), 0.0);
	}

	#[test]
	fn parse_frame_rate_empty_string_is_zero() {
		assert_eq!(parse_frame_rate(Some("")), 0.0);
	}

	#[test]
	fn parse_frame_rate_non_numeric_is_zero() {
		assert_eq!(parse_frame_rate(Some("abc/1")), 0.0);
	}

	#[test]
	fn gcd_basic() {
		assert_eq!(gcd(1920, 1080), 120);
		assert_eq!(gcd(0, 5), 5);
		assert_eq!(gcd(5, 0), 5);
		assert_eq!(gcd(0, 0), 0);
	}

	#[test]
	fn compute_dar_16_9() {
		assert_eq!(compute_dar(1920, 1080), "16:9");
	}

	#[test]
	fn compute_dar_1_1() {
		assert_eq!(compute_dar(1080, 1080), "1:1");
	}

	#[test]
	fn compute_dar_9_16_portrait() {
		assert_eq!(compute_dar(1080, 1920), "9:16");
	}

	#[test]
	fn compute_dar_zero_dimension_falls_back_to_1_1() {
		assert_eq!(compute_dar(0, 1080), "1:1");
		assert_eq!(compute_dar(1920, 0), "1:1");
	}

	#[test]
	fn media_info_serializes_camel_case() {
		let info = MediaInfo {
			duration: 5.0,
			width: 1920,
			height: 1080,
			sar: "1:1".to_string(),
			dar: "16:9".to_string(),
			fps: 30.0,
			has_audio: true,
			codec: "h264".to_string(),
		};
		let json = serde_json::to_value(&info).expect("MediaInfo は常に serialize 可能");
		assert_eq!(json["hasAudio"], serde_json::json!(true));
		assert_eq!(json.get("has_audio"), None);
	}
}
