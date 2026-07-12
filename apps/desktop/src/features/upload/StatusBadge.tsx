import { StatusPill, type StatusTone } from "../../components/ui/StatusPill";
import type { PubStatus, PubStatusKind } from "./uploadTypes";

const LABEL: Record<PubStatusKind, string> = {
	idle: "未投稿",
	rendering: "レンダリング中…",
	publishing: "投稿中…",
	success: "完了",
	error: "エラー",
};

const TONE: Record<PubStatusKind, StatusTone> = {
	idle: "neutral",
	rendering: "accent",
	publishing: "accent",
	success: "ok",
	error: "danger",
};

export function StatusBadge({ status }: { status: PubStatus | undefined }) {
	const kind = status?.kind ?? "idle";
	return (
		<StatusPill tone={TONE[kind]}>
			{LABEL[kind]}
			{kind === "error" && status?.message ? `: ${status.message}` : ""}
		</StatusPill>
	);
}
