import type { EditSpec } from "@facet/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage } from "./getErrorMessage";
import { cancelJob, type RenderQuality, startPreview } from "./tauri";

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
 */
export function usePreview(quality?: RenderQuality): UsePreviewResult {
	const [states, setStates] = useState<Map<string, PreviewState>>(new Map());
	const statesRef = useRef(states);
	statesRef.current = states;

	// key ごとの購読解除関数。
	const unsubsRef = useRef<Map<string, () => void>>(new Map());
	// key ごとに進行中の ensure Promise(同一 key への重複呼び出しを合流させる)。
	const pendingRef = useRef<Map<string, Promise<string>>>(new Map());

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

			const promise = new Promise<string>((resolve, reject) => {
				patch(key, { rendering: true, error: undefined });
				let handle: { unsubscribe: () => void } | undefined;
				// onDone/onError が(invoke() の resolve より先に)既に発火済みかどうか。
				// tauri.ts が listen() を invoke() より先に張る(バグ2 対策)ため、起動直後に
				// 完了/失敗する短いジョブでは、後述の `.then((h) => …)` が onDone/onError より
				// 後に実行されることがある。その場合に既に確定した状態(jobId 等)で
				// 上書きしないためのガード。
				let settled = false;
				startPreview(
					input,
					spec,
					{
						onDone: (path) => {
							settled = true;
							handle?.unsubscribe();
							unsubsRef.current.delete(key);
							pendingRef.current.delete(key);
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
							unsubsRef.current.delete(key);
							pendingRef.current.delete(key);
							patch(key, { rendering: false, error: message });
							reject(new Error(message));
						},
					},
					quality,
				)
					.then((h) => {
						handle = h;
						if (settled) return;
						unsubsRef.current.set(key, h.unsubscribe);
						patch(key, { jobId: h.jobId });
					})
					.catch((err: unknown) => {
						if (settled) return;
						pendingRef.current.delete(key);
						const message = getErrorMessage(err);
						patch(key, { rendering: false, error: message });
						reject(err instanceof Error ? err : new Error(message));
					});
			});
			pendingRef.current.set(key, promise);
			return promise;
		},
		[patch, quality],
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

	/** jobId が既知ならキャンセルを試みる(失敗は握りつぶさず warn に留める。バグ1)。 */
	const cancelOrphan = useCallback((jobId: string | undefined) => {
		if (!jobId) return;
		void cancelJob(jobId).catch((err: unknown) => {
			console.warn(`ジョブのキャンセルに失敗しました(jobId=${jobId})`, err);
		});
	}, []);

	const remove = useCallback(
		(key: string) => {
			unsubsRef.current.get(key)?.();
			unsubsRef.current.delete(key);
			pendingRef.current.delete(key);
			// jobId が既に確定していれば Rust 側のジョブへキャンセルを通知する(バグ1)。
			// 未確定(invoke 未 resolve)の場合は、上記 ensure() の `.then()` が後から
			// 解決した時点で unsubsRef へ key が再登録され、その先の onDone/onError の
			// patch により states に key が「復活」しうる(ghost エントリ)。この窓では
			// cancelOrphan も空振りするため、Rust 側のジョブはそのまま完走するまで
			// 孤児として走り続ける(既知の限界。useReframeQueue.ts が持つような
			// 世代トークンでの追跡は本フックには未導入 — ExportScreen の sig 照合と
			// 合わせて別 PR で検討)。
			cancelOrphan(statesRef.current.get(key)?.jobId);
			setStates((prev) => {
				if (!prev.has(key)) return prev;
				const next = new Map(prev);
				next.delete(key);
				return next;
			});
		},
		[cancelOrphan],
	);

	const reset = useCallback(() => {
		for (const unsub of unsubsRef.current.values()) unsub();
		unsubsRef.current.clear();
		pendingRef.current.clear();
		for (const state of statesRef.current.values()) cancelOrphan(state.jobId);
		setStates(new Map());
	}, [cancelOrphan]);

	// アンマウント時に全購読を解除し、jobId が確定しているジョブはキャンセルする(バグ1)。
	useEffect(() => {
		const unsubs = unsubsRef.current;
		return () => {
			for (const unsub of unsubs.values()) unsub();
			unsubs.clear();
			for (const state of statesRef.current.values()) cancelOrphan(state.jobId);
		};
	}, [cancelOrphan]);

	return { states, ensure, trigger, cancel, remove, reset };
}
