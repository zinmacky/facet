import { useState } from "react";
import type { OutputTarget } from "../../types";
import { Button } from "../../components/ui/Button";
import { cn } from "../../components/ui/cn";
import { Disclosure } from "./Disclosure";
import { StatusBadge } from "./StatusBadge";
import type { PubStatus } from "./publishSupport";
import { inputClass, textareaClass, type UploadOutput } from "./uploadTypes";

interface OutputPublishSectionProps {
	output: UploadOutput;
	platform: OutputTarget["platform"] | undefined;
	status: PubStatus | undefined;
	busy: boolean;
	/** この Output への投稿ボタンを有効化してよいか(コード対応 + 実行時ゲート)。 */
	canPublish: boolean;
	onPatch: (patch: Partial<UploadOutput>) => void;
	onPublish: () => void;
	/** 進行中(レンダリング/投稿中)の処理をキャンセルする(Issue #95、任意の UI 導線)。 */
	onCancel: () => void;
}

/**
 * OutputCard に差し込む「投稿設定」の折りたたみ(メタデータ入力欄・投稿ボタン・
 * ステータス)。private エディション専用(§usePublishExtras.ts の
 * `renderOutputSection`)。OutputCard.tsx 本体から抽出した
 * (旧: OutputCard.tsx の同名 Disclosure、§docs/desktop-migration-plan.md の
 * wizard 再構成メモ)。リフレーム画面の主目的(書き出し)を妨げないよう、既定で折りたたむ。
 */
export function OutputPublishSection(props: OutputPublishSectionProps) {
	const { output, platform, status, busy } = props;
	const [expanded, setExpanded] = useState(false);

	return (
		<Disclosure
			title="投稿設定"
			expanded={expanded}
			onToggle={() => setExpanded((v) => !v)}
			trailing={<StatusBadge status={status} />}
		>
			{platform === "youtube" ? (
				<>
					<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
						タイトル
						<input
							type="text"
							className={cn(inputClass, "w-full")}
							value={output.title}
							onChange={(e) => props.onPatch({ title: e.target.value })}
						/>
					</label>
					<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
						説明
						<textarea
							className={cn(textareaClass, "min-h-[96px] resize-y")}
							value={output.description}
							onChange={(e) =>
								props.onPatch({ description: e.target.value })
							}
						/>
					</label>
				</>
			) : (
				<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
					キャプション
					<textarea
						className={cn(textareaClass, "min-h-[96px] resize-y")}
						maxLength={2200}
						value={output.caption}
						onChange={(e) => props.onPatch({ caption: e.target.value })}
					/>
				</label>
			)}

			<div className="flex justify-end gap-2">
				{(status?.kind === "rendering" || status?.kind === "publishing") && (
					<Button variant="ghost" size="sm" onClick={props.onCancel}>
						キャンセル
					</Button>
				)}
				<Button
					variant="primary"
					size="sm"
					onClick={props.onPublish}
					disabled={busy || !props.canPublish}
					title={
						props.canPublish
							? undefined
							: platform === "instagram"
								? "設定(scheduler + R2)が必要です"
								: "設定(Google との接続)が必要です"
					}
				>
					投稿
				</Button>
			</div>
		</Disclosure>
	);
}
