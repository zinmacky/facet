import { z } from "zod";

/**
 * `packages/core/src/types.ts` の `EditSpec`(TS↔Rust 境界の中核型)に対応する契約。
 * `reframe_start`/`preview_start`(`apps/desktop/src-tauri/src/commands/{reframe,preview}.rs`)
 * が受け取る `spec` 引数のワイヤ形式そのもので、Rust 側は
 * `apps/desktop/crates/media-core/src/spec.rs` の手書き serde 型でデシリアライズする。
 *
 * `job-manifest.ts`/`ig-publish-events.ts` と異なり EditSpec は言語間の唯一の境界
 * ではなく core(TS)側にも既存の手書き型があるため、本ファイルは「TS 側の真実の源を
 * 置き換える」のではなく「TS 手書き型・Rust 手書き型の両方が本当に同形かを機械的に
 * 検証するための第三の記述」として追加する(`packages/core/src/types.ts` の型定義は
 * 変更しない — 利用側 churn を避けるため)。同形であることは
 * `apps/desktop/src/test/editSpec-contract-types.test.ts`(TS 型レベル)・
 * `apps/desktop/src-tauri/src/commands/edit_spec_contract.rs`(Rust ランタイム、
 * schema/edit-spec.json との突き合わせ)の双方で強制する。
 *
 * ワイヤ形式を1ビットも変えないため、TS 側の optional プロパティ(`trim`/`crop`)は
 * ここでも `.optional()` とし、`.strict()` は使わない(他の契約ファイルと同じ理由 —
 * `generate-schema.mjs` 冒頭コメント「本パッケージの z.object() は .strict() を
 * 使っていない」参照。EditSpec は同一プロセス内境界で将来フィールドが増えても
 * 動作し続けるべきという判断は他契約と同じ)。
 */

/**
 * - "blur-pad": 全体を収め、余白をぼかした自身で埋める(被写体を切らない)
 * - "crop": ターゲットを覆うようにスケールし中央クロップ(余白なし・端は切れる)
 *
 * (`packages/core/src/types.ts` の `FitMode` に対応)
 */
export const fitMode = z.enum(["blur-pad", "crop"]);
export type FitMode = z.infer<typeof fitMode>;

/**
 * 元動画の実ピクセル寸法。crop 矩形をピクセルに解決するのに使う。
 * (`packages/core/src/types.ts` の `EditSpec.source` 無名型に対応。Rust 側は
 * `SourceDimensions`(u32)という名前を持つが、TS 側に対応する型名は無いため
 * ここでは Rust 側の名前を借りる)
 */
export const sourceDimensions = z.object({
	width: z.number().int().nonnegative(),
	height: z.number().int().nonnegative(),
});
export type SourceDimensions = z.infer<typeof sourceDimensions>;

/** イン/アウト点(秒)。end は排他ではなく到達時刻。(`Trim` に対応) */
export const trim = z.object({
	start: z.number(),
	end: z.number(),
});
export type Trim = z.infer<typeof trim>;

/**
 * ソース側の切り出し矩形。0..1 正規化(元解像度に依存しない)。
 * (`CropRect` に対応。0..1 という不変条件は core/Rust どちらの型でも実行時検証されて
 * いないため、ここでも境界値制約は付けない — 契約を実装より厳しくしない。
 * `sourceDimensions`/`preset` の width/height に `.int().nonnegative()` を付けているのは
 * これと矛盾しない — あちらは Rust 側が `u32` という「実装が実際に強制している型」を
 * 持つのに対し、こちらの 0..1 範囲はコメント上の意図に留まり実行時制約が無いため)
 */
export const cropRect = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
});
export type CropRect = z.infer<typeof cropRect>;

/** ターゲットの出力形状。fit で「はみ出しをどう埋めるか」を決める。(`Preset` に対応) */
export const preset = z.object({
	/** 表示・ファイル名用のラベル。ロジックは width/height/fit のみ使う。 */
	name: z.string(),
	width: z.number().int().nonnegative(),
	height: z.number().int().nonnegative(),
	fit: fitMode,
});
export type Preset = z.infer<typeof preset>;

/** 編集の全指定。core(TS)/media-core(Rust)はこれ 1 つから出力を導出する。 */
export const editSpec = z.object({
	source: sourceDimensions,
	trim: trim.optional(),
	/** ソース側の事前クロップ(手動指定枠)。無指定なら全体を使う。 */
	crop: cropRect.optional(),
	preset,
});
export type EditSpec = z.infer<typeof editSpec>;
