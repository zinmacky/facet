import type { CropRect, Preset, Trim } from "@reframe/core";
import { PRESETS } from "@reframe/core";

/** 出力バリアント種別。short=9:16, insta=1:1。 */
export type VariantKind = "short" | "insta";

/**
 * web ローカルの切り抜き(Clip)モデル。
 * 1 つの元動画に対して複数作成でき、各 Clip は独立した trim/crop/メタデータを持つ。
 * crop はフォーマット非依存の注目領域。全体を使う場合は undefined に正規化する。
 */
export interface Clip {
  /** crypto.randomUUID() で採番する安定 ID。 */
  id: string;
  /** 出力ベース名。既定は `${base}_${seq}`(例: myvideo_1)。 */
  name: string;
  /** イン/アウト点(秒)。 */
  trim: Trim;
  /** 注目領域(0..1 正規化)。未指定=全体。 */
  crop?: CropRect;
  /** どのフォーマットを作るか。少なくとも 1 つは true。 */
  variants: Record<VariantKind, boolean>;
  /** short(9:16)→YouTube 用メタデータ。 */
  youtube: { title: string; description: string };
  /** insta(1:1)→Instagram 用メタデータ。 */
  instagram: { caption: string };
}

/** VariantKind に対応する出力プリセットを返す(short→9:16, insta→1:1)。 */
export function presetForVariant(variant: VariantKind): Preset {
  return variant === "short" ? PRESETS["9:16"] : PRESETS["1:1"];
}

/** VariantKind のプリセットのアスペクト比(width/height)を返す。 */
export function aspectForVariant(variant: VariantKind): number {
  const p = presetForVariant(variant);
  return p.width / p.height;
}

/** バリアント別の出力ファイル接尾辞(short→9x16, insta→1x1)。 */
export function variantSuffix(variant: VariantKind): string {
  return variant === "short" ? "9x16" : "1x1";
}

/** バリアントの日本語ラベル。 */
export function variantLabel(variant: VariantKind): string {
  return variant === "short" ? "ショート(9:16)" : "insta(1:1)";
}

/**
 * ファイルパスから拡張子を除いたベース名を得る。
 * 例: "/Users/me/clips/myvideo.mp4" → "myvideo"。
 */
export function sourceBaseName(path: string): string {
  // OS 差異を吸収するため / と \ の両方で分割する。
  const segments = path.split(/[/\\]/);
  const file = segments[segments.length - 1] ?? path;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}
