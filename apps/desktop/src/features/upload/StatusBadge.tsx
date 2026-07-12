import { cn } from "../../components/ui/cn";
import type { PubStatus, PubStatusKind } from "./uploadTypes";

export function StatusBadge({ status }: { status: PubStatus | undefined }) {
	const kind = status?.kind ?? "idle";
	const label: Record<PubStatusKind, string> = {
		idle: "未投稿",
		rendering: "レンダリング中…",
		publishing: "投稿中…",
		success: "完了",
		error: "エラー",
	};
	const tone: Record<PubStatusKind, string> = {
		idle: "text-neutral-400",
		rendering: "text-accent",
		publishing: "text-accent",
		success: "text-ok",
		error: "text-danger",
	};
	return (
		<span className={cn("text-[11px]", tone[kind])}>
			{label[kind]}
			{kind === "error" && status?.message ? `: ${status.message}` : ""}
		</span>
	);
}
