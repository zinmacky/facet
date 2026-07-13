import type { FitMode } from "@facet/core";
import { FIT_OPTIONS, OUTPUT_TARGETS } from "../../types";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { TrashIcon } from "../../components/ui/icons";
import { selectClass } from "./uploadTypes";

interface BulkPresetsModalProps {
	open: boolean;
	onClose: () => void;
	outputPresets: { targetId: string; fit: FitMode }[];
	presetNote: string | null;
	onAddPreset: () => void;
	onRemovePreset: (index: number) => void;
	onSetPreset: (
		index: number,
		patch: Partial<{ targetId: string; fit: FitMode }>,
	) => void;
	onApply: () => void;
}

/**
 * 「一括設定」モーダル: 出力先(ターゲット×フィット)の組み合わせを編集し、
 * 全 Post の出力先へ一括適用する。両エディション共通(投稿系の文言は使わない —
 * 「投稿」ではなく「項目」と表記する、docs/desktop-migration-plan.md の
 * wizard 再構成メモ参照)。適用は破壊的(既存メタデータをリセット)なため、
 * 実際の適用は ReframeScreen 側の `applyPresets` 内で `useConfirm` による確認を挟む。
 * 確認でキャンセルされた場合はこのモーダルを開いたままにする
 * (ReframeScreen 側が applyPresets の戻り値を見て onClose を呼ぶかどうかを決める)。
 */
export function BulkPresetsModal(props: BulkPresetsModalProps) {
	return (
		<Modal
			open={props.open}
			title="一括設定"
			onClose={props.onClose}
			widthClass="max-w-xl"
			footer={
				<>
					<Button variant="ghost" onClick={props.onClose}>
						閉じる
					</Button>
					<Button variant="primary" size="sm" onClick={props.onApply}>
						全ての項目に出力先を適用
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-2">
				<span className="text-[11px] font-medium text-neutral-300">
					出力先の一括設定
				</span>
				<div className="flex flex-col gap-1.5">
					{props.outputPresets.map((preset, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: プリセットは配列位置で識別され(onSetPreset が index を使用)安定IDを持たない
						<div key={index} className="flex items-center gap-2">
							<select
								className={selectClass}
								value={preset.targetId}
								onChange={(e) =>
									props.onSetPreset(index, { targetId: e.target.value })
								}
							>
								{OUTPUT_TARGETS.map((target) => (
									<option key={target.id} value={target.id}>
										{target.label}
									</option>
								))}
							</select>
							<select
								className={selectClass}
								value={preset.fit}
								onChange={(e) =>
									props.onSetPreset(index, {
										fit: e.target.value as FitMode,
									})
								}
							>
								{FIT_OPTIONS.map((opt) => (
									<option key={opt.value} value={opt.value}>
										{opt.label}
									</option>
								))}
							</select>
							{props.outputPresets.length > 1 && (
								<IconButton
									tone="danger"
									size="md"
									aria-label="組み合わせを削除"
									onClick={() => props.onRemovePreset(index)}
								>
									<TrashIcon />
								</IconButton>
							)}
						</div>
					))}
				</div>
				<div className="flex items-center gap-3">
					<Button variant="ghost" size="sm" onClick={props.onAddPreset}>
						+ 組み合わせを追加
					</Button>
					{props.presetNote && (
						<span className="text-[11px] text-neutral-400">
							{props.presetNote}
						</span>
					)}
				</div>
				<p className="text-[11px] text-neutral-400">
					適用すると各項目の出力先をこの組み合わせで作り直します。
				</p>
			</div>
		</Modal>
	);
}
