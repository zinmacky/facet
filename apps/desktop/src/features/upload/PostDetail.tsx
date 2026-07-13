import type { ReactNode } from "react";
import type { Clip } from "../../types";
import type { PreviewState } from "../../lib/usePreview";
import { Button } from "../../components/ui/Button";
import { OutputCard } from "./OutputCard";
import { type UploadOutput, type UploadPost, selectClass } from "./uploadTypes";

interface PostDetailProps {
	post: UploadPost;
	clips: Clip[];
	renders: Map<string, PreviewState>;
	/** §OutputCard.tsx の `previewError`(output.id ごとの早期失敗メッセージ)。 */
	previewErrors: Map<string, string>;
	busy: boolean;
	onPatchPost: (patch: Partial<UploadPost>) => void;
	onPatchOutput: (outputId: string, patch: Partial<UploadOutput>) => void;
	onAddOutput: () => void;
	onRemoveOutput: (outputId: string) => void;
	onPreviewOutput: (output: UploadOutput) => void;
	/**
	 * private エディション専用: 投稿詳細ヘッダに添える予約日時・一括投稿セクション。
	 * ReframeScreen が `publishSlots.renderPostSection(...)` の結果をそのまま渡す。
	 */
	scheduleSlot?: ReactNode;
	/**
	 * private エディション専用: 各 OutputCard に添える投稿設定セクション。
	 * ReframeScreen が `publishSlots.renderOutputSection(...)` をラップして渡す
	 * (PostDetail 自体は投稿系の型・文言に一切依存しない)。
	 */
	renderOutputExtra?: (output: UploadOutput) => ReactNode;
}

export function PostDetail(props: PostDetailProps) {
	const { post, clips } = props;
	const postClip = clips.find((c) => c.id === post.clipId);
	// 元画面で決めたクロップ比。出力先アスペクトとの関係を示すために表示する。
	const clipAspectLabel = postClip
		? postClip.aspect === "free"
			? "自由"
			: postClip.aspect
		: "—";

	return (
		<div className="flex flex-col gap-3">
			{/* ヘッダ: 対象 clip(常時表示)+ private 専用の予約日時セクション(あれば) */}
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

				{props.scheduleSlot}
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
						render={props.renders.get(output.id)}
						previewError={props.previewErrors.get(output.id)}
						busy={props.busy}
						onPatch={(patch) => props.onPatchOutput(output.id, patch)}
						onRemove={() => props.onRemoveOutput(output.id)}
						onPreview={() => props.onPreviewOutput(output)}
						postingSlot={props.renderOutputExtra?.(output)}
					/>
				))}
				<Button variant="secondary" size="sm" onClick={props.onAddOutput}>
					+ 出力先を追加
				</Button>
			</div>
		</div>
	);
}
