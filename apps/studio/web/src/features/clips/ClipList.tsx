import type { Clip } from "../../types";
import { formatTime } from "../../lib/format";
import { cn } from "../../components/ui/cn";

interface ClipListProps {
	clips: Clip[];
	selectedClipId: string | null;
	onSelect: (id: string) => void;
	onRemove: (id: string) => void;
	onChange: (clip: Clip) => void;
}

/**
 * 切り抜き一覧。各行で名前の inline 編集・選択・削除を行う。
 * クロップ比と長さはバッジで表示する(詳細編集は ClipEditor)。
 * 追加ボタンは Clips カードのヘッダ側に置く。
 */
export function ClipList({
	clips,
	selectedClipId,
	onSelect,
	onRemove,
	onChange,
}: ClipListProps) {
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
			{clips.length === 0 && (
				<p className="px-1 py-2 text-xs text-neutral-600">
					切り抜きがありません。＋で追加してください。
				</p>
			)}

			{clips.map((clip) => (
				<ClipRow
					key={clip.id}
					clip={clip}
					selected={clip.id === selectedClipId}
					onSelect={() => onSelect(clip.id)}
					onRemove={() => onRemove(clip.id)}
					onChange={onChange}
				/>
			))}
		</div>
	);
}

function ClipRow({
	clip,
	selected,
	onSelect,
	onRemove,
	onChange,
}: {
	clip: Clip;
	selected: boolean;
	onSelect: () => void;
	onRemove: () => void;
	onChange: (clip: Clip) => void;
}) {
	const length = Math.max(0, clip.trim.end - clip.trim.start);
	return (
		// biome-ignore lint/a11y/useSemanticElements: input/button を内包する選択カードのため native button 化できない
		<div
			role="button"
			tabIndex={0}
			onClick={onSelect}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect();
				}
			}}
			className={cn(
				"flex cursor-pointer flex-col gap-2 rounded-md border p-2.5 transition-colors",
				selected
					? "border-accent bg-accent/10"
					: "border-line bg-elevated hover:border-neutral-600",
			)}
		>
			<div className="flex items-center gap-2">
				<input
					value={clip.name}
					onClick={(e) => e.stopPropagation()}
					onChange={(e) => onChange({ ...clip, name: e.target.value })}
					placeholder="切り抜き名"
					className="h-7 flex-1 rounded border border-line bg-panel px-2 font-mono text-xs text-neutral-200 outline-none focus:border-accent"
				/>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					aria-label="削除"
					title="削除"
					className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-panel text-neutral-500 hover:border-danger hover:bg-danger/15 hover:text-danger"
				>
					<svg
						width="12"
						height="12"
						viewBox="0 0 12 12"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						aria-hidden="true"
					>
						<path d="M2.5 6h7" strokeLinecap="round" />
					</svg>
				</button>
			</div>

			<div className="flex items-center gap-2 text-[11px] text-neutral-500">
				<span className="rounded bg-panel px-1.5 py-0.5 font-medium text-neutral-400">
					{clip.aspect === "free" ? "自由" : clip.aspect}
				</span>
				<span className="font-mono tabular-nums">{formatTime(length)}</span>
			</div>
		</div>
	);
}
