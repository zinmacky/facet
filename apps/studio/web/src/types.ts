import type { CropRect, EditSpec, FitMode, Trim } from "@facet/core";

/**
 * web ローカルの切り抜き(Clip)モデル。
 * 元画面では「時間トリム(見せる範囲)」+「空間クロップ枠(どの部分を見せるか)」を決める。
 * クロップ枠のアスペクト比はテンプレートで選ぶ。最終的なプラットフォーム別アスペクトと
 * フィット(そのまま/ぼかし背景)は UPLOAD モーダルで決める。
 */
export interface Clip {
  id: string;
  /** 出力ベース名。既定は `${base}_${seq}`。 */
  name: string;
  /** イン/アウト点(秒)。 */
  trim: Trim;
  /** クロップ枠(0..1 正規化)。未指定=全体。 */
  crop?: CropRect;
  /** クロップ枠のアスペクト比テンプレート。 */
  aspect: AspectTemplate;
}

// ---- アスペクト比テンプレート ----------------------------------------------

export type AspectTemplate = "16:9" | "4:3" | "1:1" | "9:16" | "free";

export interface AspectOption {
  value: AspectTemplate;
  label: string;
  /** width/height。free は null(自由比)。 */
  ratio: number | null;
}

export const ASPECT_TEMPLATES: AspectOption[] = [
  { value: "16:9", label: "16:9", ratio: 16 / 9 },
  { value: "4:3", label: "4:3", ratio: 4 / 3 },
  { value: "1:1", label: "1:1", ratio: 1 },
  { value: "9:16", label: "9:16", ratio: 9 / 16 },
  { value: "free", label: "自由", ratio: null },
];

export function aspectRatio(a: AspectTemplate): number | null {
  return ASPECT_TEMPLATES.find((t) => t.value === a)?.ratio ?? null;
}

/** 固定アスペクトのマスター出力寸法(1080 基準)。 */
const FIXED_DIMS: Record<Exclude<AspectTemplate, "free">, [number, number]> = {
  "16:9": [1920, 1080],
  "4:3": [1440, 1080],
  "1:1": [1080, 1080],
  "9:16": [1080, 1920],
};

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * アスペクトテンプレートのマスター出力寸法。
 * free は crop の実ピクセル寸法(未指定ならソース全体)から求める。
 */
export function masterDims(
  aspect: AspectTemplate,
  source: { width: number; height: number },
  crop?: CropRect,
): { width: number; height: number } {
  if (aspect === "free") {
    const w = crop ? crop.width * source.width : source.width;
    const h = crop ? crop.height * source.height : source.height;
    return { width: even(w), height: even(h) };
  }
  const [w, h] = FIXED_DIMS[aspect];
  return { width: w, height: h };
}

// ---- spec ビルダー ---------------------------------------------------------

/**
 * EXPORT 用: クロップした内容そのものを書き出す EditSpec。
 * crop 適用後、同アスペクトへ crop-cover(=実質スケールのみ)する。
 */
export function masterSpec(clip: Clip, source: { width: number; height: number }): EditSpec {
  const dims = masterDims(clip.aspect, source, clip.crop);
  return {
    source,
    trim: clip.trim,
    ...(clip.crop ? { crop: clip.crop } : {}),
    preset: { name: clip.aspect, width: dims.width, height: dims.height, fit: "crop" },
  };
}

/**
 * UPLOAD 用: 最終プラットフォーム仕様へ合わせる EditSpec。
 * fit="crop" は「そのまま(切り抜いて全面)」、"blur-pad" は「ぼかし背景で余白を埋める」。
 */
export function finalSpec(
  clip: Clip,
  source: { width: number; height: number },
  target: OutputTarget,
  fit: FitMode,
): EditSpec {
  return {
    source,
    trim: clip.trim,
    ...(clip.crop ? { crop: clip.crop } : {}),
    preset: { name: target.id, width: target.width, height: target.height, fit },
  };
}

// ---- 出力ターゲット(UPLOAD の最終アスペクト) ------------------------------

export interface OutputTarget {
  id: string;
  platform: "youtube" | "instagram";
  label: string;
  width: number;
  height: number;
}

export const OUTPUT_TARGETS: OutputTarget[] = [
  { id: "yt-landscape", platform: "youtube", label: "YouTube 横 (16:9)", width: 1920, height: 1080 },
  { id: "yt-shorts", platform: "youtube", label: "YouTube ショート (9:16)", width: 1080, height: 1920 },
  { id: "ig-square", platform: "instagram", label: "Instagram 正方形 (1:1)", width: 1080, height: 1080 },
  { id: "ig-portrait", platform: "instagram", label: "Instagram 縦 (4:5)", width: 1080, height: 1350 },
  { id: "ig-reels", platform: "instagram", label: "Instagram リール (9:16)", width: 1080, height: 1920 },
];

export function targetById(id: string): OutputTarget | undefined {
  return OUTPUT_TARGETS.find((t) => t.id === id);
}

/** フィットモードの選択肢(そのまま=crop / ぼかし背景=blur-pad)。 */
export const FIT_OPTIONS: { value: FitMode; label: string }[] = [
  { value: "crop", label: "そのまま(切り抜いて全面)" },
  { value: "blur-pad", label: "ぼかし背景で余白を埋める" },
];

// ---- ユーティリティ --------------------------------------------------------

/** ファイルパスから拡張子を除いたベース名を得る。 */
export function sourceBaseName(path: string): string {
  const segments = path.split(/[/\\]/);
  const file = segments[segments.length - 1] ?? path;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}
