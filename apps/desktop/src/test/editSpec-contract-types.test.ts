import type { EditSpec as CoreEditSpec } from "@facet/core";
import { editSpec, type EditSpec as ContractEditSpec } from "@facet/contract";
import { describe, expect, it } from "vitest";

/**
 * `EditSpec`(TS↔Rust 境界の中核型、`reframe_start`/`preview_start` の `spec` 引数)は
 * `packages/core/src/types.ts`(TS 側の真実の源)に手書きされている一方、
 * `packages/contract/src/edit-spec.ts` の zod スキーマは「ワイヤ形式が本当に同形か」を
 * 機械的に検証するための第三の記述として追加した(`edit-spec.ts` 冒頭コメント参照)。
 *
 * 本ファイルは両者の型が相互代入可能(structural に同形)であることをコンパイル時に
 * 強制する。片方向の代入可能性だけだと「余剰プロパティ」「optional の食い違い」を
 * 見逃しうるため、双方向で固定する。ズレるとこのファイル自体が型エラーになり
 * `pnpm -r typecheck` が落ちる — 実行時アサーションではなく型システムでの検証が主眼
 * (下記 `it` は「型チェックがコンパイルを通ること」自体を担保する形だけの実行)。
 */
function assertCoreIsAssignableToContract(value: CoreEditSpec): ContractEditSpec {
	return value;
}

function assertContractIsAssignableToCore(value: ContractEditSpec): CoreEditSpec {
	return value;
}

describe("EditSpec: core の手書き型と contract の zod スキーマの相互代入可能性(コンパイル時契約)", () => {
	it("双方向の代入がコンパイルを通り、実行時にも値が保たれる", () => {
		const sample: CoreEditSpec = {
			source: { width: 1920, height: 1080 },
			trim: { start: 1.5, end: 9.0 },
			crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
			preset: { name: "9:16", width: 1080, height: 1920, fit: "blur-pad" },
		};

		expect(assertCoreIsAssignableToContract(sample)).toEqual(sample);
		expect(assertContractIsAssignableToCore(editSpec.parse(sample))).toEqual(sample);
	});
});
