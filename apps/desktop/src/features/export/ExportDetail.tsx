import type { Clip } from "../../types";
import { aspectRatio } from "../../types";
import { cancelJob, convertFileSrc } from "../../lib/tauri";
import type { ReframeTaskState } from "../../lib/useReframeQueue";
import { Button } from "../../components/ui/Button";

/** 中央: 選択中 clip 1 本ぶんの書き出し詳細。 */
export function ExportDetail({
	clip,
	task,
}: {
	clip: Clip;
	task: ReframeTaskState | undefined;
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
					className="flex w-full items-center justify-center overflow-hidden rounded-lg border border-line bg-black/5 dark:bg-black/40"
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
								<span className="text-[11px] text-amber-700 dark:text-amber-400">
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
