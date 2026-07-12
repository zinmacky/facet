import { WEEKDAY_LABELS } from "../../lib/schedule";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { TrashIcon } from "../../components/ui/icons";
import { cn } from "../../components/ui/cn";
import { inputClass } from "./uploadTypes";

interface ScheduleSettingsModalProps {
	open: boolean;
	onClose: () => void;
	startDate: string;
	endDate: string;
	weekdayTimes: Record<number, string[]>;
	note: string | null;
	onStartDate: (v: string) => void;
	onEndDate: (v: string) => void;
	onToggleWeekday: (day: number) => void;
	onAddTime: (day: number) => void;
	onRemoveTime: (day: number, index: number) => void;
	onSetTime: (day: number, index: number, value: string) => void;
	onAssign: () => void;
}

/**
 * 「予約スケジュール」モーダル: 期間・曜日・時刻から予約枠を生成し、
 * Post の並び順へ予約日時を一括割当する。割当は非破壊(publishAt の上書きのみで、
 * 再割当・個別修正がいつでもできる)ため確認ダイアログは挟まない。
 * 割当結果のノート(割当件数・枠不足の警告)を見せるため、割当後もモーダルは
 * 閉じない(「閉じる」/ Esc / オーバーレイクリックで閉じる)。
 */
export function ScheduleSettingsModal(props: ScheduleSettingsModalProps) {
	const selectedDays = Object.keys(props.weekdayTimes)
		.map(Number)
		.sort((a, b) => a - b);

	return (
		<Modal
			open={props.open}
			title="予約スケジュール"
			onClose={props.onClose}
			widthClass="max-w-xl"
			footer={
				<>
					<Button variant="ghost" onClick={props.onClose}>
						閉じる
					</Button>
					<Button variant="primary" size="sm" onClick={props.onAssign}>
						この順で予約日時を割り当て
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center gap-3">
					<label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
						開始日
						<input
							type="date"
							className={inputClass}
							value={props.startDate}
							onChange={(e) => props.onStartDate(e.target.value)}
						/>
					</label>
					<label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
						終了日
						<input
							type="date"
							className={inputClass}
							value={props.endDate}
							onChange={(e) => props.onEndDate(e.target.value)}
						/>
					</label>
				</div>

				<div className="flex items-center gap-1.5">
					<span className="text-[11px] text-neutral-400">曜日</span>
					{WEEKDAY_LABELS.map((label, day) => {
						const active = day in props.weekdayTimes;
						return (
							<button
								key={label}
								type="button"
								onClick={() => props.onToggleWeekday(day)}
								className={cn(
									"h-7 w-7 rounded-md border text-xs transition-colors",
									active
										? "border-accent bg-accent/20 text-accent"
										: "border-line bg-elevated text-neutral-400 hover:border-accent/60",
								)}
							>
								{label}
							</button>
						);
					})}
				</div>

				{/* 曜日ごとの時刻(曜日ごとに異なる複数時刻を設定できる) */}
				{selectedDays.length === 0 ? (
					<p className="text-[11px] text-neutral-400">
						曜日を選ぶと、その曜日の時刻を設定できます。
					</p>
				) : (
					<div className="flex flex-col gap-1.5">
						{selectedDays.map((day) => {
							const list = props.weekdayTimes[day] ?? [];
							return (
								<div key={day} className="flex flex-wrap items-center gap-2">
									<span className="w-5 text-center text-[11px] font-semibold text-accent">
										{WEEKDAY_LABELS[day] ?? ""}
									</span>
									{list.map((time, index) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: 時刻は配列位置で識別され(onSetTime/onRemoveTime が index を使用)安定IDを持たない
										<div key={index} className="flex items-center gap-1">
											<input
												type="time"
												className={inputClass}
												value={time}
												onChange={(e) =>
													props.onSetTime(day, index, e.target.value)
												}
											/>
											{list.length > 1 && (
												<IconButton
													tone="danger"
													aria-label="時刻を削除"
													onClick={() => props.onRemoveTime(day, index)}
												>
													<TrashIcon />
												</IconButton>
											)}
										</div>
									))}
									<Button
										variant="ghost"
										size="sm"
										onClick={() => props.onAddTime(day)}
									>
										+ 時刻
									</Button>
								</div>
							);
						})}
					</div>
				)}

				{props.note && (
					<p className="text-[11px] text-neutral-400">{props.note}</p>
				)}
			</div>
		</Modal>
	);
}
