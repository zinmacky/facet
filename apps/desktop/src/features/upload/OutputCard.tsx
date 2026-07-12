import type { FitMode } from "@facet/core";
import { useMemo, useState } from "react";
import type { Clip } from "../../types";
import { FIT_OPTIONS, OUTPUT_TARGETS, targetById } from "../../types";
import { convertFileSrc } from "../../lib/tauri";
import type { PreviewState } from "../../lib/usePreview";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { TrashIcon } from "../../components/ui/icons";
import { cn } from "../../components/ui/cn";
import { Disclosure } from "./Disclosure";
import { StatusBadge } from "./StatusBadge";
import {
	PUBLISH_SUPPORTED,
	type PubStatus,
	type UploadOutput,
	type UploadPost,
	inputClass,
	outputSig,
	selectClass,
	textareaClass,
} from "./uploadTypes";

interface OutputCardProps {
	post: UploadPost;
	/** post.clipId の解決済み clip(finalSpec/outputSig に効く trim/crop/aspect を持つ)。 */
	clip: Clip | undefined;
	output: UploadOutput;
	/** 元画面で決めたクロップ比のラベル(由来表示用)。 */
	clipAspectLabel: string;
	canRemove: boolean;
	render: PreviewState | undefined;
	status: PubStatus | undefined;
	busy: boolean;
	onPatch: (patch: Partial<UploadOutput>) => void;
	onRemove: () => void;
	onPreview: () => void;
	onPublish: () => void;
}

export function OutputCard(props: OutputCardProps) {
	const { post, clip, output, render, status, busy } = props;
	const [postSettingsOpen, setPostSettingsOpen] = useState(false);
	const target = useMemo(() => targetById(output.targetId), [output.targetId]);
	const platform = target?.platform;
	// 出力ターゲットのアスペクト比(width/height)。プレビュー枠はこれに追従する。
	const boxRatio = target ? target.width / target.height : 9 / 16;

	// 現在設定と生成済みファイルの整合。fresh=最新、stale=設定変更後で要更新。
	const rendering = render?.rendering ?? false;
	const outputPath = render?.outputPath;
	const sig = outputSig(clip, post, output);
	const fresh = outputPath !== undefined && render?.sig === sig;
	const stale = outputPath !== undefined && render?.sig !== sig;

	return (
		<div className="rounded-lg border border-line bg-panel p-3">
			<div className="flex items-start gap-3">
				{/* 左: 出力先アスペクトに追従する固定プレビュー枠 */}
				<div className="flex w-72 shrink-0 flex-col gap-1.5">
					<div className="flex items-center justify-between">
						<span className="text-[11px] text-neutral-400">
							最終プレビュー
							{stale && <span className="ml-1 text-amber-700 dark:text-amber-400">(要更新)</span>}
						</span>
						{fresh && outputPath && (
							<a
								href={convertFileSrc(outputPath)}
								download
								className="text-[11px] text-accent hover:underline"
							>
								DL
							</a>
						)}
					</div>

					<div className="flex h-[32vh] w-full items-center justify-center rounded-lg bg-elevated/40">
						<div
							style={{ aspectRatio: boxRatio }}
							className="flex h-full max-w-full items-center justify-center overflow-hidden rounded-md border border-line bg-black/5 dark:bg-black/40"
						>
							{outputPath ? (
								/* biome-ignore lint/a11y/useMediaCaption: 投稿確認用のプレビューで字幕データが存在しない */
								<video
									src={convertFileSrc(outputPath)}
									controls
									className={cn(
										"h-full w-full object-contain",
										stale && "opacity-60",
									)}
								/>
							) : (
								<p className="max-w-[75%] text-center text-[11px] text-neutral-500">
									「プレビュー生成」で最終アスペクト・フィットを確認できます。
								</p>
							)}
						</div>
					</div>

					<Button
						variant="ghost"
						size="sm"
						className="w-full"
						onClick={props.onPreview}
						disabled={rendering || busy}
					>
						{rendering
							? "生成中…"
							: outputPath
								? "プレビュー更新"
								: "プレビュー生成"}
					</Button>
					{render?.error && (
						<p className="text-[11px] text-danger">{render.error}</p>
					)}
				</div>

				{/* 右: 出力ターゲット・フィット + 投稿設定(折りたたみ) */}
				<div className="flex min-w-0 flex-1 flex-col gap-2">
					<div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
						<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
							出力ターゲット
							<select
								className={selectClass}
								value={output.targetId}
								onChange={(e) => props.onPatch({ targetId: e.target.value })}
							>
								{OUTPUT_TARGETS.map((t) => (
									<option key={t.id} value={t.id}>
										{t.label}
									</option>
								))}
							</select>
						</label>

						<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
							フィット
							<select
								className={selectClass}
								value={output.fit}
								onChange={(e) =>
									props.onPatch({ fit: e.target.value as FitMode })
								}
							>
								{FIT_OPTIONS.map((opt) => (
									<option key={opt.value} value={opt.value}>
										{opt.label}
									</option>
								))}
							</select>
						</label>

						{props.canRemove && (
							<IconButton
								tone="danger"
								size="md"
								aria-label="出力先を削除"
								onClick={props.onRemove}
							>
								<TrashIcon />
							</IconButton>
						)}
					</div>

					<p className="text-[11px] leading-snug text-neutral-400">
						元クロップ{" "}
						<span className="font-medium text-neutral-200">
							{props.clipAspectLabel}
						</span>{" "}
						を、選んだ出力先アスペクトへ「
						{FIT_OPTIONS.find((o) => o.value === output.fit)?.label ??
							output.fit}
						」で合わせます。
					</p>

					{/* 投稿専用フィールド(メタデータ・投稿ボタン・ステータス)。
					    Phase 3 まで投稿自体が無効なため、既定で折りたたむ。 */}
					<Disclosure
						title="投稿設定"
						expanded={postSettingsOpen}
						onToggle={() => setPostSettingsOpen((v) => !v)}
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

						<div className="flex justify-end">
							<Button
								variant="primary"
								size="sm"
								onClick={props.onPublish}
								disabled={busy || !PUBLISH_SUPPORTED}
								title={
									PUBLISH_SUPPORTED
										? undefined
										: "デスクトップ版では未対応(Phase 3 で対応予定)"
								}
							>
								投稿
							</Button>
						</div>
					</Disclosure>
				</div>
			</div>
		</div>
	);
}
