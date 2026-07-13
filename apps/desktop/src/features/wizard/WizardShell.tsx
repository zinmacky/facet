import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

/** ウィザードで使いうる全ステップ。順序はスライドの左→右と一致する。 */
export const WIZARD_STEPS_PRIVATE = ["edit", "export", "upload"] as const;
/** public(配布版)のステップ構成: 投稿(アップロード)ステップを持たない2 step。 */
export const WIZARD_STEPS_PUBLIC = ["edit", "export"] as const;
export type WizardStep = (typeof WIZARD_STEPS_PRIVATE)[number];

interface WizardShellProps {
	/** edition に応じたステップ構成(App.tsx が EDITION から選ぶ)。 */
	steps: readonly WizardStep[];
	step: WizardStep;
	/**
	 * 各ステップの内容。`steps` に含まれるものは常時マウントする(ジョブ購読の
	 * 生存を維持するため)。`steps` に含まれないキー(例: public 版の "upload")は
	 * 渡されていてもレンダリングされない。
	 */
	panels: Partial<Record<WizardStep, ReactNode>>;
}

/**
 * ウィザードの複数画面(edition により edit→export の2画面、または
 * edit→export→upload の3画面)を横スライドで切り替える外枠。
 *
 * `steps` に含まれる画面は常時マウントしたまま(条件付きレンダリングは絶対禁止 —
 * 各画面が持つジョブ購読(unsubsRef 等)がコンポーネント生存に依存しているため、
 * マウント/アンマウントを繰り返すと購読が切れてしまう)、CSS transform で
 * スライドさせる。非アクティブな画面は `inert` + `aria-hidden` でフォーカス・
 * 操作から隔離する。
 */
export function WizardShell({ steps, step, panels }: WizardShellProps) {
	const index = steps.indexOf(step);
	const count = steps.length;

	return (
		<div className="relative min-h-0 flex-1 overflow-hidden">
			<div
				className="flex h-full motion-safe:transition-transform motion-safe:duration-[220ms] motion-safe:ease-out"
				style={{
					width: `${count * 100}%`,
					transform: `translateX(-${index * (100 / count)}%)`,
				}}
			>
				{steps.map((s) => (
					<WizardPanel key={s} active={s === step} count={count}>
						{panels[s]}
					</WizardPanel>
				))}
			</div>
		</div>
	);
}

function WizardPanel({
	active,
	count,
	children,
}: {
	active: boolean;
	count: number;
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
			className="h-full min-w-0 shrink-0"
			style={{ width: `${100 / count}%` }}
		>
			{children}
		</div>
	);
}
