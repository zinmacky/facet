import { useState } from "react";
import type { Clip } from "../../types";
import type { PreviewState } from "../../lib/usePreview";
import { localInputToMs, msToLocalInput } from "../../lib/schedule";
import { Button } from "../../components/ui/Button";
import { Disclosure } from "./Disclosure";
import { OutputCard } from "./OutputCard";
import {
	type PubStatus,
	type UploadOutput,
	type UploadPost,
	inputClass,
	selectClass,
} from "./uploadTypes";

interface PostDetailProps {
	post: UploadPost;
	clips: Clip[];
	renders: Map<string, PreviewState>;
	pubStatuses: Map<string, PubStatus>;
	busy: boolean;
	/** `output` への投稿ボタンを有効化してよいか(コード対応 + 実行時ゲート、`UploadScreen.tsx` の `canPublishTarget`)。 */
	canPublishOutput: (output: UploadOutput) => boolean;
	onPatchPost: (patch: Partial<UploadPost>) => void;
	onPatchOutput: (outputId: string, patch: Partial<UploadOutput>) => void;
	onAddOutput: () => void;
	onRemoveOutput: (outputId: string) => void;
	onPreviewOutput: (output: UploadOutput) => void;
	onPublishOutput: (output: UploadOutput) => void;
	onPublishPost: () => void;
}

export function PostDetail(props: PostDetailProps) {
	const { post, clips, busy } = props;
	const [scheduleOpen, setScheduleOpen] = useState(false);
	const postClip = clips.find((c) => c.id === post.clipId);
	// 「この投稿をすべて投稿」はいずれかの Output が投稿可能なら有効化する。
	const anyOutputPublishable = post.outputs.some(props.canPublishOutput);
	// 元画面で決めたクロップ比。出力先アスペクトとの関係を示すために表示する。
	const clipAspectLabel = postClip
		? postClip.aspect === "free"
			? "自由"
			: postClip.aspect
		: "—";
	const datetimeValue =
		post.publishAt !== undefined ? msToLocalInput(post.publishAt) : "";
	const scheduleLabel =
		post.publishAt !== undefined
			? msToLocalInput(post.publishAt).replace("T", " ")
			: "即時";

	const onDatetimeChange = (value: string) => {
		const ms = localInputToMs(value);
		props.onPatchPost(
			ms !== null ? { publishAt: ms } : { publishAt: undefined },
		);
	};

	return (
		<div className="flex flex-col gap-3">
			{/* 投稿ヘッダ: 対象 clip(常時表示)+ 予約日時・一括投稿(折りたたみ) */}
			<div className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3">
				<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
					対象 clip
					<select
						className={selectClass}
						value={post.clipId}
						onChange={(e) => props.onPatchPost({ clipId: e.target.value })}
					>
						{clips.map((clip) => (
							<option key={clip.id} value={clip.id}>
								{clip.name}
							</option>
						))}
					</select>
				</label>

				<Disclosure
					title="投稿設定(予約日時・一括投稿)"
					expanded={scheduleOpen}
					onToggle={() => setScheduleOpen((v) => !v)}
					trailing={
						<span className="text-[11px] text-neutral-400">
							{scheduleLabel}
						</span>
					}
				>
					<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
						予約日時(未指定=即時)
						<input
							type="datetime-local"
							className={inputClass}
							value={datetimeValue}
							onChange={(e) => onDatetimeChange(e.target.value)}
						/>
					</label>
					<div className="flex justify-end">
						<Button
							variant="primary"
							size="sm"
							onClick={props.onPublishPost}
							disabled={busy || !anyOutputPublishable}
							title={
								anyOutputPublishable
									? undefined
									: "投稿可能な出力先がありません"
							}
						>
							この投稿をすべて投稿
						</Button>
					</div>
				</Disclosure>
			</div>

			{/* 出力先(Output)一覧 */}
			<div className="flex flex-col gap-2">
				<span className="text-[11px] font-semibold text-neutral-300">
					出力先
				</span>
				{post.outputs.map((output) => (
					<OutputCard
						key={output.id}
						post={post}
						clip={postClip}
						output={output}
						clipAspectLabel={clipAspectLabel}
						canRemove={post.outputs.length > 1}
						canPublish={props.canPublishOutput(output)}
						render={props.renders.get(output.id)}
						status={props.pubStatuses.get(output.id)}
						busy={busy}
						onPatch={(patch) => props.onPatchOutput(output.id, patch)}
						onRemove={() => props.onRemoveOutput(output.id)}
						onPreview={() => props.onPreviewOutput(output)}
						onPublish={() => props.onPublishOutput(output)}
					/>
				))}
				<Button variant="secondary" size="sm" onClick={props.onAddOutput}>
					+ 出力先を追加
				</Button>
			</div>
		</div>
	);
}
