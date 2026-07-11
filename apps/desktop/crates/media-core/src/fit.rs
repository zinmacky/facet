//! フィルタチェーン文字列の生成。
//!
//! TS 版(`packages/core/src/filtergraph/{compose,blur-pad,crop}.ts`)と等価な文字列を
//! 生成することを目標にする。`blur_pad`/`crop_cover` は TS の `blurPad`/`cropCover` と
//! 同一の中間ラベル(`bpbg`/`bpfg`/`bpbgb`/`bpfgs`)・同一のフィルタ引数を使うため、
//! 同じ `(in_label, out_label)` を渡せば TS 側のユニットテスト(`compose.test.ts`)が
//! アサートしている部分文字列とそのまま一致する(下のユニットテスト参照)。
//!
//! media-core の実行時(pipeline.rs)は libavfilter の `buffer`/`buffersink` を直接
//! 使うため、実際に渡す入力ラベルは `"in"`(スパイク `spikes/libav-reframe/src/reframe.rs`
//! の `filter_spec` を踏襲)。フィルタグラフの末尾には、エンコーダの pix_fmt と
//! 一致させるための `format=<pix_fmt>` ノードを追加する(不一致だとエンコーダへの
//! フレーム投入で失敗する)。
//!
//! trim(秒単位のイン/アウト点)は filtergraph ではなく decode 側のシークに落ちるため
//! ここでは扱わない(TS の `compose()` と同じ設計。Wave 2 の `trim.rs` で
//! `pipeline::ReframeOptions.trim` から実際のシーク処理へ接続予定 — 現状は
//! フィールドのみ用意されている、pipeline.rs の TODO 参照)。
//!
//! 事前クロップ(`CropRect` → `crop=` フィルタ文字列)の**計算ロジック自体**
//! (`toEven`/クランプ)は Wave 2 の `crop.rs` に残すが、計算済みのフィルタ文字列を
//! 差し込む口(`pre_crop` 引数)はここで用意しておく。

use crate::spec::{FitMode, Preset};

/// フィルタチェーンの断片。TS 版 `Segment`(`blur-pad.ts`)に対応。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
	/// このセグメントのグラフ文字列(セミコロン区切りの複数ノード可)。
	pub chain: String,
	/// 後続が接続すべき出力ラベル(角括弧なし、例: "out")。
	pub out: String,
}

/// blur-pad の既定 sigma。TS 版 `blurPad` の既定値・同等性検証の基準値
/// (docs/desktop-migration-plan.md §6.2)と同一。呼び出し側でパラメータ化できる。
pub const DEFAULT_SIGMA: u32 = 20;

/// blur-pad: 全体を収め、余白をぼかした自身の拡大コピーで埋める。
/// TS 版 `blurPad`(`packages/core/src/filtergraph/blur-pad.ts`)の移植。
pub fn blur_pad(preset: &Preset, in_label: &str, out_label: &str, sigma: u32) -> Segment {
	let (w, h) = (preset.width, preset.height);
	let chain = [
        format!("[{in_label}]split=2[bpbg][bpfg]"),
        format!(
            "[bpbg]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},gblur=sigma={sigma}[bpbgb]"
        ),
        format!("[bpfg]scale={w}:{h}:force_original_aspect_ratio=decrease[bpfgs]"),
        format!("[bpbgb][bpfgs]overlay=(W-w)/2:(H-h)/2[{out_label}]"),
    ]
    .join(";");
	Segment {
		chain,
		out: out_label.to_string(),
	}
}

/// crop-cover: ターゲットを覆うようにスケールし中央クロップ。
/// TS 版 `cropCover`(`packages/core/src/filtergraph/blur-pad.ts`)の移植。
pub fn crop_cover(preset: &Preset, in_label: &str, out_label: &str) -> Segment {
	let (w, h) = (preset.width, preset.height);
	let chain = format!(
		"[{in_label}]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}[{out_label}]"
	);
	Segment {
		chain,
		out: out_label.to_string(),
	}
}

/// `Preset.fit` に応じて blur-pad / crop-cover を組み立てる
/// (TS 版 `compose()` の「2. ターゲット形状への適合」に対応)。
pub fn fit_segment(preset: &Preset, in_label: &str, out_label: &str, sigma: u32) -> Segment {
	match preset.fit {
		FitMode::BlurPad => blur_pad(preset, in_label, out_label, sigma),
		FitMode::Crop => crop_cover(preset, in_label, out_label),
	}
}

/// TS 版 `compose()` の「事前クロップ + フィット」部分に対応する合成関数
/// (trim は含まない。TS 同様、シーク引数側の責務)。
///
/// `pre_crop` に計算済みの crop フィルタ文字列(例: `"crop=960:1080:480:0"`)を渡すと、
/// TS の `compose()` が `[pre]` ノードを前段に挿む挙動と同じ構造になる。
pub fn compose_fit(preset: &Preset, in_label: &str, pre_crop: Option<&str>, sigma: u32) -> Segment {
	let mut nodes: Vec<String> = Vec::new();
	let mut cursor = in_label.to_string();

	if let Some(pre_crop) = pre_crop {
		nodes.push(format!("[{cursor}]{pre_crop}[pre]"));
		cursor = "pre".to_string();
	}

	let seg = fit_segment(preset, &cursor, "out", sigma);
	nodes.push(seg.chain);

	Segment {
		chain: nodes.join(";"),
		out: seg.out,
	}
}

/// pipeline.rs から呼ぶ、libavfilter 用のフィルタグラフ文字列を組み立てるための入力。
pub struct FilterGraphSpec<'a> {
	pub preset: &'a Preset,
	/// 計算済みの事前クロップフィルタ文字列。TODO(Wave 2): `crop.rs` の
	/// `crop_filter()` の結果をここへ渡す形に接続する(現状は常に `None` で呼ばれる)。
	pub pre_crop: Option<&'a str>,
	/// エンコーダが要求するピクセルフォーマット名(`encode::pick_pixel_format` の結果を
	/// `encode::pix_fmt_name` で文字列化したもの)。フィルタグラフ末尾の `format=` と
	/// 一致させる必要がある。
	pub pix_fmt: &'a str,
	pub sigma: u32,
}

/// フィルタグラフ全体の文字列を組み立てる。入力ラベルは `"in"` 固定
/// (buffer ソース名と一致させる、スパイク同様)。生成される文字列は
/// `graph.output("in", 0)?.input("out", 0)?.parse(&spec)` にそのまま渡せる。
pub fn build_filter_graph(spec: &FilterGraphSpec<'_>) -> String {
	let seg = compose_fit(spec.preset, "in", spec.pre_crop, spec.sigma);
	format!("{};[{}]format={}[out]", seg.chain, seg.out, spec.pix_fmt)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::spec::FitMode;

	fn preset_9_16_blur_pad() -> Preset {
		Preset {
			name: "9:16".to_string(),
			width: 1080,
			height: 1920,
			fit: FitMode::BlurPad,
		}
	}

	fn preset_1_1_crop() -> Preset {
		Preset {
			name: "1:1".to_string(),
			width: 1080,
			height: 1080,
			fit: FitMode::Crop,
		}
	}

	// TS 版 compose.test.ts: "9:16 blur-pad: split/overlay を含み out ラベルで終わる"
	#[test]
	fn blur_pad_matches_ts_compose_test() {
		let preset = preset_9_16_blur_pad();
		let seg = compose_fit(&preset, "0:v", None, DEFAULT_SIGMA);
		assert_eq!(seg.out, "out");
		assert!(seg.chain.contains("split=2"));
		assert!(seg.chain.contains("gblur=sigma=20"));
		assert!(seg.chain.contains("overlay=(W-w)/2:(H-h)/2"));
		assert!(seg.chain.contains("scale=1080:1920"));
	}

	// TS 版 compose.test.ts: "1:1 crop: crop-cover になり blur を含まない"
	#[test]
	fn crop_cover_matches_ts_compose_test() {
		let preset = preset_1_1_crop();
		let seg = compose_fit(&preset, "0:v", None, DEFAULT_SIGMA);
		assert!(seg
			.chain
			.contains("scale=1080:1080:force_original_aspect_ratio=increase"));
		assert!(seg.chain.contains("crop=1080:1080"));
		assert!(!seg.chain.contains("gblur"));
	}

	// TS 版 compose.test.ts: "事前クロップ指定で [pre] ノードが前段に入る"
	#[test]
	fn pre_crop_inserts_pre_node_matching_ts_compose_test() {
		let preset = preset_9_16_blur_pad();
		// 0.5 * 1920 = 960(偶数), 1 * 1080 = 1080, x = 0.25*1920 = 480(TS 側テストと同じ入力)
		let seg = compose_fit(&preset, "0:v", Some("crop=960:1080:480:0"), DEFAULT_SIGMA);
		assert!(seg.chain.contains("[0:v]crop=960:1080:480:0[pre]"));
		assert!(seg.chain.contains("[pre]"));
	}

	#[test]
	fn blur_pad_exact_chain_string() {
		// TS 版 blurPad の出力と 1 文字違わず一致することを確認する
		// (packages/core/src/filtergraph/blur-pad.ts の blurPad と同一の中間ラベル)。
		let preset = Preset {
			name: "9:16".to_string(),
			width: 1080,
			height: 1920,
			fit: FitMode::BlurPad,
		};
		let seg = blur_pad(&preset, "0:v", "out", 20);
		assert_eq!(
            seg.chain,
            "[0:v]split=2[bpbg][bpfg];\
             [bpbg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=20[bpbgb];\
             [bpfg]scale=1080:1920:force_original_aspect_ratio=decrease[bpfgs];\
             [bpbgb][bpfgs]overlay=(W-w)/2:(H-h)/2[out]"
        );
	}

	#[test]
	fn crop_cover_exact_chain_string() {
		// TS 版 cropCover の出力と 1 文字違わず一致することを確認する。
		let preset = Preset {
			name: "1:1".to_string(),
			width: 1080,
			height: 1080,
			fit: FitMode::Crop,
		};
		let seg = crop_cover(&preset, "0:v", "out");
		assert_eq!(
			seg.chain,
			"[0:v]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080[out]"
		);
	}

	#[test]
	fn sigma_is_parameterized() {
		let preset = preset_9_16_blur_pad();
		let seg = blur_pad(&preset, "in", "out", 5);
		assert!(seg.chain.contains("gblur=sigma=5"));
		assert!(!seg.chain.contains("gblur=sigma=20"));
	}

	#[test]
	fn build_filter_graph_appends_format_and_uses_in_out_labels() {
		let preset = preset_1_1_crop();
		let spec = FilterGraphSpec {
			preset: &preset,
			pre_crop: None,
			pix_fmt: "nv12",
			sigma: DEFAULT_SIGMA,
		};
		let graph = build_filter_graph(&spec);
		assert!(graph.starts_with("[in]scale=1080:1080"));
		assert!(graph.contains(";[out]format=nv12[out]"));
		assert!(graph.ends_with("[out]format=nv12[out]"));
	}
}
