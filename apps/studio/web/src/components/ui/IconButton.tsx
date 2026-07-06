import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

type Tone = "default" | "accent" | "danger";
type Size = "sm" | "md";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	/** ホバー時の色調。default=中立 / accent=強調 / danger=削除。 */
	tone?: Tone;
	/** sm=28px / md=32px。タッチターゲット確保のため 28px を下限とする。 */
	size?: Size;
}

const TONE: Record<Tone, string> = {
	default: "text-neutral-400 hover:border-neutral-500 hover:text-neutral-100",
	accent: "text-neutral-300 hover:border-accent hover:text-accent",
	danger:
		"text-neutral-400 hover:border-danger hover:bg-danger/15 hover:text-danger",
};

const SIZE: Record<Size, string> = {
	sm: "h-7 w-7",
	md: "h-8 w-8",
};

/**
 * アイコン専用ボタン。focus ring・最小タッチターゲット・tone をアプリ全体で統一する。
 * 形状(角丸)は className で上書き可能(既定 rounded-md)。
 */
export function IconButton({
	tone = "default",
	size = "sm",
	className,
	type = "button",
	...rest
}: IconButtonProps) {
	return (
		<button
			type={type}
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-md border border-line bg-elevated",
				"transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
				"disabled:pointer-events-none disabled:opacity-40",
				SIZE[size],
				TONE[tone],
				className,
			)}
			{...rest}
		/>
	);
}
