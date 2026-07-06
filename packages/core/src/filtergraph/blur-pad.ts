import type { Preset } from "../types.js";

export interface Segment {
  /** このセグメントのグラフ文字列(セミコロン区切りの複数ノード可)。 */
  chain: string;
  /** 後続が接続すべき出力ラベル(角括弧なし、例: "out")。 */
  out: string;
}

/**
 * blur-pad: 全体を収め、余白をぼかした自身の拡大コピーで埋める。
 * 縦動画に横素材を入れても被写体が切れない。
 */
export function blurPad(preset: Preset, inLabel: string, outLabel: string, sigma = 20): Segment {
  const { width: w, height: h } = preset;
  const chain = [
    `[${inLabel}]split=2[bpbg][bpfg]`,
    `[bpbg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=${sigma}[bpbgb]`,
    `[bpfg]scale=${w}:${h}:force_original_aspect_ratio=decrease[bpfgs]`,
    `[bpbgb][bpfgs]overlay=(W-w)/2:(H-h)/2[${outLabel}]`,
  ].join(";");
  return { chain, out: outLabel };
}

/**
 * crop-cover: ターゲットを覆うようにスケールし中央クロップ。
 * 余白ゼロだが端は切れる。1:1 の既定など「隙間を作りたくない」用途向け。
 */
export function cropCover(preset: Preset, inLabel: string, outLabel: string): Segment {
  const { width: w, height: h } = preset;
  const chain = `[${inLabel}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}[${outLabel}]`;
  return { chain, out: outLabel };
}
