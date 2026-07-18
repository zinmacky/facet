import type { EditSpec } from "@facet/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage } from "./getErrorMessage";
import { cancelOrphanHandle, useKeyedJobLifecycle } from "./tauriJobLifecycle";
import { cancelJob, type JobHandle, type RenderQuality, startPreview } from "./tauri";

/**
 * `preview_start`(spec ハッシュキャッシュ。既定は低ビットレートで
 * `app_data_dir/preview-cache` へ、`quality: "publish"` では本書き出し品質で
 * `app_data_dir/publish-cache` へ生成)による 1 レンダリング対象(clip や output)
 * ぶんの生成状態。
 * ダウンロード/保存 UI は持たない(結果はアプリキャッシュ内ファイルの絶対パスを返すのみ)。
 */
export interface PreviewState {
	rendering: boolean;
	/** 生成済み(またはキャッシュヒット)プレビューファイルの絶対パス。 */
	outputPath?: string;
	/** 生成時の設定シグネチャ。現在値と異なれば要更新(stale)。 */
	sig?: string;
	error?: string;
	/** キャンセルボタン用(実行中ジョブの ID)。 */
	jobId?: string;
}

export interface UsePreviewResult {
	/** key(clip.id / output.id)ごとのプレビュー生成状態。 */
	states: Map<string, PreviewState>;
	/**
	 * 現在の `sig` で生成済み(かつ生成中でない)ならそのパスを再利用し、
	 * 無い/古い場合のみ `preview_start` で再生成する。
	 */
	ensure: (
		key: string,
		input: string,
		spec: EditSpec,
		sig: string,
	) => Promise<string>;
	/** `ensure` の fire-and-forget ラッパ。エラーは states 側に反映されるだけで無視する。 */
	trigger: (key: string, input: string, spec: EditSpec, sig: string) => void;
	/** 実行中のプレビュージョブをキャンセルする。 */
	cancel: (key: string) => void;
	/** 指定 key の状態・購読を破棄する(Output/Post 削除時など)。 */
	remove: (key: string) => void;
	/** 全 key の状態・購読を破棄する(モーダルを閉じたときなど)。 */
	reset: () => void;
}

/**
 * `preview_start` によるキャッシュ付きレンダリングを key(clip.id や output.id)単位で
 * 管理する共通フック。UploadScreen の「最終プレビュー」・ExportScreen の
 * 「クロップ内容プレビュー」の双方から使う(実書き出し(`reframe_start`)は別軸で
 * 各モーダルが個別に扱う)。
 *
 * `quality` を省略するとプレビュー品質(2Mbps)。`"publish"` を渡すとフック
 * インスタンス全体が本書き出し品質(8Mbps・`publish-cache`)で動く
 * (UploadScreen の投稿フローが使う。`lib/tauri.ts` の `RenderQuality` 参照)。
 *
 * ライフサイクル不変条件(listen-before-invoke / 世代トークン / remove 時 cancel /
 * アンマウント時 unsubscribe+cancel / stale ハンドル到着時の即時 cancel、Issue #95。
 * GHSA-c4jj-6rmf-h7g3 対応)は `./tauriJobLifecycle.ts` の `useKeyedJobLifecycle` に
 * 集約されている(`useReframeQueue.ts` も同じ土台を使う)。このフックは `states` Map
 * (生成状態)の所有・`ensure()` 1回で reserve+run を兼ねる入口・`pendingRef` による
 * 同一 key への重複呼び出しの合流に専念する。
 */
export function usePreview(quality?: RenderQuality): UsePreviewResult {
	const [states, setStates] = useState<Map<string, PreviewState>>(new Map());
	const statesRef = useRef(states);
	statesRef.current = states;

	// key ごとに進行中の ensure Promise(同一 key への重複呼び出しを合流させる)。
	const pendingRef = useRef<Map<string, Promise<string>>>(new Map());

	const lifecycle = useKeyedJobLifecycle();

	const patch = useCallback((key: string, p: Partial<PreviewState>) => {
		setStates((prev) => {
			const next = new Map(prev);
			const cur = next.get(key) ?? { rendering: false };
			next.set(key, { ...cur, ...p });
			return next;
		});
	}, []);

	const ensure = useCallback(
		(key: string, input: string, spec: EditSpec, sig: string): Promise<string> => {
			const cached = statesRef.current.get(key);
			if (cached?.outputPath && cached.sig === sig && !cached.rendering) {
				return Promise.resolve(cached.outputPath);
			}
			// 進行中の ensure() があれば無条件に合流する。以前は `cached?.rendering` も
			// 条件に含めていたが、cached は state の ref ミラーで render commit 後にしか
			// 更新されないため、同一 tick 内で連続 ensure() すると 1 回目の rendering:true
			// がまだ cached へ反映されておらず合流に失敗し、pending 中にもかかわらず
			// preview_start が二重発火する P1 バグがあった(usePreview.ensure の重複ガード
			// 競合)。pendingRef は setState と異なり同期的に更新されるため、これだけを
			// 条件にすれば tick を跨がず確実に合流する。
			const pending = pendingRef.current.get(key);
			if (pending) return pending;

			// この ensure() 呼び出し由来の世代トークン(同期発行。GHSA-c4jj-6rmf-h7g3
			// 対応)。以降の非同期コールバックはこのクロージャで捕まえた `token` が
			// 現在世代と一致する間だけ「自分が最新」とみなす(`isCurrent` 参照)。
			const token = lifecycle.reserve(key);
			const isCurrent = () => lifecycle.isCurrent(key, token);

			const promise = new Promise<string>((resolve, reject) => {
				patch(key, { rendering: true, error: undefined });
				let handle: JobHandle | undefined;
				// onDone/onError が(invoke() の resolve より先に)既に発火済みかどうか。
				// tauri.ts が listen() を invoke() より先に張る(バグ2 対策)ため、起動直後に
				// 完了/失敗する短いジョブでは、後述の `.then((h) => …)` が onDone/onError より
				// 後に実行されることがある。その場合に既に確定した状態(jobId 等)で
				// 上書きしないためのガード(isCurrent とは別物 — こちらは「同一 ensure()
				// 呼び出し内」の順序保証)。
				let settled = false;
				startPreview(
					input,
					spec,
					{
						onDone: (path) => {
							settled = true;
							handle?.unsubscribe();
							if (!isCurrent()) {
								// remove() 済み(または再 ensure() で世代が進んでいる)。この世代の
								// 状態は書き換えず、生成自体は成功しているので値はそのまま返す。
								// pendingRef は削除しない — 既に remove() が削除済みか、後続の
								// ensure() (新世代)が自分の Promise で上書き済みのはずで、ここで
								// 無条件に delete すると新世代の pendingRef を誤って消してしまう。
								resolve(path);
								return;
							}
							pendingRef.current.delete(key);
							lifecycle.clearUnsubscribe(key);
							patch(key, {
								rendering: false,
								outputPath: path,
								sig,
								error: undefined,
							});
							resolve(path);
						},
						onError: (message) => {
							settled = true;
							handle?.unsubscribe();
							if (!isCurrent()) {
								reject(new Error(message));
								return;
							}
							pendingRef.current.delete(key);
							lifecycle.clearUnsubscribe(key);
							patch(key, { rendering: false, error: message });
							reject(new Error(message));
						},
					},
					quality,
				)
					.then((h) => {
						handle = h;
						if (settled) return;
						if (!isCurrent()) {
							// jobId が確定した時点で既に remove() 済みだった(バグ1: jobId 未確定時の
							// remove 対応)。孤児として走らせ続けないよう明示的にキャンセルし、
							// リスナーも解放する(以降 onDone/onError は発火しないため、ここで
							// ensure() の Promise を確定させる)。
							cancelOrphanHandle(h);
							reject(new Error("プレビュー生成が中断されました(remove 済み)"));
							return;
						}
						lifecycle.setUnsubscribe(key, h.unsubscribe);
						patch(key, { jobId: h.jobId });
					})
					.catch((err: unknown) => {
						if (settled) return;
						const message = getErrorMessage(err);
						if (!isCurrent()) {
							reject(err instanceof Error ? err : new Error(message));
							return;
						}
						pendingRef.current.delete(key);
						patch(key, { rendering: false, error: message });
						reject(err instanceof Error ? err : new Error(message));
					});
			});
			pendingRef.current.set(key, promise);
			return promise;
		},
		[patch, quality, lifecycle],
	);

	const trigger = useCallback(
		(key: string, input: string, spec: EditSpec, sig: string) => {
			void ensure(key, input, spec, sig).catch(() => undefined);
		},
		[ensure],
	);

	const cancel = useCallback((key: string) => {
		const jobId = statesRef.current.get(key)?.jobId;
		if (jobId) void cancelJob(jobId);
	}, []);

	const remove = useCallback(
		(key: string) => {
			pendingRef.current.delete(key);
			// key の世代トークンを破棄する(GHSA-c4jj-6rmf-h7g3 対応)。jobId 未確定
			// (invoke 未 resolve)の窓で remove() が呼ばれても、ensure() の `.then()`/
			// onDone/onError は isCurrent() が false になるため、states/購読への
			// 再登録(ghost エントリの復活)が起きず、jobId 判明時点で明示的に
			// unsubscribe + cancel される。jobId が既に確定していれば Rust 側の
			// ジョブへキャンセルを通知する(バグ1)。
			void lifecycle.remove(key, statesRef.current.get(key)?.jobId);
			setStates((prev) => {
				if (!prev.has(key)) return prev;
				const next = new Map(prev);
				next.delete(key);
				return next;
			});
		},
		[lifecycle],
	);

	const reset = useCallback(() => {
		pendingRef.current.clear();
		lifecycle.resetAll([...statesRef.current.values()].map((state) => state.jobId));
		setStates(new Map());
	}, [lifecycle]);

	// アンマウント時に全購読を解除し、jobId が確定しているジョブはキャンセルする(バグ1)。
	useEffect(() => {
		return () => {
			lifecycle.resetAll([...statesRef.current.values()].map((state) => state.jobId));
		};
	}, [lifecycle]);

	return { states, ensure, trigger, cancel, remove, reset };
}
