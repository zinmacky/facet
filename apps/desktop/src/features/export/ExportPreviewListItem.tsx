import type { Clip } from "../../types";
import type { PreviewState } from "../../lib/usePreview";
import { formatTime } from "../../lib/format";
import { cn } from "../../components/ui/cn";

/** 右側一覧の 1 行(clip 名 + プレビュー生成状態)。「書き出しを開始」前の画面用。 */
export function ExportPreviewListItem({
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
