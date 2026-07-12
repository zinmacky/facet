import type { ReactNode } from "react";

/**
 * ▼/▶ + 見出しの流儀に合わせた、小さな折りたたみ表示。
 * 投稿(Phase 3 まで無効)専用のフィールドをまとめて隠すために使う
 * (PostDetail の予約日時・一括投稿、OutputCard のメタデータ・投稿ボタン)。
 */
export function Disclosure({
	title,
	expanded,
	onToggle,
	trailing,
	children,
}: {
	title: string;
	expanded: boolean;
	onToggle: () => void;
	trailing?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="rounded-md border border-line/60 bg-elevated/30 px-2 py-1.5">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={expanded}
				className="flex w-full items-center justify-between gap-1.5 text-left"
			>
				<span className="flex items-center gap-1.5 text-[11px] font-medium text-neutral-300">
					<span className="text-neutral-500">{expanded ? "▼" : "▶"}</span>
					{title}
				</span>
				{trailing}
			</button>
			{expanded && <div className="mt-2 flex flex-col gap-2">{children}</div>}
		</div>
	);
}
