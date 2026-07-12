import type { Clip } from "../../types";
import type { ReframeTaskState } from "../../lib/useReframeQueue";
import { formatTime } from "../../lib/format";
import { cn } from "../../components/ui/cn";
import { StatusPill, type StatusTone } from "../../components/ui/StatusPill";
import { Button } from "../../components/ui/Button";

/** 右側一覧の 1 行(clip 名 + ステータス + 要再書き出し/失敗時の(再)実行ボタン)。 */
export function ExportListItem({
	clip,
	task,
	selected,
	onSelect,
	dirty,
	cancelling,
	onExport,
}: {
	clip: Clip;
	task: ReframeTaskState | undefined;
	selected: boolean;
	onSelect: () => void;
	/** true = sig 変更で結果が破棄済み(編集後の要再書き出し)。 */
	dirty: boolean;
	/** true = 旧ジョブの reframe_cancel 完了待ち((再)実行ボタンを disabled にする)。 */
	cancelling: boolean;
	/**
	 * 「(再)実行」ボタン押下時。task が無い clip(未書き出し/要再書き出し)、または
	 * status="error" の clip(失敗 → 再試行)でのみボタンを表示する。
	 */
	onExport: () => void;
}) {
	// task が undefined = まだ一度もキューに乗っていない(自動再書き出しの廃止により、
	// 「新規追加されて未書き出し」または「編集により要再書き出し(dirty)」のどちらかで
	// 持続しうる — 以前のように「起動 effect にこれから拾われる一瞬だけの状態」ではない)。
	const pending = task === undefined;
	const status = task?.status ?? "running";
	const ratio = task?.ratio ?? 0;
	const length = Math.max(0, clip.trim.end - clip.trim.start);
	const tone: StatusTone =
		status === "done" ? "ok" : status === "error" ? "danger" : "neutral";
	// 失敗(error)は自動リトライが無くなったため、明示的な再試行手段が無いと
	// 一過性の失敗(エンコーダの瞬断など)から復帰できなくなる。dirty/未書き出しと
	// 同じボタンを流用し、error のときだけ文言を「再試行」にする。
	const showActionButton = pending || status === "error";
	const actionLabel = status === "error" ? "再試行" : dirty ? "再書き出し" : "書き出す";

	return (
		<div
			className={cn(
				"flex flex-col gap-1.5 rounded-md border px-2 py-1.5 transition-colors",
				selected
					? "border-accent bg-accent/10"
					: "border-transparent hover:bg-elevated",
			)}
		>
			{/* 選択操作はこの内側 button に閉じる(外側 div に直接 button を重ねると、
			下の「(再)書き出し」ボタンとネストしてしまうため分離した)。 */}
			<button type="button" onClick={onSelect} className="flex flex-col gap-1 text-left">
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
								className="rounded bg-amber-400/15 px-1 text-[11px] font-medium text-amber-700 dark:text-amber-400"
								title={task.notice}
							>
								SW
							</span>
						)}
						<StatusPill tone={dirty ? "accent" : tone}>
							{pending
								? dirty
									? "要再書き出し"
									: "未書き出し"
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
			{showActionButton && (
				<Button
					size="sm"
					variant="secondary"
					disabled={cancelling}
					onClick={onExport}
					aria-label={`${actionLabel}: ${clip.name}.mp4`}
					className="self-start"
				>
					{cancelling ? "キャンセル待ち…" : actionLabel}
				</Button>
			)}
		</div>
	);
}
