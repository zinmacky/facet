import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Clip } from "../../types";
import { masterSpec } from "../../types";
import type { ExportEvent, ProbeResult } from "../../lib/api";
import {
	downloadZip,
	fileDownloadUrl,
	fileRawUrl,
	postExport,
	subscribeExport,
} from "../../lib/api";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { cn } from "../../components/ui/cn";

interface ExportModalProps {
	open: boolean;
	source: { inputPath: string; probe: ProbeResult } | null;
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
	/** フォールバック等の一時通知(例: ソフトウェアエンコードで再試行中)。 */
	notice?: string;
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
	// 全 clip の ffmpeg を走らせて CPU を占有しないため)。
	const [started, setStarted] = useState(false);

	// マスター/詳細レイアウトの選択中 clip。
	const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

	// 結果を effect から参照するためのミラー(再購読トリガにしないため ref で持つ)。
	const resultsRef = useRef<Map<string, TaskState>>(results);
	resultsRef.current = results;

	// clipId ごとの購読解除関数。
	const unsubsRef = useRef<Map<string, () => void>>(new Map());

	// clips の入れ替え時は古い結果・購読を破棄する。
	// biome-ignore lint/correctness/useExhaustiveDependencies: clips は本文で参照しないが入れ替え検知のトリガとして意図的に指定
	useEffect(() => {
		for (const unsub of unsubsRef.current.values()) unsub();
		unsubsRef.current.clear();
		resultsRef.current = new Map();
		setResults(new Map());
		// clips が入れ替わったら再度「開始」を要求する。
		setStarted(false);
	}, [clips]);

	// レンダリング開始。開始操作後・open・source があり、done 結果を持たない clip のみ対象。
	useEffect(() => {
		if (!started || !open || !source) return;
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
			const output = `${clip.name}.mp4`;

			const update = (patch: Partial<TaskState>) => {
				setResults((prev) => {
					const next = new Map(prev);
					const cur = next.get(clip.id) ?? { status: "running", ratio: 0 };
					next.set(clip.id, { ...cur, ...patch });
					return next;
				});
			};

			const onEvent = (event: ExportEvent) => {
				if (event.type === "progress") {
					update({
						status: "running",
						ratio: event.ratio,
						...(event.fps !== undefined ? { fps: event.fps } : {}),
					});
				} else if (event.type === "notice") {
					update({ notice: event.message });
				} else if (event.type === "done") {
					update({ status: "done", ratio: 1, outputPath: event.outputPath });
				} else {
					update({ status: "error", error: event.message });
				}
			};

			void postExport({ spec, input, output })
				.then(({ jobId }) => {
					const unsub = subscribeExport(jobId, {
						onEvent,
						onError: () =>
							update({ status: "error", error: "進捗の購読に失敗しました。" }),
					});
					unsubsRef.current.set(clip.id, unsub);
				})
				.catch((err: unknown) => {
					unsubsRef.current.delete(clip.id);
					update({
						status: "error",
						error: err instanceof Error ? err.message : String(err),
					});
				});
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

	const zipMutation = useMutation({
		mutationFn: () => downloadZip(donePaths, "facet-export.zip"),
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
				<div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
					<p className="max-w-sm text-sm text-neutral-300">
						{clips.length}{" "}
						本の切り抜きをマスター動画(クロップ内容そのもの)として
						書き出します。開始すると各切り抜きのレンダリングを順次実行します。
					</p>
					<Button
						variant="primary"
						disabled={clips.length === 0}
						onClick={() => setStarted(true)}
					>
						書き出しを開始({clips.length}本)
					</Button>
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
								disabled={
									donePaths.length === 0 || zipMutation.status === "pending"
								}
								onClick={() => zipMutation.mutate()}
							>
								{zipMutation.status === "pending"
									? "圧縮中…"
									: "一括ダウンロード(ZIP)"}
							</Button>
							<span className="text-[11px] text-neutral-400">
								完了 {donePaths.length} / {clips.length} 件
							</span>
							{zipMutation.isError && (
								<span className="text-xs text-danger">
									ZIP 失敗: {(zipMutation.error as Error).message}
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
						src={fileRawUrl(task.outputPath)}
						className="max-h-[46vh] w-full rounded bg-black"
					/>
					<a
						href={fileDownloadUrl(task.outputPath)}
						download
						className="inline-flex h-7 w-fit items-center justify-center rounded-md bg-elevated px-2.5 text-xs font-medium text-neutral-200 hover:bg-line"
					>
						ダウンロード
					</a>
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
					<span className="text-xs text-neutral-400">
						書き出し中… {Math.round(ratio * 100)}%
					</span>
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
