/**
 * `items` の中でベース名(`baseOf`)が重複する要素どうしに安定した連番を振り、
 * 一意なファイル名ベースへ変換する。`items` の並び順どおりに割り当て、最初の出現は
 * 無印、以降は `-2`, `-3`, … を付与する(例: 同名 clip が複数ある、同一 clip に
 * 同一ターゲット+フィットの Output を複数追加した場合など)。
 * `items` 全体から都度計算する純粋関数のため、呼び出しをまたいで状態を持ち越さない
 * — ExportScreen のように「同じ clip 集合に対する採番」が複数回の effect 実行に
 * またがっても、入力(clips の内容)が同じなら常に同じ名前を返す(安定)。
 * UploadScreen の一括書き出しのように 1 回のバッチで完結する場合も同様に使える。
 * 戻り値は `Map<T, string>` のため、`items` の各要素は一意な参照(clip/task
 * オブジェクトなど)である必要がある(プリミティブの重複値は Map キーとして
 * 衝突する)。
 */
export function uniqueBaseNames<T>(
	items: readonly T[],
	baseOf: (item: T) => string,
): Map<T, string> {
	const used = new Map<string, number>();
	const result = new Map<T, string>();
	for (const item of items) {
		const base = baseOf(item);
		const count = (used.get(base) ?? 0) + 1;
		used.set(base, count);
		result.set(item, count === 1 ? base : `${base}-${count}`);
	}
	return result;
}
