import type { EditSpec } from "@facet/core";
import type { MutableRefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage } from "./getErrorMessage";
import { startReframe } from "./tauri";

/**
 * `reframe_start`(実書き出し品質)による 1 ジョブ(clip や output)ぶんの進行状態。
 * ExportScreen の「書き出し」・UploadScreen の「フォルダへ一括書き出し」の双方から使う
 * (`usePreview` が `preview_start` を管理するのと対になる、実書き出し版)。
 */
export interface ReframeTaskState {
	status: "running" | "done" | "error";
	/** 0..1。見積り不能な区間は 0 のまま進む。 */
	ratio: number;
	fps?: number;
	outputPath?: string;
	error?: string;
	/** キャンセル/失敗の区別無く、実行中ジョブの ID(キャンセルボタン用)。 */
	jobId?: string;
	/** フォールバック等の一時通知(例: ソフトウェアエンコードで再試行中)。 */
	notice?: string;
	/**
	 * 呼び出し側が任意に付与する識別用の付加情報(ExportScreen の clipPreviewSig 等)。
	 * このフック自体はこの値の意味を解釈しない。
	 */
	sig?: string;
}

export interface UseReframeQueueResult {
	/** key(clip.id / output.id)ごとの進行状態。 */
	tasks: Map<string, ReframeTaskState>;
	/**
	 * `tasks` の同期ミラー。`reserve`/`run`/`remove`/`reset` はこの ref を呼び出し内で
	 * 同期的に更新するため、同一コミット内で後続実行される effect が最新状態を
	 * 参照できる(state の再レンダリング待ちを挟まない)。
	 */
	tasksRef: MutableRefObject<Map<string, ReframeTaskState>>;
	/**
	 * key を「実行中」として同期的に予約する(unsubsRef へプレースホルダを登録 +
	 * tasks を running で初期化)。既に予約/実行中の key には何もせず false を返す
	 * (呼び出し側はこれで二重起動を防ぐ)。実際のジョブ起動(`run`)より前に、
	 * 非同期処理(出力パスの解決など)を挟まず同期的に呼ぶこと。
	 */
	reserve: (key: string, initial?: Partial<ReframeTaskState>) => boolean;
	/**
	 * 予約済みの key に対して実際に `reframe_start` を起動し、進捗/完了/失敗を
	 * `tasks` へ反映する。完了で resolve、失敗(起動失敗含む)で reject する。
	 */
	run: (
		key: string,
		input: string,
		outputPath: string,
		spec: EditSpec,
	) => Promise<void>;
	/** `run` 到達前の失敗(出力パス解決の失敗など)を key の状態へ反映する。 */
	fail: (key: string, err: unknown) => void;
	/** 指定 key の購読・状態を破棄する。 */
	remove: (key: string) => void;
	/** 全 key の購読を解除して状態を空にする。 */
	reset: () => void;
	/**
	 * `tasks` を渡された keys だけの新しい running 状態で作り直す(UploadScreen の
	 * 「フォルダへ一括書き出し」のように、1 回の操作でバッチ全体を running から
	 * 起動し直す場合に使う。既存の購読は明示的には解除しない — 呼び出し時点で
	 * 前バッチは既に完了/失敗済みのはず)。
	 */
	startBatch: (keys: string[], initial?: Partial<ReframeTaskState>) => void;
	/** 状態を部分更新する(通常は `reserve`/`run`/`fail`/`remove` 経由で十分だが、上位から直接使うこともできる)。 */
	update: (key: string, patch: Partial<ReframeTaskState>) => void;
}

/**
 * `reframe_start` によるレンダリングジョブを key(clip.id や output.id)単位で管理する
 * 共通フック。ExportScreen の「書き出し」(常時マウントの effect から継続的に起動)・
 * UploadScreen の「フォルダへ一括書き出し」(ユーザー操作 1 回で一括起動)の双方が、
 * 起動タイミング・二重起動防止の判定は個別に持ちつつ、「ジョブを起動し progress/done/
 * error を Map と購読解除関数(unsubsRef)へ反映する」部分だけをここへ集約する。
 */
export function useReframeQueue(): UseReframeQueueResult {
	const [tasks, setTasks] = useState<Map<string, ReframeTaskState>>(new Map());
	const tasksRef = useRef<Map<string, ReframeTaskState>>(tasks);

	// key ごとの購読解除関数。値が存在する = 予約済み or 実行中。
	const unsubsRef = useRef<Map<string, () => void>>(new Map());

	// tasksRef を都度同期更新してから setTasks へ渡す(関数更新子は開発時の StrictMode で
	// 二重呼び出しされうるため、ref 更新のような副作用はその中に置かず、ここで確定した
	// 値をそのまま渡す — usePreview.ts と同じ方針)。
	const update = useCallback((key: string, patch: Partial<ReframeTaskState>) => {
		const cur = tasksRef.current.get(key) ?? { status: "running" as const, ratio: 0 };
		const next = new Map(tasksRef.current);
		next.set(key, { ...cur, ...patch });
		tasksRef.current = next;
		setTasks(next);
	}, []);

	const reserve = useCallback(
		(key: string, initial?: Partial<ReframeTaskState>): boolean => {
			if (unsubsRef.current.has(key)) return false;
			unsubsRef.current.set(key, () => {});
			update(key, { status: "running", ratio: 0, ...initial });
			return true;
		},
		[update],
	);

	const run = useCallback(
		(
			key: string,
			input: string,
			outputPath: string,
			spec: EditSpec,
		): Promise<void> => {
			return new Promise<void>((resolve, reject) => {
				let handle: { unsubscribe: () => void } | undefined;
				startReframe(input, outputPath, spec, {
					onProgress: (progress) => {
						update(key, {
							status: "running",
							ratio: (progress.percent ?? 0) / 100,
							fps: progress.fps,
						});
					},
					onDone: () => {
						handle?.unsubscribe();
						unsubsRef.current.delete(key);
						update(key, { status: "done", ratio: 1, outputPath });
						resolve();
					},
					onError: (message) => {
						handle?.unsubscribe();
						unsubsRef.current.delete(key);
						update(key, { status: "error", error: message });
						reject(new Error(message));
					},
				})
					.then((h) => {
						handle = h;
						unsubsRef.current.set(key, h.unsubscribe);
						update(key, { jobId: h.jobId });
					})
					.catch((err: unknown) => {
						unsubsRef.current.delete(key);
						const message = getErrorMessage(err);
						update(key, { status: "error", error: message });
						reject(err instanceof Error ? err : new Error(message));
					});
			});
		},
		[update],
	);

	const fail = useCallback(
		(key: string, err: unknown) => {
			unsubsRef.current.delete(key);
			update(key, { status: "error", error: getErrorMessage(err) });
		},
		[update],
	);

	const remove = useCallback((key: string) => {
		unsubsRef.current.get(key)?.();
		unsubsRef.current.delete(key);
		if (!tasksRef.current.has(key)) return;
		const next = new Map(tasksRef.current);
		next.delete(key);
		tasksRef.current = next;
		setTasks(next);
	}, []);

	const reset = useCallback(() => {
		for (const unsub of unsubsRef.current.values()) unsub();
		unsubsRef.current.clear();
		tasksRef.current = new Map();
		setTasks(new Map());
	}, []);

	const startBatch = useCallback(
		(keys: string[], initial?: Partial<ReframeTaskState>) => {
			const next = new Map<string, ReframeTaskState>();
			for (const key of keys) next.set(key, { status: "running", ratio: 0, ...initial });
			tasksRef.current = next;
			setTasks(next);
		},
		[],
	);

	// アンマウント時に全購読を解除。
	useEffect(() => {
		const unsubs = unsubsRef.current;
		return () => {
			for (const unsub of unsubs.values()) unsub();
			unsubs.clear();
		};
	}, []);

	return { tasks, tasksRef, reserve, run, fail, remove, reset, startBatch, update };
}
