/** ターゲットの出力形状。fit で「はみ出しをどう埋めるか」を決める。 */
export interface Preset {
	/** 表示・ファイル名用のラベル。ロジックは width/height/fit のみ使う。 */
	name: string;
	width: number;
	height: number;
	/**
	 * - "blur-pad": 全体を収め、余白をぼかした自身で埋める(被写体を切らない)
	 * - "crop": ターゲットを覆うようにスケールし中央クロップ(余白なし・端は切れる)
	 */
	fit: FitMode;
}

export type FitMode = "blur-pad" | "crop";

/**
 * ソース側の切り出し矩形。0..1 正規化(元解像度に依存しない)。
 * crop-overlay UI が出す矩形をそのまま表現できる。
 */
export interface CropRect {
	x: number; // 左端 0..1
	y: number; // 上端 0..1
	width: number; // 0..1
	height: number; // 0..1
}

/** イン/アウト点(秒)。end は排他ではなく到達時刻。 */
export interface Trim {
	start: number;
	end: number;
}

/** 編集の全指定。crop-overlay UI や desktop 側の manifest 生成が参照する。 */
export interface EditSpec {
	/** 元動画の実ピクセル寸法。crop 矩形をピクセルに解決するのに使う。 */
	source: { width: number; height: number };
	trim?: Trim;
	/** ソース側の事前クロップ(手動指定枠)。無指定なら全体を使う。 */
	crop?: CropRect;
	preset: Preset;
}
