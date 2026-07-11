import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

/** ウィザードの3画面。順序はスライドの左→右と一致する。 */
export const WIZARD_STEPS = ["edit", "export", "upload"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

interface WizardShellProps {
	step: WizardStep;
	/** 各ステップの内容。3画面とも常時マウントする(ジョブ購読の生存を維持するため)。 */
	panels: Record<WizardStep, ReactNode>;
}

/**
 * 編集/書き出し/アップロードの3画面を横スライドで切り替えるウィザードの外枠。
 *
 * 3画面は常時マウントしたまま(条件付きレンダリングは絶対禁止 — 各画面が持つ
 * ジョブ購読(unsubsRef 等)がコンポーネント生存に依存しているため、マウント/
 * アンマウントを繰り返すと購読が切れてしまう)、CSS transform でスライドさせる。
 * 非アクティブな画面は `inert` + `aria-hidden` でフォーカス・操作から隔離する。
 */
export function WizardShell({ step, panels }: WizardShellProps) {
	const index = WIZARD_STEPS.indexOf(step);

	return (
		<div className="relative min-h-0 flex-1 overflow-hidden">
			<div
				className="flex h-full motion-safe:transition-transform motion-safe:duration-[220ms] motion-safe:ease-out"
				style={{
					width: "300%",
					transform: `translateX(-${index * (100 / 3)}%)`,
				}}
			>
				{WIZARD_STEPS.map((s) => (
					<WizardPanel key={s} active={s === step}>
						{panels[s]}
					</WizardPanel>
				))}
			</div>
		</div>
	);
}

function WizardPanel({
	active,
	children,
}: {
	active: boolean;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);

	// @types/react18 に inert prop が無いため、DOM プロパティとして直接設定する。
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.inert = !active;
	}, [active]);

	return (
		<div
			ref={ref}
			aria-hidden={!active}
			className="h-full w-1/3 min-w-0 shrink-0"
		>
			{children}
		</div>
	);
}
