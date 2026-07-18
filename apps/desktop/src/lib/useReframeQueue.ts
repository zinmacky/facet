import type { EditSpec } from "@facet/core";
import type { MutableRefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage } from "./getErrorMessage";
import type { EncoderPreference } from "./settings";
import { cancelOrphanHandle, useKeyedJobLifecycle } from "./tauriJobLifecycle";
import { startReframe, type JobHandle } from "./tauri";

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
	 * key を「実行中」として同期的に予約する(世代トークンの発行 + tasks を running で
	 * 初期化)。既に予約/実行中の key には何もせず `false` を返す(呼び出し側はこれで
	 * 二重起動を防ぐ)。成功時は「世代トークン」を返す — 後続の `run`/`fail` 呼び出しに
	 * そのまま渡すことで、同じ key に対して後から `remove`/`reserve` が割り込んでも
	 * (バグ3: 世代管理)、この呼び出し由来の非同期コールバックが新しいジョブの状態を
	 * 誤って上書きしないようにする(世代トークンの設計は `tauriJobLifecycle.ts` の
	 * `useKeyedJobLifecycle` 参照)。実際のジョブ起動(`run`)より前に、非同期処理
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
	 * console.warn に留める)。`tasks`/購読の破棄自体は同期的に完了するが、戻り値の
	 * Promise は Rust 側キャンセル(`reframe_cancel`)が完了する(または jobId 未確定で
	 * キャンセル不要と判明する)まで待つための補助 — 呼び出し側は「同じ key へ即座に
	 * 再 reserve() しても安全か」を厳密に知りたい場合(例: ExportScreen の再書き出し
	 * ボタンを、旧ジョブが実際に止まるまで disabled にする)にこの Promise を使う。
	 * 待たずに `void remove(key)` する既存の使い方もそのまま動く。
	 */
	remove: (key: string) => Promise<void>;
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
 * error を Map へ反映する」部分だけをここへ集約する。
 *
 * ライフサイクル不変条件(listen-before-invoke / 世代トークン / remove 時 cancel /
 * アンマウント時 unsubscribe+cancel / stale ハンドル到着時の即時 cancel、Issue #95)は
 * `./tauriJobLifecycle.ts` の `useKeyedJobLifecycle` に集約されている(`usePreview.ts`
 * も同じ土台を使う)。このフックは `tasks` Map(進行状態)の所有・`reserve`/`run`/
 * `startBatch` という3種の起動入口の使い分けに専念する。
 */
export function useReframeQueue(): UseReframeQueueResult {
	const [tasks, setTasks] = useState<Map<string, ReframeTaskState>>(new Map());
	const tasksRef = useRef<Map<string, ReframeTaskState>>(tasks);

	const lifecycle = useKeyedJobLifecycle();

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
			if (lifecycle.isActive(key)) return false;
			const token = lifecycle.reserve(key);
			update(key, { status: "running", ratio: 0, ...initial });
			return token;
		},
		[update, lifecycle],
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
			const isCurrent = () => lifecycle.isCurrent(key, token);
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
				// (isCurrent とは別物 — こちらは「同一 run() 呼び出し内」の順序保証)。
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
							lifecycle.clearUnsubscribe(key);
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
							lifecycle.clearUnsubscribe(key);
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
							cancelOrphanHandle(h);
							resolve();
							return;
						}
						lifecycle.setUnsubscribe(key, h.unsubscribe);
						update(key, { jobId: h.jobId });
					})
					.catch((err: unknown) => {
						if (settled) return;
						if (!isCurrent()) {
							resolve();
							return;
						}
						lifecycle.clearUnsubscribe(key);
						const message = getErrorMessage(err);
						update(key, { status: "error", error: message });
						reject(err instanceof Error ? err : new Error(message));
					});
			});
		},
		[update, lifecycle],
	);

	const fail = useCallback(
		(token: string, key: string, err: unknown) => {
			if (!lifecycle.isCurrent(key, token)) return;
			lifecycle.clearUnsubscribe(key);
			update(key, { status: "error", error: getErrorMessage(err) });
		},
		[update, lifecycle],
	);

	const remove = useCallback(
		(key: string): Promise<void> => {
			const cancelled = lifecycle.remove(key, tasksRef.current.get(key)?.jobId);
			if (!tasksRef.current.has(key)) return cancelled;
			const next = new Map(tasksRef.current);
			next.delete(key);
			tasksRef.current = next;
			setTasks(next);
			return cancelled;
		},
		[lifecycle],
	);

	const reset = useCallback(() => {
		lifecycle.resetAll([...tasksRef.current.values()].map((task) => task.jobId));
		tasksRef.current = new Map();
		setTasks(new Map());
	}, [lifecycle]);

	const startBatch = useCallback(
		(keys: string[], initial?: Partial<ReframeTaskState>): Map<string, string> => {
			// 前バッチの購読・世代トークンを引き継がない。JSDoc の通り「呼び出し時点で
			// 前バッチは既に完了/失敗済みのはず」が前提だが、その不変条件が破れて
			// 実行中ジョブが残っていた場合に孤児化しないよう、念のため明示的に
			// 購読解除・キャンセルしてから新しいバッチを積む(バグ1と同じ理由)。
			lifecycle.resetAll([...tasksRef.current.values()].map((task) => task.jobId));

			const next = new Map<string, ReframeTaskState>();
			const tokens = new Map<string, string>();
			for (const key of keys) {
				next.set(key, { status: "running", ratio: 0, ...initial });
				// lifecycle.reserve() は unsubsRef へも no-op プレースホルダを登録するため、
				// 呼び出し直後は isActive(key) が true になる(reserve() 単体と同じ挙動)。
				// startBatch はここで発行したトークンをそのまま呼び出し側の run() へ渡す
				// 前提で isActive() を参照しないため、無害。
				tokens.set(key, lifecycle.reserve(key));
			}
			tasksRef.current = next;
			setTasks(next);
			return tokens;
		},
		[lifecycle],
	);

	// アンマウント時に全購読を解除し、jobId が確定しているジョブはキャンセルする(バグ1)。
	useEffect(() => {
		return () => {
			lifecycle.resetAll([...tasksRef.current.values()].map((task) => task.jobId));
		};
	}, [lifecycle]);

	return { tasks, tasksRef, reserve, run, fail, remove, reset, startBatch, update };
}
