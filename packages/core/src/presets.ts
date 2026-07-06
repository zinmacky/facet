import type { Preset, PresetName } from "./types.js";

/**
 * 既定プリセット。IG の仕様に合わせた 3 種。
 * - 9:16 REELS: 1080x1920(5〜90秒)。blur-pad が既定(縦動画に横素材を収める)。
 * - 1:1 フィード動画: 1080x1080(3〜60秒、Reels ではない)。
 * - 4:5 フィード: 1080x1350(縦長フィードの最大占有)。
 * fit は用途で上書き可能。ここでは無難な既定を与える。
 */
export const PRESETS: Record<PresetName, Preset> = {
  "9:16": { name: "9:16", width: 1080, height: 1920, fit: "blur-pad" },
  "1:1": { name: "1:1", width: 1080, height: 1080, fit: "crop" },
  "4:5": { name: "4:5", width: 1080, height: 1350, fit: "blur-pad" },
};

export function getPreset(name: PresetName): Preset {
  return PRESETS[name];
}
