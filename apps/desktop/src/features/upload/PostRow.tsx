import type { Clip } from "../../types";
import { msToLocalInput } from "../../lib/schedule";
import { IconButton } from "../../components/ui/IconButton";
import { ChevronDownIcon, ChevronUpIcon, TrashIcon } from "../../components/ui/icons";
import { cn } from "../../components/ui/cn";
import type { UploadPost } from "./uploadTypes";

interface PostRowProps {
	post: UploadPost;
	index: number;
	total: number;
	clips: Clip[];
	selected: boolean;
	onSelect: () => void;
	onMove: (dir: -1 | 1) => void;
	onRemove: () => void;
}

export function PostRow(props: PostRowProps) {
	const { post, index, total, clips, selected } = props;
	const clipName =
		clips.find((c) => c.id === post.clipId)?.name ?? "(不明な clip)";
	const scheduleLabel =
		post.publishAt !== undefined
			? msToLocalInput(post.publishAt).replace("T", " ")
			: "即時";

	return (
		// biome-ignore lint/a11y/useSemanticElements: 上へ/下へ/削除ボタンを内包する選択カードのため native button 化できない
		<div
			role="button"
			tabIndex={0}
			onClick={props.onSelect}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					props.onSelect();
				}
			}}
			className={cn(
				"cursor-pointer rounded-md border p-2 transition-colors",
				selected
					? "border-accent bg-accent/10"
					: "border-line bg-panel hover:border-accent/60",
			)}
		>
			<div className="flex items-start justify-between gap-1">
				<div className="min-w-0">
					<div className="flex items-center gap-1.5">
						<span className="text-[11px] font-medium text-neutral-400">
							#{index + 1}
						</span>
						<span
							className="truncate text-xs text-neutral-200"
							title={clipName}
						>
							{clipName}
						</span>
					</div>
					<div className="mt-0.5 flex items-center gap-1.5">
						<span
							className="truncate text-[11px] text-neutral-400"
							title={scheduleLabel}
						>
							{scheduleLabel}
						</span>
						<span className="shrink-0 rounded bg-elevated px-1 text-[11px] text-neutral-300">
							{post.outputs.length} 出力
						</span>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<IconButton
						aria-label="上へ"
						disabled={index === 0}
						onClick={(e) => {
							e.stopPropagation();
							props.onMove(-1);
						}}
					>
						<ChevronUpIcon />
					</IconButton>
					<IconButton
						aria-label="下へ"
						disabled={index === total - 1}
						onClick={(e) => {
							e.stopPropagation();
							props.onMove(1);
						}}
					>
						<ChevronDownIcon />
					</IconButton>
					<IconButton
						tone="danger"
						aria-label="削除"
						onClick={(e) => {
							e.stopPropagation();
							props.onRemove();
						}}
					>
						<TrashIcon />
					</IconButton>
				</div>
			</div>
		</div>
	);
}
