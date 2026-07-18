import { useCallback, useMemo, useRef } from "react";
import { cancelJob } from "./tauri";

/**
 * `startReframe`/`startPreview`/`startIgPublish`/`startYoutubePublish`(いずれも
 * `lib/tauri.ts`・`features/upload/igPublish.ts`・`features/upload/youtubePublish.ts`)
 * が共通して返すハンドル形状。`lib/tauri.ts` の `JobHandle` と構造的に同じ。
 */
export interface JobHandleLike {
	jobId: string;
	unsubscribe: () => void;
	cancel: () => Promise<void>;
}

/**
 * Tauri 非同期ジョブ(reframe_start/preview_start/ig_publish_start/
 * youtube_publish_start)を購読し、アンマウント/削除時に確実に停止するための
 * ライフサイクル不変条件を1箇所へ集約するモジュール(Issue #95 提案1)。
 *
 * `useReframeQueue`(世代トークンの原型)・`usePreview`(#111 で世代トークンを移植)・
 * `usePublishExtras`(#111 で in-flight ハンドル追跡を追加)の3実装に同じパターンが
 * 個別にコピーされていたものを、以下2系統のプリミティブへ畳む:
 *
 * 1. key(clip.id/output.id)単位でジョブを起動する `useReframeQueue`/`usePreview` 向け:
 *    世代トークン + 購読解除レジストリ({@link useKeyedJobLifecycle})。
 * 2. output.id 単位で単発の投稿ジョブを起動する `usePublishExtras` 向け:
 *    handle(jobId/unsubscribe/cancel)そのものを Map で追跡する薄いヘルパ
 *    ({@link detachHandle}/{@link detachJobHandle}/{@link detachAllJobHandles})。
 *
 * 両者を無理に同一フック形状へ統合すると、「reserve→run の2段階」(useReframeQueue)・
 * 「ensure 1回で reserve+run を兼ねる」(usePreview)・「世代トークンではなく
 * mountedRef+knownOutputIdsRef で有効性を判定する複数ステップの投稿フロー」
 * (usePublishExtras)という3者の入口の形の違いを覆い隠して可読性を損なうため、
 * 「不変条件のコア + 薄い2形状」の構成にしている。
 */

// ---- jobId ベースの孤児ジョブキャンセル(useReframeQueue.ts / usePreview.ts) --------

/**
 * jobId が既知ならキャンセルを試みる(失敗は握りつぶさず console.warn に留める。バグ1)。
 * 戻り値の Promise は常に resolve する(失敗時も warn 後に resolve — 呼び出し側が
 * `.catch` を書かずに待てるようにする)。jobId 未確定(＝まだキャンセルすべきジョブが
 * 無い)場合は即 resolve 済みの Promise を返す。`KeyedJobLifecycle` の `remove`/`resetAll`
 * (ユーザー操作/アンマウントによる明示的な破棄)から使う。
 */
export function cancelOrphanJob(jobId: string | undefined): Promise<void> {
	if (!jobId) return Promise.resolve();
	return cancelJob(jobId).catch((err: unknown) => {
		console.warn(`ジョブのキャンセルに失敗しました(jobId=${jobId})`, err);
	});
}

/**
 * jobId 確定時点(`startXxx()` の `.then((h) => …)`)で既に世代/対象が無効化されていた
 * handle を孤児化させないよう、購読解除 + キャンセルする(バグ1: jobId 未確定時の
 * remove 対応)。失敗は握りつぶさず console.warn に留める。
 */
export function cancelOrphanHandle(handle: JobHandleLike): void {
	handle.unsubscribe();
	void handle.cancel().catch((err: unknown) => {
		console.warn(`孤児ジョブのキャンセルに失敗しました(jobId=${handle.jobId})`, err);
	});
}

// ---- handle ベースの購読解除(usePublishExtras.tsx) ---------------------------
//
// usePublishExtras は key(output.id)ごとに handle そのものを Map(inFlightRef)へ
// 保持する(useReframeQueue/usePreview のように jobId を別の state へ保存し
// unsubsRef と2箇所に分けて管理する形ではない)。キャンセル失敗を warn せず握りつぶす
// のは既存の意図的な挙動(投稿中のキャンセルはユーザー操作/アンマウントで頻発しうるため)
// で、cancelOrphanHandle とはあえて挙動を揃えていない。

/** handle を購読解除 + キャンセルする(失敗は握りつぶす。GHSA-rrgf-h689-w639 対応)。 */
export function detachHandle(handle: JobHandleLike): void {
	handle.unsubscribe();
	void handle.cancel().catch(() => undefined);
}

/** `handles` から `key` の handle を取り除きつつ、あれば `detachHandle` する。 */
export function detachJobHandle(
	handles: Map<string, JobHandleLike>,
	key: string,
): void {
	const handle = handles.get(key);
	if (!handle) return;
	detachHandle(handle);
	handles.delete(key);
}

/** `handles` の全 handle を `detachHandle` してから Map を空にする。 */
export function detachAllJobHandles(handles: Map<string, JobHandleLike>): void {
	for (const handle of handles.values()) detachHandle(handle);
	handles.clear();
}

// ---- key 単位の世代トークン + 購読解除レジストリ(useReframeQueue.ts / usePreview.ts) ----

export interface KeyedJobLifecycle {
	/** key が既に予約/実行中か(useReframeQueue.reserve の二重起動防止に使う)。 */
	isActive: (key: string) => boolean;
	/**
	 * key を新しい世代として予約する: 世代トークンを発行し(以前の世代は自動的に
	 * 無効化される)、購読解除のプレースホルダ(no-op)を登録して返す。実際のジョブ
	 * 起動(listen-before-invoke)より前に、非同期処理を挟まず同期的に呼ぶこと。
	 */
	reserve: (key: string) => string;
	/**
	 * `token` が key の「現在有効な」世代と一致するか。不一致であれば、後から
	 * `remove()`/再 `reserve()` が割り込んだ(または既に破棄済みの)孤児とみなし、
	 * 状態を書き換えないこと(呼び出し側の判断)。
	 */
	isCurrent: (key: string, token: string) => boolean;
	/** jobId 確定後、key の購読解除関数を差し替える(`reserve()` の no-op から更新)。 */
	setUnsubscribe: (key: string, unsubscribe: () => void) => void;
	/**
	 * key の購読解除登録のみを取り除く(呼び出しはしない)。ジョブ自身の終端イベント
	 * (done/error)で既に購読解除済み・以後キャンセル不要になった場合に使う。
	 */
	clearUnsubscribe: (key: string) => void;
	/**
	 * key の購読解除 + 世代の破棄を行い、`jobId` があれば `cancelOrphanJob` する。
	 * 戻り値の Promise は cancelOrphanJob の完了を待つ補助 — 呼び出し側が「同じ key へ
	 * 即座に再 reserve() しても安全か」を厳密に知りたい場合に使う(待たずに
	 * `void remove(...)` する使い方もそのまま動く)。
	 */
	remove: (key: string, jobId: string | undefined) => Promise<void>;
	/**
	 * 全 key の購読解除 + 世代の破棄を行い、`jobIds` に渡された全 jobId を
	 * `cancelOrphanJob` する。`reset()`(モーダルを閉じる等)・アンマウント時の
	 * クリーンアップの双方から使う — このレジストリ自身は「key の全体集合」を
	 * 保持しない(呼び出し側の tasks/states が正)ため、対象の jobId 群は呼び出し側が
	 * 都度渡す。
	 */
	resetAll: (jobIds: Iterable<string | undefined>) => void;
}

/**
 * `reframe_start`/`preview_start` のように「key(clip.id/output.id)ごとにジョブを
 * 起動し、進捗/完了/失敗を反映する」フックが共通して必要とするライフサイクル不変
 * 条件(listen-before-invoke / 世代トークン / remove 時 cancel / アンマウント時
 * unsubscribe+cancel / stale ハンドル到着時の即時 cancel、Issue #95)を1箇所へ
 * 集約する。`useReframeQueue`・`usePreview` の双方が本フックを土台にする。
 *
 * 世代トークンの設計(バグ3: 世代管理): トークンは `reserve()` というただ1箇所
 * (同期実行)でのみ発行・上書きされるため、複数の非同期コールバックが「自分が最新か」
 * を後から claim し合うような競合は起きない(発行順は JS の単一スレッド実行で一意に
 * 決まる)。
 *
 * このフック自身は `tasks`/`states` のような「key ごとの進行状態」は持たない
 * (useReframeQueue はコミット内で同期参照できる ref ミラーを使い、usePreview は
 * ensure() の重複合流のため素の functional setState を使う、と要件が異なるため)。
 * 呼び出し側が自前の状態 Map を持ち、`remove`/`resetAll` へ jobId を渡す形で協調する。
 */
export function useKeyedJobLifecycle(): KeyedJobLifecycle {
	// key ごとの購読解除関数。値が存在する = 予約済み or 実行中。
	const unsubsRef = useRef<Map<string, () => void>>(new Map());
	// key ごとの「現在有効な」世代トークン。reserve() が発行し、remove()/resetAll() が破棄する。
	const activeTokenRef = useRef<Map<string, string>>(new Map());
	const tokenCounterRef = useRef(0);

	const isActive = useCallback((key: string) => unsubsRef.current.has(key), []);

	const reserve = useCallback((key: string): string => {
		tokenCounterRef.current += 1;
		const token = String(tokenCounterRef.current);
		activeTokenRef.current.set(key, token);
		unsubsRef.current.set(key, () => {});
		return token;
	}, []);

	const isCurrent = useCallback(
		(key: string, token: string) => activeTokenRef.current.get(key) === token,
		[],
	);

	const setUnsubscribe = useCallback((key: string, unsubscribe: () => void) => {
		unsubsRef.current.set(key, unsubscribe);
	}, []);

	const clearUnsubscribe = useCallback((key: string) => {
		unsubsRef.current.delete(key);
	}, []);

	const remove = useCallback(
		(key: string, jobId: string | undefined): Promise<void> => {
			unsubsRef.current.get(key)?.();
			unsubsRef.current.delete(key);
			activeTokenRef.current.delete(key);
			return cancelOrphanJob(jobId);
		},
		[],
	);

	const resetAll = useCallback((jobIds: Iterable<string | undefined>) => {
		for (const unsub of unsubsRef.current.values()) unsub();
		unsubsRef.current.clear();
		activeTokenRef.current.clear();
		for (const jobId of jobIds) cancelOrphanJob(jobId);
	}, []);

	// 返すオブジェクト自体の参照を安定させる(各フィールドは deps: [] の useCallback で
	// 既に安定しているため、useMemo の再計算は初回のみ)。呼び出し側(useReframeQueue/
	// usePreview)がこのオブジェクトを useCallback/useEffect の依存配列に含めるため、
	// 参照が毎レンダー変わるとアンマウント専用の effect が再実行され続けてしまう。
	return useMemo(
		() => ({
			isActive,
			reserve,
			isCurrent,
			setUnsubscribe,
			clearUnsubscribe,
			remove,
			resetAll,
		}),
		[isActive, reserve, isCurrent, setUnsubscribe, clearUnsubscribe, remove, resetAll],
	);
}
