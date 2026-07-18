import { StatusPill, type StatusTone } from "../../components/ui/StatusPill";
import type { PubStatus, PubStatusKind } from "./publishSupport";

const LABEL: Record<PubStatusKind, string> = {
	idle: "未投稿",
	rendering: "レンダリング中…",
	publishing: "投稿中…",
	scheduled: "予約済み(scheduler 受理)",
	success: "完了",
	error: "エラー",
};

const TONE: Record<PubStatusKind, StatusTone> = {
	idle: "neutral",
	rendering: "accent",
	publishing: "accent",
	scheduled: "accent",
	success: "ok",
	error: "danger",
};

export function StatusBadge({ status }: { status: PubStatus | undefined }) {
	const kind = status?.kind ?? "idle";
	// "publishing" 中は message に進捗(例: "アップロード中 42%")が入る
	// (`usePublishExtras.ts` の `startIgPublish` onProgress 参照)。error 以外でも表示する。
	return (
		<StatusPill tone={TONE[kind]}>
			{LABEL[kind]}
			{status?.message ? `: ${status.message}` : ""}
		</StatusPill>
	);
}
