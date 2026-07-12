import type { EditSpec } from "@facet/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { cancelJob, startPreview } from "./tauri";

/**
 * `preview_start`(低ビットレート・spec ハッシュキャッシュ、`app_data_dir/preview-cache` へ
 * 生成)による 1 プレビュー対象(clip や output)ぶんの生成状態。
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
 * `preview_start` によるプレビュー生成を key(clip.id や output.id)単位で管理する
 * 共通フック。UploadScreen の「最終プレビュー」・ExportScreen の「クロップ内容プレビュー」の
 * 双方から使う(実書き出し(`reframe_start`)は別軸で各モーダルが個別に扱う)。
 */
export function usePreview(): UsePreviewResult {
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
				startPreview(input, spec, {
					onDone: (path) => {
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
						handle?.unsubscribe();
						unsubsRef.current.delete(key);
						pendingRef.current.delete(key);
						patch(key, { rendering: false, error: message });
						reject(new Error(message));
					},
				})
					.then((h) => {
						handle = h;
						unsubsRef.current.set(key, h.unsubscribe);
						patch(key, { jobId: h.jobId });
					})
					.catch((err: unknown) => {
						pendingRef.current.delete(key);
						const message = err instanceof Error ? err.message : String(err);
						patch(key, { rendering: false, error: message });
						reject(err instanceof Error ? err : new Error(message));
					});
			});
			pendingRef.current.set(key, promise);
			return promise;
		},
		[patch],
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

	const remove = useCallback((key: string) => {
		unsubsRef.current.get(key)?.();
		unsubsRef.current.delete(key);
		pendingRef.current.delete(key);
		setStates((prev) => {
			if (!prev.has(key)) return prev;
			const next = new Map(prev);
			next.delete(key);
			return next;
		});
	}, []);

	const reset = useCallback(() => {
		for (const unsub of unsubsRef.current.values()) unsub();
		unsubsRef.current.clear();
		pendingRef.current.clear();
		setStates(new Map());
	}, []);

	// アンマウント時に全購読を解除。
	useEffect(() => {
		const unsubs = unsubsRef.current;
		return () => {
			for (const unsub of unsubs.values()) unsub();
			unsubs.clear();
		};
	}, []);

	return { states, ensure, trigger, cancel, remove, reset };
}
