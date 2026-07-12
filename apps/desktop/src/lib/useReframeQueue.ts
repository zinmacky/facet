import type { EditSpec } from "@facet/core";
import type { MutableRefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage } from "./getErrorMessage";
import type { EncoderPreference } from "./settings";
import { cancelJob, startReframe, type JobHandle } from "./tauri";

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
	 * tasks を running で初期化)。既に予約/実行中の key には何もせず `false` を返す
	 * (呼び出し側はこれで二重起動を防ぐ)。成功時は「世代トークン」を返す —
	 * 後続の `run`/`fail` 呼び出しにそのまま渡すことで、同じ key に対して後から
	 * `remove`/`reserve` が割り込んでも(バグ3: 世代管理)、この呼び出し由来の
	 * 非同期コールバックが新しいジョブの状態を誤って上書きしないようにする
	 * (`run` の JSDoc 参照)。実際のジョブ起動(`run`)より前に、非同期処理
	 * (出力パスの解決など)を挟まず同期的に呼ぶこと。
	 */
	reserve: (key: string, initial?: Partial<ReframeTaskState>) => string | false;
	/**
	 * `reserve`(または `startBatch`)が発行した `token` を渡し、対応する key に対して
	 * 実際に `reframe_start` を起動し、進捗/完了/失敗を `tasks` へ反映する。
	 * 完了で resolve、失敗(起動失敗含む)で reject する。
	 *
	 * 世代管理(バグ3): `token` が発行時点から変わっていない(= 同じ key に対して
	 * その後 `remove`/`reserve` が呼ばれていない)場合のみ `tasks`/購読を書き換える。
	 * 既に無効化されている場合は、起動済みのジョブがあれば孤児化を避けるため
	 * 即座にキャンセルし(バグ1: jobId 未確定時の remove 対応)、状態には触れずに
	 * resolve する(呼び出し側の catch 節で誤って `fail` を呼ばせないため)。
	 */
	run: (
		token: string,
		key: string,
		input: string,
		outputPath: string,
		spec: EditSpec,
		encoder?: EncoderPreference,
	) => Promise<void>;
	/**
	 * `run` 到達前の失敗(出力パス解決の失敗など)を key の状態へ反映する。
	 * `run` と同じ `token` を渡すこと(世代が既に無効なら何もしない)。
	 */
	fail: (token: string, key: string, err: unknown) => void;
	/**
	 * 指定 key の購読・状態を破棄する。jobId が既に確定していれば `reframe_cancel` を
	 * 呼び、Rust 側のジョブが孤児として走り続けないようにする(バグ1。失敗は
	 * console.warn に留め、remove 自体は同期的に完了する)。
	 */
	remove: (key: string) => void;
	/** 全 key の購読を解除し、jobId が確定しているジョブは cancelJob してから状態を空にする(バグ1)。 */
	reset: () => void;
	/**
	 * `tasks` を渡された keys だけの新しい running 状態で作り直す(UploadScreen の
	 * 「フォルダへ一括書き出し」のように、1 回の操作でバッチ全体を running から
	 * 起動し直す場合に使う)。呼び出し時点で前バッチは既に完了/失敗済みのはずだが、
	 * 万一残っていても孤児化しないよう、前バッチの購読解除・実行中ジョブの
	 * キャンセルは呼び出し側の責務にせずここで行う(バグ1)。key ごとの世代トークンを
	 * 発行して返す(`run`/`fail` に渡すこと)。
	 */
	startBatch: (
		keys: string[],
		initial?: Partial<ReframeTaskState>,
	) => Map<string, string>;
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

	// key ごとの「現在有効な」世代トークン(バグ3: 世代管理)。reserve()/startBatch() が
	// 発行し、remove()/reset() が破棄する。run()/fail() は自分に渡された token が
	// 今もこの Map の値と一致する場合のみ tasks/unsubsRef を書き換える。不一致であれば
	// 「後から reserve() し直された新しいジョブ、または remove() 済みの孤児」とみなし、
	// 状態を書き換えず購読解除(必要ならジョブのキャンセル)だけ行う。
	//
	// トークンは reserve()/startBatch() というただ 1 箇所(同期実行)でのみ発行・上書き
	// されるため、複数の run() 呼び出しが非同期に「自分が最新か」を後から claim
	// し合うような競合は起きない(発行順は JS の単一スレッド実行で一意に決まる)。
	const activeTokenRef = useRef<Map<string, string>>(new Map());
	const tokenCounterRef = useRef(0);
	const nextToken = useCallback((): string => {
		tokenCounterRef.current += 1;
		return String(tokenCounterRef.current);
	}, []);

	/** jobId が既知ならキャンセルを試みる(失敗は握りつぶさず warn に留める。バグ1)。 */
	const cancelOrphan = useCallback((jobId: string | undefined) => {
		if (!jobId) return;
		void cancelJob(jobId).catch((err: unknown) => {
			console.warn(`ジョブのキャンセルに失敗しました(jobId=${jobId})`, err);
		});
	}, []);

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
		(key: string, initial?: Partial<ReframeTaskState>): string | false => {
			if (unsubsRef.current.has(key)) return false;
			const token = nextToken();
			activeTokenRef.current.set(key, token);
			unsubsRef.current.set(key, () => {});
			update(key, { status: "running", ratio: 0, ...initial });
			return token;
		},
		[update, nextToken],
	);

	const run = useCallback(
		(
			token: string,
			key: string,
			input: string,
			outputPath: string,
			spec: EditSpec,
			encoder?: EncoderPreference,
		): Promise<void> => {
			const isCurrent = () => activeTokenRef.current.get(key) === token;
			// remove()/再 reserve() が run() 到達前に既に起きている(バグ3)。
			// ジョブを起動する意味が無いので、reframe_start すら呼ばずに終わる。
			if (!isCurrent()) return Promise.resolve();

			return new Promise<void>((resolve, reject) => {
				let handle: JobHandle | undefined;
				// このジョブ自身の onDone/onError が(invoke() の resolve より先に)
				// 既に発火済みかどうか。listen-before-invoke(バグ2 対策)により、
				// 起動直後に完了/失敗する短いジョブでは later の `.then((h) => …)` が
				// onDone/onError より後に実行されることがあるため、後着の `.then` が
				// 既に確定した状態(jobId 等)で上書きしないためのローカルなガード
				// (activeTokenRef とは別物 — こちらは「同一 run() 呼び出し内」の順序保証)。
				let settled = false;

				startReframe(
					input,
					outputPath,
					spec,
					{
						onProgress: (progress) => {
							if (settled || !isCurrent()) return;
							update(key, {
								status: "running",
								ratio: (progress.percent ?? 0) / 100,
								fps: progress.fps,
							});
						},
						onDone: () => {
							settled = true;
							handle?.unsubscribe();
							if (!isCurrent()) {
								resolve();
								return;
							}
							unsubsRef.current.delete(key);
							update(key, { status: "done", ratio: 1, outputPath });
							resolve();
						},
						onError: (message) => {
							settled = true;
							handle?.unsubscribe();
							if (!isCurrent()) {
								resolve();
								return;
							}
							unsubsRef.current.delete(key);
							update(key, { status: "error", error: message });
							reject(new Error(message));
						},
					},
					encoder,
				)
					.then((h) => {
						handle = h;
						if (settled) return;
						if (!isCurrent()) {
							// jobId が確定した時点で既に無効化されていた(バグ1: jobId 未確定時の
							// remove 対応)。孤児として走らせ続けないよう明示的にキャンセルし、
							// リスナーも解放する(キャンセルが失敗しても、終端イベントを待たず
							// ここで確実に購読を切る)。
							h.unsubscribe();
							void h.cancel().catch((err: unknown) => {
								console.warn(
									`孤児ジョブのキャンセルに失敗しました(jobId=${h.jobId})`,
									err,
								);
							});
							resolve();
							return;
						}
						unsubsRef.current.set(key, h.unsubscribe);
						update(key, { jobId: h.jobId });
					})
					.catch((err: unknown) => {
						if (settled) return;
						if (!isCurrent()) {
							resolve();
							return;
						}
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
		(token: string, key: string, err: unknown) => {
			if (activeTokenRef.current.get(key) !== token) return;
			unsubsRef.current.delete(key);
			update(key, { status: "error", error: getErrorMessage(err) });
		},
		[update],
	);

	const remove = useCallback(
		(key: string) => {
			unsubsRef.current.get(key)?.();
			unsubsRef.current.delete(key);
			activeTokenRef.current.delete(key);
			cancelOrphan(tasksRef.current.get(key)?.jobId);
			if (!tasksRef.current.has(key)) return;
			const next = new Map(tasksRef.current);
			next.delete(key);
			tasksRef.current = next;
			setTasks(next);
		},
		[cancelOrphan],
	);

	const reset = useCallback(() => {
		for (const unsub of unsubsRef.current.values()) unsub();
		unsubsRef.current.clear();
		activeTokenRef.current.clear();
		for (const task of tasksRef.current.values()) cancelOrphan(task.jobId);
		tasksRef.current = new Map();
		setTasks(new Map());
	}, [cancelOrphan]);

	const startBatch = useCallback(
		(keys: string[], initial?: Partial<ReframeTaskState>): Map<string, string> => {
			// 前バッチの購読・世代トークンを引き継がない。JSDoc の通り「呼び出し時点で
			// 前バッチは既に完了/失敗済みのはず」が前提だが、その不変条件が破れて
			// 実行中ジョブが残っていた場合に孤児化しないよう、念のため明示的に
			// 購読解除・キャンセルしてから新しいバッチを積む(バグ1と同じ理由)。
			for (const unsub of unsubsRef.current.values()) unsub();
			unsubsRef.current.clear();
			for (const task of tasksRef.current.values()) cancelOrphan(task.jobId);
			activeTokenRef.current.clear();

			const next = new Map<string, ReframeTaskState>();
			const tokens = new Map<string, string>();
			for (const key of keys) {
				next.set(key, { status: "running", ratio: 0, ...initial });
				const token = nextToken();
				tokens.set(key, token);
				activeTokenRef.current.set(key, token);
			}
			tasksRef.current = next;
			setTasks(next);
			return tokens;
		},
		[nextToken, cancelOrphan],
	);

	// アンマウント時に全購読を解除し、jobId が確定しているジョブはキャンセルする(バグ1)。
	useEffect(() => {
		const unsubs = unsubsRef.current;
		return () => {
			for (const unsub of unsubs.values()) unsub();
			unsubs.clear();
			for (const task of tasksRef.current.values()) cancelOrphan(task.jobId);
		};
	}, [cancelOrphan]);

	return { tasks, tasksRef, reserve, run, fail, remove, reset, startBatch, update };
}
