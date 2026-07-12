import { useEffect, useMemo, useRef, useState } from "react";
import { join } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { useMutation } from "@tanstack/react-query";
import type { Clip } from "../../types";
import { aspectRatio, masterSpec } from "../../types";
import type { MediaInfo } from "../../lib/tauri";
import {
	cancelJob,
	convertFileSrc,
	pickExportDirectory,
	sanitizeFileName,
} from "../../lib/tauri";
import { type PreviewState, usePreview } from "../../lib/usePreview";
import { type ReframeTaskState, useReframeQueue } from "../../lib/useReframeQueue";
import { usePauseVideosOnHide } from "../../lib/usePauseVideosOnHide";
import { getErrorMessage } from "../../lib/getErrorMessage";
import { clipPreviewSig } from "../../lib/clipSig";
import { uniqueBaseNames } from "../../lib/uniqueBaseName";
import { formatTime } from "../../lib/format";
import { Button } from "../../components/ui/Button";
import { cn } from "../../components/ui/cn";
import type { ExportSummary } from "../wizard/StepIndicator";

interface ExportScreenProps {
	/** true のとき現在表示中の画面(ウィザードのアクティブステップ)。 */
	active: boolean;
	source: { inputPath: string; probe: MediaInfo } | null;
	clips: Clip[];
	/**
	 * 増加するたびに全状態を明示的に破棄する(新しい元動画を選択したときのみ App
	 * から増分される)。通常の clip 編集(トリム/クロップ/アスペクト変更)では
	 * 増分されない — その場合は clip 単位の細粒度無効化(下記 sig 比較)で足りる。
	 */
	resetToken: number;
	onGoToEdit: () => void;
	onGoToUpload: () => void;
	/** results から導出した進捗サマリを App(StepIndicator バッジ)へ押し上げる。 */
	onProgressSummary?: (summary: ExportSummary) => void;
}

/**
 * clip 単位の書き出し進捗・結果。`useReframeQueue` の `ReframeTaskState` そのもの
 * (`sig` は生成時点の clipPreviewSig。clips 側の対応する clip の現在の sig と異なれば
 * この結果は古い(要無効化) — clip 単位の細粒度無効化に使う)。
 */
type TaskState = ReframeTaskState;

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

	// 明示的に「書き出しを開始」するまでレンダリングを始めない(切替直後に
	// 全 clip のレンダリングを走らせて CPU を占有しないため)。
	const [started, setStarted] = useState(false);
	// 書き出し先フォルダの選択中(ダイアログ表示中)フラグ。
	const [pickingDir, setPickingDir] = useState(false);

	// マスター/詳細レイアウトの選択中 clip。
	const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

	// ユーザーが選んだ書き出し先フォルダ(絶対パス)。「書き出しを開始」時に選ばせる。
	const outputDirRef = useRef<string | null>(null);

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
	}, [resetToken]);

	// clip 単位の細粒度無効化(最重要): 配列参照が変わるたびに全消去していた旧実装をやめ、
	// 「削除された clip」「trim/crop/aspect が変わった(sig が変わった) clip」の結果のみを
	// 個別に破棄する。他 clip の結果・購読・プレビューはそのまま保持する。
	// biome-ignore lint/correctness/useExhaustiveDependencies: queue.tasksRef は ref(useReframeQueue 内の useRef)で読み取りは非反応的 — 旧実装の resultsRef.current と同じ理由で依存に含めない
	useEffect(() => {
		for (const [id, task] of queue.tasksRef.current) {
			const clip = clips.find((c) => c.id === id);
			const stale = clip === undefined || task.sig !== clipPreviewSig(clip);
			if (!stale) continue;
			// queue.remove は tasksRef を同期更新するため、このコミット内で後続実行される
			// 「起動」effect(下記、同じく [clips] 依存)が無効化直後の最新状態を見られる
			// (P1-7: 無効化と起動が同一コミット内で順に走っても再起動を取りこぼさない)。
			queue.remove(id);
			preview.remove(id);
		}
		// 選択中 clip が削除されていたら、selectedClipId 側は別 effect(下記)で
		// 先頭 clip に補正される。
		// queue.remove は useCallback([]) で安定した参照のため、依存配列に加えても
		// 元の [clips, preview.remove] と同じタイミングでのみ発火する。
	}, [clips, preview.remove, queue.remove]);

	/** 選択中 clip のクロップ内容プレビューを生成(または更新)する。 */
	const handlePreviewClip = (clip: Clip) => {
		if (!source) return;
		const spec = masterSpec(clip, {
			width: source.probe.width,
			height: source.probe.height,
		});
		preview.trigger(clip.id, source.inputPath, spec, clipPreviewSig(clip));
	};

	/** 書き出し先フォルダを選ばせてからレンダリングを開始する。キャンセル時は何もしない。 */
	const handleStart = async () => {
		setPickingDir(true);
		try {
			const dir = await pickExportDirectory();
			if (!dir) return;
			outputDirRef.current = dir;
			setStarted(true);
		} finally {
			setPickingDir(false);
		}
	};

	// レンダリング開始。開始操作後・source・出力先があり、done 結果を持たない clip のみ対象。
	// 画面が非アクティブ(離脱済み)でも起動判定は続ける — 常時マウントのウィザードでは
	// 「編集画面へ戻っている間に書き出しが進む」が期待挙動のため。
	useEffect(() => {
		const dir = outputDirRef.current;
		if (!started || !source || !dir) return;
		const probe = source.probe;
		const input = source.inputPath;

		// ファイル名の重複を避ける(同名 clip が複数ある場合など。UploadScreen の
		// 一括書き出しと同じ採番ロジックを共有する)。現在の clips 全体から都度
		// 計算する純粋関数のため、この effect が複数回走っても同じ clip 集合であれば
		// 同じ名前を返す(安定)。
		const uniqueNames = uniqueBaseNames(clips, (c) => sanitizeFileName(c.name));

		for (const clip of clips) {
			const existing = queue.tasksRef.current.get(clip.id);
			if (existing && existing.status === "done") continue;

			const sig = clipPreviewSig(clip);
			// 同期的に「実行中」として予約する(二重起動しない。既に予約/実行中なら何もしない)。
			if (!queue.reserve(clip.id, { sig })) continue;

			const spec = masterSpec(clip, {
				width: probe.width,
				height: probe.height,
			});

			void (async () => {
				try {
					const base = uniqueNames.get(clip) ?? sanitizeFileName(clip.name);
					const outputPath = await join(dir, `${base}.mp4`);
					await queue.run(clip.id, input, outputPath, spec);
				} catch (err) {
					// join() 失敗、または queue.run() の起動/実行失敗(状態には反映済み)。
					queue.fail(clip.id, err);
				}
			})();
		}
	}, [started, source, clips, queue.tasksRef, queue.reserve, queue.run, queue.fail]);

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
			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				{!started ? (
					<div className="flex h-full min-h-0 gap-4">
						{/* 中央: 選択中 clip のクロップ内容プレビュー */}
						<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2">
							{selectedClip ? (
								<ExportPreviewDetail
									clip={selectedClip}
									state={preview.states.get(selectedClip.id)}
									onGenerate={() => handlePreviewClip(selectedClip)}
									onCancel={() => preview.cancel(selectedClip.id)}
								/>
							) : (
								<p className="text-sm text-neutral-400">
									プレビューする切り抜きがありません。
								</p>
							)}
						</div>

						{/* 右: clip 一覧(プレビュー状態) */}
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
					</div>
				) : (
					<div className="flex h-full min-h-0 gap-4">
						{/* 中央: 選択中 clip の詳細 */}
						<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2">
							{selectedClip ? (
								<ExportDetail
									clip={selectedClip}
									task={queue.tasks.get(selectedClip.id)}
								/>
							) : (
								<p className="text-sm text-neutral-400">
									書き出す切り抜きがありません。
								</p>
							)}
						</div>

						{/* 右: 一括DL + clip 一覧 */}
						<div className="flex min-h-0 w-60 shrink-0 flex-col gap-3 border-l border-line pl-4">
							<div className="flex flex-col gap-1.5">
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
									/>
								))}
							</div>
						</div>
					</div>
				)}
			</div>

			<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
				<Button variant="ghost" onClick={onGoToEdit} className="mr-auto">
					編集に戻る
				</Button>
				{!started && (
					<p className="max-w-xs truncate text-xs text-neutral-400">
						{clips.length} 本を書き出します(順次レンダリング)。
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
				<Button
					variant="primary"
					disabled={clips.length === 0}
					onClick={onGoToUpload}
				>
					アップロードへ進む
				</Button>
			</footer>
		</section>
	);
}

/** 右側一覧の 1 行(clip 名 + ステータス)。 */
function ExportListItem({
	clip,
	task,
	selected,
	onSelect,
}: {
	clip: Clip;
	task: TaskState | undefined;
	selected: boolean;
	onSelect: () => void;
}) {
	// task が undefined = まだ起動 effect に一度も拾われていない(=書き出しキュー待ち)。
	// これを「実行中 0%」と誤表示すると、P1-7(起動 effect の取りこぼし)が発生した際に
	// 気付けないため、「待機中」と正直に表示する。
	const pending = task === undefined;
	const status = task?.status ?? "running";
	const ratio = task?.ratio ?? 0;
	const length = Math.max(0, clip.trim.end - clip.trim.start);

	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"flex flex-col gap-1 rounded-md border px-2 py-1.5 text-left transition-colors",
				selected
					? "border-accent bg-accent/10"
					: "border-transparent hover:bg-elevated",
			)}
		>
			<span className="flex items-center justify-between gap-2">
				<span
					className="truncate font-mono text-xs text-neutral-200"
					title={`${clip.name}.mp4`}
				>
					{clip.name}.mp4
				</span>
				<span className="flex shrink-0 items-center gap-1.5">
					{status === "running" && task?.notice && (
						<span
							className="rounded bg-amber-400/15 px-1 text-[11px] font-medium text-amber-400"
							title={task.notice}
						>
							SW
						</span>
					)}
					<span
						className={cn(
							"text-[11px]",
							status === "done" && "text-ok",
							status === "error" && "text-danger",
							status === "running" && "text-neutral-400",
						)}
					>
						{pending
							? "待機中"
							: status === "done"
								? "完了"
								: status === "error"
									? "失敗"
									: `${Math.round(ratio * 100)}%`}
					</span>
				</span>
			</span>
			<span className="flex items-center gap-2 text-[11px] text-neutral-400">
				<span className="rounded bg-panel px-1.5 py-0.5 font-medium text-neutral-300">
					{clip.aspect === "free" ? "自由" : clip.aspect}
				</span>
				<span className="font-mono tabular-nums">{formatTime(length)}</span>
			</span>
		</button>
	);
}

/** 右側一覧の 1 行(clip 名 + プレビュー生成状態)。「書き出しを開始」前の画面用。 */
function ExportPreviewListItem({
	clip,
	state,
	selected,
	onSelect,
}: {
	clip: Clip;
	state: PreviewState | undefined;
	selected: boolean;
	onSelect: () => void;
}) {
	const rendering = state?.rendering ?? false;
	const done = state?.outputPath !== undefined && !rendering;
	const length = Math.max(0, clip.trim.end - clip.trim.start);

	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"flex flex-col gap-1 rounded-md border px-2 py-1.5 text-left transition-colors",
				selected
					? "border-accent bg-accent/10"
					: "border-transparent hover:bg-elevated",
			)}
		>
			<span className="flex items-center justify-between gap-2">
				<span
					className="truncate font-mono text-xs text-neutral-200"
					title={`${clip.name}.mp4`}
				>
					{clip.name}.mp4
				</span>
				<span
					className={cn(
						"shrink-0 text-[11px]",
						state?.error && "text-danger",
						!state?.error && done && "text-ok",
						!state?.error && !done && "text-neutral-400",
					)}
				>
					{state?.error
						? "失敗"
						: rendering
							? "生成中…"
							: done
								? "プレビュー済み"
								: "未生成"}
				</span>
			</span>
			<span className="flex items-center gap-2 text-[11px] text-neutral-400">
				<span className="rounded bg-panel px-1.5 py-0.5 font-medium text-neutral-300">
					{clip.aspect === "free" ? "自由" : clip.aspect}
				</span>
				<span className="font-mono tabular-nums">{formatTime(length)}</span>
			</span>
		</button>
	);
}

/**
 * 中央: 選択中 clip 1 本ぶんのクロップ内容プレビュー。「書き出しを開始」前の画面用。
 * `preview_start`(低ビットレート・app キャッシュ)を使い、ユーザー向けの
 * ファイルダウンロード/保存は行わない(結果は画面内の <video> 表示のみ)。
 */
function ExportPreviewDetail({
	clip,
	state,
	onGenerate,
	onCancel,
}: {
	clip: Clip;
	state: PreviewState | undefined;
	onGenerate: () => void;
	onCancel: () => void;
}) {
	const rendering = state?.rendering ?? false;
	const outputPath = state?.outputPath;
	const boxRatio = aspectRatio(clip.aspect) ?? 16 / 9;

	return (
		<div className="flex h-full min-h-0 w-full flex-col items-center justify-center rounded-lg bg-panel/40 p-4">
			{/*
			 * ファイル名 + プレビュー枠 + 生成ボタンを 1 つの縦スタックにまとめ、
			 * スタックごと縦センターに置く(枠を flex-1 で伸ばすと、横長アスペクトでは
			 * 枠だけが縦センターに contain され、ボタンが下端に取り残されて視覚グループが
			 * 分断される)。枠の高さは「幅 = min(横いっぱい, 利用可能な縦空間 × アスペクト比)」
			 * から従属的に決まる — 300px はヘッダ/フッタ/タイトル行/ボタン行ぶんの固定オフセット。
			 */}
			<div
				className="flex min-h-0 flex-col gap-3"
				style={{
					width: `min(100%, max(280px, calc((100vh - 300px) * ${boxRatio})))`,
				}}
			>
				<div className="flex shrink-0 items-center justify-between gap-2">
					<h3
						className="truncate font-mono text-sm text-neutral-100"
						title={`${clip.name}.mp4`}
					>
						{clip.name}.mp4
					</h3>
					<span className="shrink-0 text-[11px] text-neutral-400">
						クロップ内容プレビュー
					</span>
				</div>

				<div
					style={{ aspectRatio: boxRatio }}
					className="flex w-full items-center justify-center overflow-hidden rounded-lg border border-line bg-black/40"
				>
					{outputPath ? (
						/* biome-ignore lint/a11y/useMediaCaption: 書き出し内容確認用のプレビューで字幕データが存在しない */
						<video
							controls
							src={convertFileSrc(outputPath)}
							className="h-full w-full object-contain"
						/>
					) : (
						<p className="max-w-[75%] text-center text-xs text-neutral-500">
							「プレビュー生成」でクロップ内容を確認できます(ファイルはアプリの
							キャッシュにのみ作成され、保存・ダウンロードはされません)。
						</p>
					)}
				</div>

				<div className="flex shrink-0 items-center justify-center gap-2">
					<Button
						variant="secondary"
						size="sm"
						onClick={onGenerate}
						disabled={rendering}
					>
						{rendering ? "生成中…" : outputPath ? "プレビュー更新" : "プレビュー生成"}
					</Button>
					{rendering && (
						<Button variant="ghost" size="sm" onClick={onCancel}>
							キャンセル
						</Button>
					)}
					{state?.error && <p className="text-xs text-danger">{state.error}</p>}
				</div>
			</div>
		</div>
	);
}

/** 中央: 選択中 clip 1 本ぶんの書き出し詳細。 */
function ExportDetail({
	clip,
	task,
}: {
	clip: Clip;
	task: TaskState | undefined;
}) {
	// task が undefined = 起動 effect がまだ拾っていない(=書き出しキュー待ち)。
	// 「書き出し中 0%」と混同しないよう正直に「待機中」を出す(P1-7 の温床だった箇所)。
	const pending = task === undefined;
	const status = task?.status ?? "running";
	const ratio = task?.ratio ?? 0;
	const boxRatio = aspectRatio(clip.aspect) ?? 16 / 9;

	return (
		<div className="flex h-full min-h-0 w-full flex-col items-center justify-center rounded-lg bg-panel/40 p-4">
			{/* ExportPreviewDetail と同じ縦スタック構造(ファイル名 + 枠 + 補足行を
			    1 グループとして縦センター)。幅の式も共有する。 */}
			<div
				className="flex min-h-0 flex-col gap-3"
				style={{
					width: `min(100%, max(280px, calc((100vh - 300px) * ${boxRatio})))`,
				}}
			>
				<div className="flex shrink-0 items-center justify-between gap-2">
					<h3
						className="truncate font-mono text-sm text-neutral-100"
						title={`${clip.name}.mp4`}
					>
						{clip.name}.mp4
					</h3>
					{status === "running" && task?.fps !== undefined && (
						<span className="shrink-0 text-[11px] text-neutral-500">
							{Math.round(task.fps)}fps
						</span>
					)}
				</div>

				<div
					style={{ aspectRatio: boxRatio }}
					className="flex w-full items-center justify-center overflow-hidden rounded-lg border border-line bg-black/40"
				>
					{status === "done" && task?.outputPath ? (
						// biome-ignore lint/a11y/useMediaCaption: 書き出し結果のプレビューで字幕データが存在しない
						<video
							controls
							src={convertFileSrc(task.outputPath)}
							className="h-full w-full object-contain"
						/>
					) : status === "error" ? (
						<p className="max-w-[80%] text-center text-sm text-danger">
							{task?.error ?? "書き出しに失敗しました。"}
						</p>
					) : (
						<div className="flex w-2/3 flex-col items-center gap-1.5 text-center">
							<div className="h-1.5 w-full overflow-hidden rounded-full bg-panel">
								<div
									className="h-full rounded-full bg-accent transition-[width]"
									style={{ width: `${Math.round(ratio * 100)}%` }}
								/>
							</div>
							<div className="flex items-center gap-2">
								<span className="text-xs text-neutral-400">
									{pending
										? "待機中…"
										: `書き出し中… ${Math.round(ratio * 100)}%`}
								</span>
								{task?.jobId && (
									<Button
										variant="ghost"
										size="sm"
										onClick={() => task.jobId && void cancelJob(task.jobId)}
									>
										キャンセル
									</Button>
								)}
							</div>
							{task?.notice && (
								<span className="text-[11px] text-amber-400">
									{task.notice}
								</span>
							)}
						</div>
					)}
				</div>

				{status === "done" && task?.outputPath && (
					<p
						className="truncate font-mono text-[11px] text-neutral-500"
						title={task.outputPath}
					>
						{task.outputPath}
					</p>
				)}
			</div>
		</div>
	);
}
