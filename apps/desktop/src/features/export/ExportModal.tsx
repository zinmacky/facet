import { useEffect, useMemo, useRef, useState } from "react";
import { join } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { useMutation } from "@tanstack/react-query";
import type { Clip } from "../../types";
import { masterSpec } from "../../types";
import type { MediaInfo } from "../../lib/tauri";
import {
	cancelJob,
	convertFileSrc,
	pickExportDirectory,
	sanitizeFileName,
	startReframe,
} from "../../lib/tauri";
import { type PreviewState, usePreview } from "../../lib/usePreview";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { cn } from "../../components/ui/cn";

interface ExportModalProps {
	open: boolean;
	source: { inputPath: string; probe: MediaInfo } | null;
	clips: Clip[];
	onClose: () => void;
	onProceedToUpload: () => void;
}

/** clip 単位の書き出し進捗・結果。 */
interface TaskState {
	status: "running" | "done" | "error";
	ratio: number;
	fps?: number;
	outputPath?: string;
	error?: string;
	/** キャンセル/失敗の区別無く、実行中ジョブの ID(キャンセルボタン用)。 */
	jobId?: string;
	/** フォールバック等の一時通知(例: ソフトウェアエンコードで再試行中)。 */
	notice?: string;
}

/**
 * masterSpec(クロップ内容)に影響する clip フィールドのシグネチャ。
 * これが変わればプレビューは古い(要更新) — usePreview の sig として使う。
 */
function clipPreviewSig(clip: Clip): string {
	const crop = clip.crop
		? `${clip.crop.x}:${clip.crop.y}:${clip.crop.width}:${clip.crop.height}`
		: "full";
	return `${clip.trim.start}:${clip.trim.end}|${clip.aspect}|${crop}`;
}

/**
 * EXPORT モーダル: 各 clip のマスター(クロップ内容そのもの)を書き出す。
 * open が true でソースがあるとき、まだ done でない clip をレンダリング開始する。
 * 再オープンでは既存の done 結果を保持して再レンダしない。
 */
export function ExportModal({
	open,
	source,
	clips,
	onClose,
	onProceedToUpload,
}: ExportModalProps) {
	const [results, setResults] = useState<Map<string, TaskState>>(new Map());

	// 明示的に「書き出しを開始」するまでレンダリングを始めない(開いた瞬間に
	// 全 clip のレンダリングを走らせて CPU を占有しないため)。
	const [started, setStarted] = useState(false);
	// 書き出し先フォルダの選択中(ダイアログ表示中)フラグ。
	const [pickingDir, setPickingDir] = useState(false);

	// マスター/詳細レイアウトの選択中 clip。
	const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

	// 結果を effect から参照するためのミラー(再購読トリガにしないため ref で持つ)。
	const resultsRef = useRef<Map<string, TaskState>>(results);
	resultsRef.current = results;

	// clipId ごとの購読解除関数。
	const unsubsRef = useRef<Map<string, () => void>>(new Map());

	// ユーザーが選んだ書き出し先フォルダ(絶対パス)。「書き出しを開始」時に選ばせる。
	const outputDirRef = useRef<string | null>(null);

	// クロップ内容プレビュー(preview_start、低ビットレート・app キャッシュ、DL/保存 UI 無し)。
	// UploadModal の「最終プレビュー」と同じ実装を共有する。
	const preview = usePreview();

	// clips の入れ替え時は古い結果・購読を破棄する。
	// biome-ignore lint/correctness/useExhaustiveDependencies: clips は本文で参照しないが入れ替え検知のトリガとして意図的に指定
	useEffect(() => {
		for (const unsub of unsubsRef.current.values()) unsub();
		unsubsRef.current.clear();
		resultsRef.current = new Map();
		setResults(new Map());
		preview.reset();
		// clips が入れ替わったら再度「開始」を要求する。
		setStarted(false);
	}, [clips]);

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

	// レンダリング開始。開始操作後・open・source・出力先があり、done 結果を持たない clip のみ対象。
	useEffect(() => {
		const dir = outputDirRef.current;
		if (!started || !open || !source || !dir) return;
		const probe = source.probe;
		const input = source.inputPath;

		for (const clip of clips) {
			const existing = resultsRef.current.get(clip.id);
			if (existing && existing.status === "done") continue;
			if (unsubsRef.current.has(clip.id)) continue; // 実行中は二重起動しない

			// running としてマーク(仮の unsubscribe を先に登録し二重起動を防ぐ)。
			unsubsRef.current.set(clip.id, () => {});
			setResults((prev) => {
				const next = new Map(prev);
				next.set(clip.id, { status: "running", ratio: 0 });
				return next;
			});

			const spec = masterSpec(clip, {
				width: probe.width,
				height: probe.height,
			});

			const update = (patch: Partial<TaskState>) => {
				setResults((prev) => {
					const next = new Map(prev);
					const cur = next.get(clip.id) ?? { status: "running", ratio: 0 };
					next.set(clip.id, { ...cur, ...patch });
					return next;
				});
			};

			void (async () => {
				try {
					const outputPath = await join(
						dir,
						`${sanitizeFileName(clip.name)}.mp4`,
					);
					const handle = await startReframe(input, outputPath, spec, {
						onProgress: (progress) => {
							update({
								status: "running",
								ratio: (progress.percent ?? 0) / 100,
								fps: progress.fps,
							});
						},
						onDone: () => {
							update({ status: "done", ratio: 1, outputPath });
							unsubsRef.current.get(clip.id)?.();
							unsubsRef.current.delete(clip.id);
						},
						onError: (message) => {
							update({ status: "error", error: message });
							unsubsRef.current.get(clip.id)?.();
							unsubsRef.current.delete(clip.id);
						},
					});
					update({ jobId: handle.jobId });
					unsubsRef.current.set(clip.id, handle.unsubscribe);
				} catch (err) {
					unsubsRef.current.delete(clip.id);
					update({
						status: "error",
						error: err instanceof Error ? err.message : String(err),
					});
				}
			})();
		}
	}, [started, open, source, clips]);

	// アンマウント時に全購読を解除。
	useEffect(() => {
		const unsubs = unsubsRef.current;
		return () => {
			for (const unsub of unsubs.values()) unsub();
			unsubs.clear();
		};
	}, []);

	const donePaths = useMemo(() => {
		const paths: string[] = [];
		for (const clip of clips) {
			const task = results.get(clip.id);
			if (task?.status === "done" && task.outputPath)
				paths.push(task.outputPath);
		}
		return paths;
	}, [clips, results]);

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

	// open 時、または選択中 clip が clips から消えたときは先頭 clip を選択する。
	useEffect(() => {
		if (!open) return;
		setSelectedClipId((prev) => {
			if (prev !== null && clips.some((clip) => clip.id === prev)) return prev;
			return clips[0]?.id ?? null;
		});
	}, [open, clips]);

	const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null;

	return (
		<Modal
			open={open}
			title="書き出し(クロップ内容)"
			onClose={onClose}
			widthClass="max-w-7xl"
			footer={
				<>
					<Button variant="ghost" onClick={onClose}>
						閉じる
					</Button>
					<Button
						variant="primary"
						disabled={clips.length === 0}
						onClick={onProceedToUpload}
					>
						アップロードへ進む
					</Button>
				</>
			}
		>
			{!started ? (
				<div className="flex min-h-[60vh] gap-3">
					{/* 中央: 選択中 clip のクロップ内容プレビュー + 開始操作 */}
					<div className="flex min-w-0 flex-1 flex-col gap-3">
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

						<div className="mt-auto flex flex-col items-center gap-3 border-t border-line pt-3 text-center">
							<p className="max-w-sm text-sm text-neutral-300">
								{clips.length}{" "}
								本の切り抜きをマスター動画(クロップ内容そのもの)として
								書き出します。開始すると各切り抜きのレンダリングを順次実行します。
							</p>
							<Button
								variant="primary"
								disabled={clips.length === 0 || pickingDir}
								onClick={() => void handleStart()}
							>
								{pickingDir
									? "書き出し先フォルダを選択中…"
									: `書き出しを開始(${clips.length}本)`}
							</Button>
						</div>
					</div>

					{/* 右: clip 一覧(プレビュー状態) */}
					<div className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-l border-line pl-3">
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
				<div className="flex min-h-[60vh] gap-3">
					{/* 中央: 選択中 clip の詳細 */}
					<div className="flex min-w-0 flex-1 flex-col gap-3">
						{selectedClip ? (
							<ExportDetail
								clip={selectedClip}
								task={results.get(selectedClip.id)}
							/>
						) : (
							<p className="text-sm text-neutral-400">
								書き出す切り抜きがありません。
							</p>
						)}
					</div>

					{/* 右: 一括DL + clip 一覧 */}
					<div className="flex w-64 shrink-0 flex-col gap-3 border-l border-line pl-3">
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
									{(openFolderMutation.error as Error).message}
								</span>
							)}
						</div>

						<div className="flex flex-col gap-1 overflow-y-auto">
							{clips.map((clip) => (
								<ExportListItem
									key={clip.id}
									clip={clip}
									task={results.get(clip.id)}
									selected={clip.id === selectedClipId}
									onSelect={() => setSelectedClipId(clip.id)}
								/>
							))}
						</div>
					</div>
				</div>
			)}
		</Modal>
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
	const status = task?.status ?? "running";
	const ratio = task?.ratio ?? 0;

	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
				selected
					? "border-accent bg-accent/10"
					: "border-transparent hover:bg-elevated",
			)}
		>
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
					{status === "done"
						? "完了"
						: status === "error"
							? "失敗"
							: `${Math.round(ratio * 100)}%`}
				</span>
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

	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
				selected
					? "border-accent bg-accent/10"
					: "border-transparent hover:bg-elevated",
			)}
		>
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
		</button>
	);
}

/**
 * 中央: 選択中 clip 1 本ぶんのクロップ内容プレビュー。「書き出しを開始」前の画面用。
 * `preview_start`(低ビットレート・app キャッシュ)を使い、ユーザー向けの
 * ファイルダウンロード/保存は行わない(結果はモーダル内の <video> 表示のみ)。
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

	return (
		<div className="flex flex-col gap-2 rounded-lg border border-line bg-elevated/40 p-3">
			<div className="flex items-center justify-between gap-2">
				<h3 className="truncate font-mono text-sm text-neutral-100">
					{clip.name}.mp4
				</h3>
				<span className="shrink-0 text-[11px] text-neutral-400">
					クロップ内容プレビュー
				</span>
			</div>

			{outputPath ? (
				/* biome-ignore lint/a11y/useMediaCaption: 書き出し内容確認用のプレビューで字幕データが存在しない */
				<video
					controls
					src={convertFileSrc(outputPath)}
					className="max-h-[40vh] w-full rounded bg-black"
				/>
			) : (
				<p className="py-10 text-center text-sm text-neutral-400">
					「プレビュー生成」でクロップ内容を確認できます(ファイルはアプリの
					キャッシュにのみ作成され、保存・ダウンロードはされません)。
				</p>
			)}

			<div className="flex items-center gap-2">
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
			</div>
			{state?.error && <p className="text-xs text-danger">{state.error}</p>}
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
	const status = task?.status ?? "running";
	const ratio = task?.ratio ?? 0;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-2">
				<h3 className="truncate font-mono text-sm text-neutral-100">
					{clip.name}.mp4
				</h3>
				{status === "running" && task?.fps !== undefined && (
					<span className="shrink-0 text-[11px] text-neutral-500">
						{Math.round(task.fps)}fps
					</span>
				)}
			</div>

			{status === "done" && task?.outputPath && (
				<>
					{/* biome-ignore lint/a11y/useMediaCaption: 書き出し結果のプレビューで字幕データが存在しない */}
					<video
						controls
						src={convertFileSrc(task.outputPath)}
						className="max-h-[46vh] w-full rounded bg-black"
					/>
					<p
						className="truncate font-mono text-[11px] text-neutral-500"
						title={task.outputPath}
					>
						{task.outputPath}
					</p>
				</>
			)}

			{status === "running" && (
				<div className="flex flex-col gap-1.5">
					<div className="h-1.5 w-full overflow-hidden rounded-full bg-panel">
						<div
							className="h-full rounded-full bg-accent transition-[width]"
							style={{ width: `${Math.round(ratio * 100)}%` }}
						/>
					</div>
					<div className="flex items-center gap-2">
						<span className="text-xs text-neutral-400">
							書き出し中… {Math.round(ratio * 100)}%
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
						<span className="text-[11px] text-amber-400">{task.notice}</span>
					)}
				</div>
			)}

			{status === "error" && (
				<p className="text-sm text-danger">
					{task?.error ?? "書き出しに失敗しました。"}
				</p>
			)}
		</div>
	);
}
