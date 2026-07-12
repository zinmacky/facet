import { cn } from "../../components/ui/cn";
import type { WizardStep } from "./WizardShell";
import { WIZARD_STEPS } from "./WizardShell";

/** 書き出し画面の進捗サマリ(ExportScreen から onProgressSummary で押し上げる)。 */
export interface ExportSummary {
	total: number;
	done: number;
	running: number;
}

const STEP_LABELS: Record<WizardStep, string> = {
	edit: "編集",
	export: "書き出し",
	upload: "アップロード",
};

interface StepIndicatorProps {
	step: WizardStep;
	/** "export" へ前進してよいか(既定条件: !!source && clips.length > 0)。 */
	canGoExport: boolean;
	/** "upload" へ前進してよいか(既定条件: clips.length > 0)。 */
	canGoUpload: boolean;
	/** true の間は現在ステップ以外への遷移をすべて禁止する(投稿処理中の離脱抑止用)。 */
	locked?: boolean;
	exportSummary?: ExportSummary;
	onSelect: (step: WizardStep) => void;
}

/**
 * 編集/書き出し/アップロードの3ステップを示すバッジ列。
 * 後退クリックは常時可能。前進クリックは対応する canGoXxx が true のときのみ許可する
 * (locked が true の間は現在ステップ以外すべて禁止)。
 */
export function StepIndicator({
	step,
	canGoExport,
	canGoUpload,
	locked = false,
	exportSummary,
	onSelect,
}: StepIndicatorProps) {
	const currentIndex = WIZARD_STEPS.indexOf(step);

	return (
		<nav className="flex items-center gap-1" aria-label="編集ステップ">
			{WIZARD_STEPS.map((s, i) => {
				const active = s === step;
				const backward = i <= currentIndex;
				const forwardAllowed =
					s === "export" ? canGoExport : s === "upload" ? canGoUpload : true;
				const allowed = active || (!locked && (backward || forwardAllowed));

				return (
					<div key={s} className="flex items-center gap-1">
						{i > 0 && <span className="text-neutral-600">›</span>}
						<button
							type="button"
							disabled={!allowed}
							onClick={() => onSelect(s)}
							aria-current={active ? "step" : undefined}
							className={cn(
								"flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
								active
									? "bg-accent/15 text-accent"
									: allowed
										? "text-neutral-300 hover:bg-elevated"
										: "text-neutral-600",
								"disabled:cursor-not-allowed",
							)}
						>
							<span
								className={cn(
									"flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
									active
										? "border-accent text-accent"
										: "border-neutral-600 text-neutral-500",
								)}
							>
								{i + 1}
							</span>
							{STEP_LABELS[s]}
							{s === "export" &&
								exportSummary !== undefined &&
								exportSummary.total > 0 &&
								(exportSummary.done > 0 || exportSummary.running > 0) && (
									<span className="rounded bg-elevated px-1 text-[10px] text-neutral-400">
										{exportSummary.done}/{exportSummary.total}
									</span>
								)}
						</button>
					</div>
				);
			})}
		</nav>
	);
}
