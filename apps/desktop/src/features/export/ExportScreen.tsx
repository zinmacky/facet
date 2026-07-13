import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { join } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { useMutation } from "@tanstack/react-query";
import type { Source } from "../../App";
import type { Clip } from "../../types";
import { masterSpec } from "../../types";
import { pickExportDirectory, sanitizeFileName } from "../../lib/tauri";
import { useSettings } from "../../lib/settings";
import { notifyExportComplete } from "../../lib/notification";
import { usePreview } from "../../lib/usePreview";
import { useReframeQueue } from "../../lib/useReframeQueue";
import { usePauseVideosOnHide } from "../../lib/usePauseVideosOnHide";
import { getErrorMessage } from "../../lib/getErrorMessage";
import { clipPreviewSig } from "../../lib/clipSig";
import { uniqueBaseNames } from "../../lib/uniqueBaseName";
import { Button } from "../../components/ui/Button";
import type { ExportSummary } from "../wizard/StepIndicator";
import { ExportListItem } from "./ExportListItem";
import { ExportPreviewListItem } from "./ExportPreviewListItem";
import { ExportPreviewDetail } from "./ExportPreviewDetail";
import { ExportDetail } from "./ExportDetail";

interface ExportScreenProps {
	/** true のとき現在表示中の画面(ウィザードのアクティブステップ)。 */
	active: boolean;
	/** App.tsx の Source から videoSrc(元動画プレビュー用 URL)を除いたもの。書き出しでは使わない。 */
	source: Omit<Source, "videoSrc"> | null;
	clips: Clip[];
	/**
	 * 増加するたびに全状態を明示的に破棄する(新しい元動画を選択したときのみ App
	 * から増分される)。通常の clip 編集(トリム/クロップ/アスペクト変更)では
	 * 増分されない — その場合は clip 単位の細粒度無効化(下記 sig 比較)で足りる。
	 */
	resetToken: number;
	onGoToEdit: () => void;
	/**
	 * "アップロードへ進む" の遷移先。public 版(投稿ステップ自体を持たない2 step
	 * ウィザード)では App.tsx が渡さない — undefined のときボタン自体を出さない。
	 */
	onGoToUpload?: () => void;
	/** results から導出した進捗サマリを App(StepIndicator バッジ)へ押し上げる。 */
	onProgressSummary?: (summary: ExportSummary) => void;
}

/**
 * 書き出し画面: 各 clip のマスター(クロップ内容そのもの)を書き出す。
 * ウィザードの一部として常時マウントされる(active=false のときも DOM に存在し、
 * ジョブ購読は継続する)。active でソースがあり、まだ done でない clip を
 * レンダリング開始する。clip の trim/crop/aspect が変わった場合はその clip の
 * 結果のみを個別に無効化し、他 clip の結果はそのまま保持する。
 */
export function ExportScreen({
	active,
	source,
	clips,
	resetToken,
	onGoToEdit,
	onGoToUpload,
	onProgressSummary,
}: ExportScreenProps) {
	// clip 単位の書き出し進捗・結果。「reframe_start 起動 + progress/done/error を Map と
	// 購読解除関数に反映」する部分は UploadScreen の一括書き出しと共通のため
	// `useReframeQueue` に集約している(queue.tasksRef が旧 resultsRef 相当の同期ミラー)。
	const queue = useReframeQueue();
	const { settings, updateSettings } = useSettings();

	// 明示的に「書き出しを開始」するまでレンダリングを始めない(切替直後に
	// 全 clip のレンダリングを走らせて CPU を占有しないため)。
	const [started, setStarted] = useState(false);
	// 書き出し先フォルダの選択中(ダイアログ表示中)フラグ。
	const [pickingDir, setPickingDir] = useState(false);

	// マスター/詳細レイアウトの選択中 clip。
	const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

	// ユーザーが選んだ書き出し先フォルダ(絶対パス)。「書き出しを開始」時に選ばせる。
	const outputDirRef = useRef<string | null>(null);

	// 「要再書き出し」clip の集合(sig 不一致で結果が破棄されたが、まだユーザーが
	// 再書き出しボタンを押していない状態)。自動再書き出しを廃止した代わりに、
	// この状態を明示表示し、ユーザー操作(runClip)でのみ解消する。
	const [dirtyClipIds, setDirtyClipIds] = useState<Set<string>>(new Set());
	// 旧ジョブの reframe_cancel が完了するまでの間、その clip の(再)実行ボタンを
	// disabled にするための集合(同じ出力パスへ旧ジョブと新ジョブが同時に書き込む
	// 競合を避けるため)。queue.remove() が返す Promise の解決で解除する。
	//
	// state(表示用)に加えて ref も同期して持つ: requestExport の
	// 「remove() の Promise 解決 → runClip()」という連続処理は同一 tick 内(次の
	// re-render を待たずに)行うため、runClip 側のガードが state の stale closure
	// (setCancellingClipIds 直後、再レンダリング前の古い Set)を掴まないよう、
	// 常に最新の ref を読ませる(useReframeQueue の tasksRef と同じ理由)。
	const [cancellingClipIds, setCancellingClipIds] = useState<Set<string>>(
		new Set(),
	);
	const cancellingClipIdsRef = useRef<Set<string>>(cancellingClipIds);
	const addCancelling = useCallback((id: string) => {
		const next = new Set(cancellingClipIdsRef.current).add(id);
		cancellingClipIdsRef.current = next;
		setCancellingClipIds(next);
	}, []);
	const removeCancelling = useCallback((id: string) => {
		if (!cancellingClipIdsRef.current.has(id)) return;
		const next = new Set(cancellingClipIdsRef.current);
		next.delete(id);
		cancellingClipIdsRef.current = next;
		setCancellingClipIds(next);
	}, []);
	/** 現存しない(削除された)clip の id を cancellingClipIds から取り除く。 */
	const pruneCancelling = useCallback((keepIds: Set<string>) => {
		const filtered = new Set(
			[...cancellingClipIdsRef.current].filter((id) => keepIds.has(id)),
		);
		if (filtered.size === cancellingClipIdsRef.current.size) return;
		cancellingClipIdsRef.current = filtered;
		setCancellingClipIds(filtered);
	}, []);
	// 「書き出しを開始」1 回につき、全 clip 一括起動(下記の起動 effect)を 1 度だけ
	// 行うためのガード。true になった後は clips が変わっても再起動しない
	// (新規追加/編集された clip は runClip 経由の明示操作でのみ書き出す)。
	const batchLaunchedRef = useRef(false);

	// クロップ内容プレビュー(preview_start、低ビットレート・app キャッシュ、DL/保存 UI 無し)。
	// UploadScreen の「最終プレビュー」と同じ実装を共有する。
	const preview = usePreview();

	// 非アクティブになった瞬間に配下の <video> を pause する。
	const rootRef = usePauseVideosOnHide(active);

	// 新しい元動画選択(App からの resetToken 増加)時のみ、全状態を明示的に破棄する。
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetToken の変化そのものがトリガ(mount 時の初回実行は無害)
	useEffect(() => {
		queue.reset();
		preview.reset();
		setStarted(false);
		setSelectedClipId(null);
		outputDirRef.current = null;
		setDirtyClipIds(new Set());
		cancellingClipIdsRef.current = new Set();
		setCancellingClipIds(new Set());
		batchLaunchedRef.current = false;
	}, [resetToken]);

	// clip 単位の細粒度無効化: 配列参照が変わるたびに全消去していた旧実装をやめ、
	// 「削除された clip」「trim/crop/aspect が変わった(sig が変わった) clip」の結果のみを
	// 個別に破棄する。他 clip の結果・購読・プレビューはそのまま保持する。
	//
	// 自動再書き出しの廃止(UX変更): 以前はここで破棄した clip を「起動」effect が
	// 拾って無言で再書き出ししていたが、ユーザーの知らないところでファイルが
	// 書き換わる原因になっていたため廃止した。ここでは破棄のみ行い、「要再書き出し」
	// (dirtyClipIds)としてマークするだけに留める。実際の再実行は ExportListItem の
	// 「再書き出し」ボタン(runClip)からの明示操作でのみ行う。
	//
	// 旧ジョブのキャンセル完了待ち: queue.remove() は tasks からの削除自体は同期的だが、
	// Rust 側 reframe_cancel の完了は非同期(戻り値の Promise)。同じ出力パスへ旧ジョブと
	// 新ジョブが同時に書き込む競合を避けるため、この Promise が解決するまで
	// cancellingClipIds に入れて再書き出しボタンを disabled にする。
	// biome-ignore lint/correctness/useExhaustiveDependencies: queue.tasksRef は ref(useReframeQueue 内の useRef)で読み取りは非反応的 — 旧実装の resultsRef.current と同じ理由で依存に含めない
	useEffect(() => {
		const clipIds = new Set(clips.map((c) => c.id));
		for (const [id, task] of queue.tasksRef.current) {
			const clip = clips.find((c) => c.id === id);
			const deleted = clip === undefined;
			const stale = deleted || task.sig !== clipPreviewSig(clip);
			if (!stale) continue;
			preview.remove(id);
			if (deleted) {
				// clip 自体が消えた場合は「要再書き出し」表示の対象がそもそも無いため、
				// キャンセル完了を待たず即座に破棄する(disabled 表示も不要)。
				void queue.remove(id);
				continue;
			}
			setDirtyClipIds((prev) => new Set(prev).add(id));
			addCancelling(id);
			queue.remove(id).then(() => removeCancelling(id));
		}
		// 削除された clip の id が dirty/cancelling に残ったままにならないよう掃除する
		// (稀に「編集で dirty 化した直後に clip 自体が削除される」順序があり得るため)。
		setDirtyClipIds((prev) => {
			const next = new Set([...prev].filter((id) => clipIds.has(id)));
			return next.size === prev.size ? prev : next;
		});
		pruneCancelling(clipIds);
		// 選択中 clip が削除されていたら、selectedClipId 側は別 effect(下記)で
		// 先頭 clip に補正される。
		// queue.remove は useCallback([]) で安定した参照のため、依存配列に加えても
		// 元の [clips, preview.remove] と同じタイミングでのみ発火する。
	}, [clips, preview.remove, queue.remove, addCancelling, removeCancelling, pruneCancelling]);

	/** 選択中 clip のクロップ内容プレビューを生成(または更新)する。 */
	const handlePreviewClip = (clip: Clip) => {
		if (!source) return;
		const spec = masterSpec(clip, {
			width: source.probe.width,
			height: source.probe.height,
		});
		preview.trigger(clip.id, source.inputPath, spec, clipPreviewSig(clip));
	};

	/**
	 * 書き出し先フォルダを決めてからレンダリングを開始する。
	 * 設定で既定の書き出し先(`settings.defaultExportDir`)が設定されていれば、
	 * ダイアログを出さずそのままそのパスを使う。未設定なら従来どおりダイアログで選ばせる
	 * (ダイアログの初期表示先には前回選択したフォルダ `settings.lastExportDir` を渡し、
	 * 選択確定時に更新する — デスクトップが既定表示される問題を避けるため)。
	 * キャンセル時は何もしない。
	 */
	const handleStart = async () => {
		const preset = settings.defaultExportDir;
		if (preset) {
			outputDirRef.current = preset;
			setStarted(true);
			return;
		}
		setPickingDir(true);
		try {
			const dir = await pickExportDirectory(
				"書き出し先フォルダを選択",
				settings.lastExportDir,
			);
			if (!dir) return;
			outputDirRef.current = dir;
			updateSettings({ lastExportDir: dir });
			setStarted(true);
		} finally {
			setPickingDir(false);
		}
	};

	/**
	 * 指定 clip 1 本の書き出しを起動する(予約 → 出力パス解決 → reframe_start)。
	 * 「書き出しを開始」直後の一括起動(下記 effect)と、`requestExport`(ExportListItem の
	 * 「(再)実行」ボタンからの明示操作)の両方から呼ぶ共通処理。
	 * 既に queue 上に task がある(予約済み/実行中/完了/失敗)clip には何もしない
	 * (二重起動防止。呼び出し側は「task が無い」clip に対してのみ呼ぶこと —
	 * status="error" の再試行は `requestExport` が先に queue.remove() してから呼ぶ)。
	 */
	const runClip = useCallback(
		(clip: Clip) => {
			const dir = outputDirRef.current;
			if (!source || !dir) return;
			if (queue.tasksRef.current.has(clip.id)) return;
			// 旧ジョブの reframe_cancel 完了待ち中は起動しない(ExportListItem 側は
			// ボタンを disabled にして防いでいるが、念のため二重の防御線を張る)。
			// ref を読む(state ではない)理由: requestExport は「remove() の Promise 解決
			// → 同一 tick 内で runClip() を呼ぶ」ため、state の再レンダリングを待つと
			// cancellingClipIds の stale closure を掴んでしまう。
			if (cancellingClipIdsRef.current.has(clip.id)) return;

			const sig = clipPreviewSig(clip);
			// 同期的に「実行中」として予約する(二重起動しない。既に予約/実行中なら何もしない)。
			// 返り値の世代トークンは run()/fail() にそのまま渡す(バグ3: 世代管理。
			// このトークンを渡すことで、この予約が後から remove()/再 reserve() で
			// 無効化された場合に、下記の非同期処理が新しいジョブの状態を誤って
			// 上書きしないようにする)。
			const token = queue.reserve(clip.id, { sig });
			if (!token) return;

			// 再書き出しの場合、この時点で「要再書き出し」表示は解消する(実行中に遷移)。
			setDirtyClipIds((prev) => {
				if (!prev.has(clip.id)) return prev;
				const next = new Set(prev);
				next.delete(clip.id);
				return next;
			});

			const spec = masterSpec(clip, {
				width: source.probe.width,
				height: source.probe.height,
			});
			// ファイル名の重複を避ける(同名 clip が複数ある場合など。UploadScreen の
			// 一括書き出しと同じ採番ロジックを共有する)。clips 全体から都度計算する
			// 純粋関数のため、単発の再書き出しでも一括起動時と同じ名前になる(安定)。
			const uniqueNames = uniqueBaseNames(clips, (c) => sanitizeFileName(c.name));

			void (async () => {
				try {
					const base = uniqueNames.get(clip) ?? sanitizeFileName(clip.name);
					const outputPath = await join(dir, `${base}.mp4`);
					await queue.run(
						token,
						clip.id,
						source.inputPath,
						outputPath,
						spec,
						settings.encoder,
					);
				} catch (err) {
					// join() 失敗、または queue.run() の起動/実行失敗(状態には反映済み)。
					queue.fail(token, clip.id, err);
				}
			})();
		},
		[source, clips, queue.tasksRef, queue.reserve, queue.run, queue.fail, settings.encoder],
	);

	/**
	 * ExportListItem の「(再)実行」ボタンから呼ぶ唯一のエントリポイント。
	 * - task が無い(未書き出し/要再書き出し): そのまま `runClip` する。
	 * - task が status="error"(失敗。自動リトライを廃止した代わりに明示的な再試行手段
	 *   として用意した): `runClip` の「既に task がある clip には何もしない」ガードに
	 *   阻まれるため、先に queue.remove() でキャンセル・破棄してから `runClip` する。
	 *   旧ジョブの reframe_cancel 完了を待つ間は、sig 不一致による自動無効化(上記
	 *   effect)と同じく cancellingClipIds でボタンを disabled にする。
	 */
	const requestExport = useCallback(
		(clip: Clip) => {
			if (cancellingClipIdsRef.current.has(clip.id)) return;
			if (!queue.tasksRef.current.has(clip.id)) {
				runClip(clip);
				return;
			}
			addCancelling(clip.id);
			queue.remove(clip.id).then(() => {
				removeCancelling(clip.id);
				runClip(clip);
			});
		},
		[queue.tasksRef, queue.remove, runClip, addCancelling, removeCancelling],
	);

	// レンダリング開始。「書き出しを開始」1 回につき、その時点の全 clip を一括起動する
	// (batchLaunchedRef で 1 度だけに制限 — 以前は clips 変更のたびに「done でない
	// clip」を拾い直しており、これが編集後の無言な自動再書き出しの原因だった)。
	// 画面が非アクティブ(離脱済み)でも起動判定は続ける — 常時マウントのウィザードでは
	// 「編集画面へ戻っている間に書き出しが進む」が期待挙動のため。
	useEffect(() => {
		if (!started || !source || !outputDirRef.current) return;
		if (batchLaunchedRef.current) return;
		batchLaunchedRef.current = true;
		for (const clip of clips) runClip(clip);
	}, [started, source, clips, runClip]);

	const donePaths = useMemo(() => {
		const paths: string[] = [];
		for (const clip of clips) {
			const task = queue.tasks.get(clip.id);
			if (task?.status === "done" && task.outputPath)
				paths.push(task.outputPath);
		}
		return paths;
	}, [clips, queue.tasks]);

	// 進捗サマリを App(StepIndicator バッジ)へ押し上げる。
	const progressSummary = useMemo<ExportSummary>(() => {
		let done = 0;
		let running = 0;
		for (const clip of clips) {
			const task = queue.tasks.get(clip.id);
			if (task?.status === "done") done += 1;
			else if (task?.status === "running") running += 1;
		}
		return { total: clips.length, done, running };
	}, [clips, queue.tasks]);

	useEffect(() => {
		onProgressSummary?.(progressSummary);
	}, [progressSummary, onProgressSummary]);

	// 書き出し先フォルダを OS 既定のファイルマネージャで開く。
	// studio 版は書き出し結果を HTTP 経由の ZIP ダウンロードで渡すが、desktop には
	// studio-server が存在しないため同じ経路は使えない(既知ギャップ)。書き出し済み
	// ファイルは既に `dir` 直下へ実体として存在するので、ZIP 化せずフォルダを開くだけで足りる。
	const openFolderMutation = useMutation({
		mutationFn: async () => {
			const dir = outputDirRef.current;
			if (!dir) throw new Error("書き出し先フォルダが未選択です。");
			await openPath(dir);
		},
	});

	// バッチ内の全 clip が成功(done)で完了したタイミングで一度だけ発火する
	// 「完了時アクション」(デスクトップ通知 / 出力先フォルダを開く)。設定で
	// それぞれ独立に有効/無効を切り替えられる。
	// 「未完了 → 全完了」への遷移でのみ発火させる(completionActionsFiredRef で
	// 二重発火を防ぐ。失敗中の clip がある間は donePaths が clips.length に
	// 届かないため発火しない)。
	const completionActionsFiredRef = useRef(false);
	useEffect(() => {
		const dir = outputDirRef.current;
		const allDone =
			started && !!dir && clips.length > 0 && donePaths.length === clips.length;
		if (!allDone) {
			completionActionsFiredRef.current = false;
			return;
		}
		if (completionActionsFiredRef.current) return;
		completionActionsFiredRef.current = true;
		if (settings.notifyOnExportComplete) void notifyExportComplete(clips.length);
		if (!settings.openFolderAfterExport) return;
		void openPath(dir);
	}, [
		started,
		clips.length,
		donePaths.length,
		settings.notifyOnExportComplete,
		settings.openFolderAfterExport,
	]);

	// 選択中 clip が clips から消えたとき(または未選択のとき)は先頭 clip を選択する。
	useEffect(() => {
		setSelectedClipId((prev) => {
			if (prev !== null && clips.some((clip) => clip.id === prev)) return prev;
			return clips[0]?.id ?? null;
		});
	}, [clips]);

	const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null;

	return (
		<section ref={rootRef} className="flex h-full min-h-0 flex-col">
			{/* ステップ遷移時のフォーカス移動先(a11y、App.tsx goToStep 参照)。視覚上は非表示。 */}
			<h2 id="wizard-panel-heading-export" tabIndex={-1} className="sr-only">
				書き出し
			</h2>
			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				<div className="flex h-full min-h-0 gap-4">
					{/*
					 * 中央: 選択中 clip のクロップ内容プレビュー(常時表示) + 書き出し状態カード。
					 * UX変更: 以前は started フラグでプレビュー(ExportPreviewDetail)と書き出し
					 * 詳細(ExportDetail)を排他切り替えしており、「書き出しを開始」した後は
					 * クロップ内容を確認する導線が消えていた。「内容確認はプレビュー(キャッシュ)」
					 * 「ファイル出力は書き出し(明示ボタン)」を UI 上で完全に分離するため、
					 * プレビューは started に関係なく常に表示し、書き出しの進捗/完了/エラーは
					 * その下に compact な状態カードとして分離表示する(started 前は表示するものが
					 * 無いため ExportDetail 自体をマウントしない)。
					 */}
					<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2">
						{selectedClip ? (
							<>
								<ExportPreviewDetail
									clip={selectedClip}
									state={preview.states.get(selectedClip.id)}
									onGenerate={() => handlePreviewClip(selectedClip)}
									onCancel={() => preview.cancel(selectedClip.id)}
								/>
								{started && (
									// key=clip.id: 選択 clip の切替でコンポーネントを作り直し、
									// 前clip の再生/フォルダ表示 mutation の pending/error 状態が
									// 別 clip のカードへ持ち越されないようにする。
									<ExportDetail
										key={selectedClip.id}
										task={queue.tasks.get(selectedClip.id)}
										dirty={dirtyClipIds.has(selectedClip.id)}
									/>
								)}
							</>
						) : (
							<p className="text-sm text-neutral-400">
								プレビューする切り抜きがありません。
							</p>
						)}
					</div>

					{/*
					 * 右: clip 一覧。書き出し開始前は「プレビュー状態」の一覧
					 * (ExportPreviewListItem)、開始後は「書き出し状態 + (再)実行ボタン」の
					 * 一覧(ExportListItem)を表示する — この出し分け自体は PR #64 のまま変更しない
					 * (中央パネルの排他表示を廃止しても、書き出し操作の導線はここに集約したまま)。
					 */}
					{!started ? (
						<div className="flex min-h-0 w-60 shrink-0 flex-col gap-1 overflow-y-auto border-l border-line pl-4">
							{clips.map((clip) => (
								<ExportPreviewListItem
									key={clip.id}
									clip={clip}
									state={preview.states.get(clip.id)}
									selected={clip.id === selectedClipId}
									onSelect={() => setSelectedClipId(clip.id)}
								/>
							))}
						</div>
					) : (
						<div className="flex min-h-0 w-60 shrink-0 flex-col gap-3 border-l border-line pl-4">
							<div className="flex flex-col gap-1.5">
								{/* 既定の書き出し先が設定されている場合、ダイアログをスキップして
								ここへ直接書き出すため、実際の出力先パスを常に見える形にしておく。 */}
								<span
									className="truncate font-mono text-[10px] text-neutral-500"
									title={outputDirRef.current ?? undefined}
								>
									{outputDirRef.current}
								</span>
								<Button
									size="sm"
									variant="secondary"
									disabled={openFolderMutation.status === "pending"}
									onClick={() => openFolderMutation.mutate()}
								>
									{openFolderMutation.status === "pending"
										? "開いています…"
										: "出力先フォルダを開く"}
								</Button>
								<span className="text-[11px] text-neutral-400">
									完了 {donePaths.length} / {clips.length} 件
								</span>
								{openFolderMutation.isError && (
									<span className="text-xs text-danger">
										フォルダを開けませんでした:{" "}
										{getErrorMessage(openFolderMutation.error)}
									</span>
								)}
							</div>

							<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
								{clips.map((clip) => (
									<ExportListItem
										key={clip.id}
										clip={clip}
										task={queue.tasks.get(clip.id)}
										selected={clip.id === selectedClipId}
										onSelect={() => setSelectedClipId(clip.id)}
										dirty={dirtyClipIds.has(clip.id)}
										cancelling={cancellingClipIds.has(clip.id)}
										onExport={() => requestExport(clip)}
									/>
								))}
							</div>
						</div>
					)}
				</div>
			</div>

			<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
				<Button variant="ghost" onClick={onGoToEdit} className="mr-auto">
					編集に戻る
				</Button>
				{!started && (
					<p className="max-w-xs truncate text-xs text-neutral-400">
						{clips.length} 本を書き出します(順次レンダリング)。
						{settings.defaultExportDir &&
							` 書き出し先: ${settings.defaultExportDir}`}
					</p>
				)}
				{!started && (
					<Button
						variant="primary"
						disabled={clips.length === 0 || pickingDir}
						onClick={() => void handleStart()}
					>
						{pickingDir
							? "書き出し先フォルダを選択中…"
							: `書き出しを開始(${clips.length}本)`}
					</Button>
				)}
				{onGoToUpload && (
					<Button
						variant="primary"
						disabled={clips.length === 0}
						onClick={onGoToUpload}
					>
						アップロードへ進む
					</Button>
				)}
			</footer>
		</section>
	);
}

