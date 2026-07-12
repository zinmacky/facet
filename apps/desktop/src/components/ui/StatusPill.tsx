import type { ReactNode } from "react";
import { cn } from "./cn";

/** ステータス表示の色調(意味は呼び出し側が決める: 完了=ok、失敗=danger、進行中=accent、既定=neutral)。 */
export type StatusTone = "neutral" | "ok" | "danger" | "accent";

const TONE_CLASS: Record<StatusTone, string> = {
	neutral: "text-neutral-400",
	ok: "text-ok",
	danger: "text-danger",
	accent: "text-accent",
};

/**
 * 小さなステータステキスト表示の共通ラッパ(色調の切り替えのみを担う薄いコンポーネント)。
 * ExportListItem/ExportPreviewListItem/UploadScreen の StatusBadge など、
 * 「`text-[11px]` + 状態に応じた色」というほぼ同型のインライン実装が複数箇所にあったため共通化した。
 * ラベル文言・状態からトーンへのマッピングは各呼び出し側の意味に依存するため、ここでは持たない。
 */
export function StatusPill({
	tone,
	className,
	children,
}: {
	tone: StatusTone;
	className?: string;
	children: ReactNode;
}) {
	return (
		<span className={cn("text-[11px]", TONE_CLASS[tone], className)}>
			{children}
		</span>
	);
}
