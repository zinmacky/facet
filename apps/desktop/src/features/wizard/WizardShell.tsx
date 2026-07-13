import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

/**
 * ウィザードのステップ(編集/確認/リフレーム)。順序はスライドの左→右と一致する。
 * 両エディション共通(v2.4 時点では public 版がリフレーム=投稿ステップを持たない
 * 2 step 構成だったが、リフレーム機能自体は両エディション共通のため 3 step に統一した
 * — 投稿系 UI の有無はステップ数ではなく各画面内の描画で出し分ける、
 * §features/upload/ReframeScreen.tsx の `PublishSlots`)。
 */
export const WIZARD_STEPS = ["edit", "export", "upload"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

interface WizardShellProps {
	steps: readonly WizardStep[];
	step: WizardStep;
	/** 各ステップの内容。`steps` に含まれるものは常時マウントする(ジョブ購読の生存を維持するため)。 */
	panels: Partial<Record<WizardStep, ReactNode>>;
}

/**
 * ウィザードの3画面(編集/確認/リフレーム)を横スライドで切り替える外枠。
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
