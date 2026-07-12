import type { Clip } from "../../types";
import type { ReframeTaskState } from "../../lib/useReframeQueue";
import { formatTime } from "../../lib/format";
import { cn } from "../../components/ui/cn";
import { StatusPill, type StatusTone } from "../../components/ui/StatusPill";

/** 右側一覧の 1 行(clip 名 + ステータス)。 */
export function ExportListItem({
	clip,
	task,
	selected,
	onSelect,
}: {
	clip: Clip;
	task: ReframeTaskState | undefined;
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
	const tone: StatusTone =
		status === "done" ? "ok" : status === "error" ? "danger" : "neutral";

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
					<StatusPill tone={tone}>
						{pending
							? "待機中"
							: status === "done"
								? "完了"
								: status === "error"
									? "失敗"
									: `${Math.round(ratio * 100)}%`}
					</StatusPill>
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
