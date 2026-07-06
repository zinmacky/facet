import type { EditSpec, FilterPlan } from "../types.js";
import { cropFilter } from "./crop.js";
import { trimArgs } from "./trim.js";
import { blurPad, cropCover } from "./blur-pad.js";

/**
 * EditSpec 1 つから完全な FilterPlan を導出する core の中心関数。
 *
 * グラフの流れ:
 *   [0:v] → (任意の事前クロップ) → fit(blur-pad | crop) → [out]
 *
 * trim は filtergraph ではなく seek 引数に落とす(キーフレームシークで高速)。
 */
export function compose(spec: EditSpec): FilterPlan {
	const { seekArgs, durationArgs } = trimArgs(spec.trim);

	const nodes: string[] = [];
	let cursor = "0:v";

	// 1. ソース側の事前クロップ(手動枠)
	if (spec.crop) {
		const filter = cropFilter(spec.crop, spec.source);
		nodes.push(`[${cursor}]${filter}[pre]`);
		cursor = "pre";
	}

	// 2. ターゲット形状への適合
	const seg =
		spec.preset.fit === "blur-pad"
			? blurPad(spec.preset, cursor, "out")
			: cropCover(spec.preset, cursor, "out");
	nodes.push(seg.chain);

	return {
		seekArgs,
		durationArgs,
		filterComplex: nodes.join(";"),
		outLabel: `[${seg.out}]`,
	};
}
