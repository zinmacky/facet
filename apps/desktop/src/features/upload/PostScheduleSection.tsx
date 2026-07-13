import { useState } from "react";
import { localInputToMs, msToLocalInput } from "../../lib/schedule";
import { Button } from "../../components/ui/Button";
import { Disclosure } from "./Disclosure";
import { inputClass, type UploadPost } from "./uploadTypes";

interface PostScheduleSectionProps {
	post: UploadPost;
	busy: boolean;
	/** post.outputs のいずれかが投稿可能(コード対応 + 実行時ゲート)か。 */
	anyOutputPublishable: boolean;
	onPatchPost: (patch: Partial<UploadPost>) => void;
	onPublishPost: () => void;
}

/**
 * PostDetail ヘッダに差し込む「予約日時・一括投稿」の折りたたみ。private エディション
 * 専用(§usePublishExtras.ts の `renderPostSection`)。PostDetail.tsx 本体から抽出した
 * (旧: PostDetail.tsx の同名 Disclosure、§docs/desktop-migration-plan.md の
 * wizard 再構成メモ)。CI の投稿系マーカー文字列「一括投稿」はこのファイルの
 * タイトル文言が担う(.github/workflows/ci.yml・release.yml 参照)。
 */
export function PostScheduleSection(props: PostScheduleSectionProps) {
	const { post, busy, anyOutputPublishable } = props;
	const [expanded, setExpanded] = useState(false);
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
		<Disclosure
			title="投稿設定(予約日時・一括投稿)"
			expanded={expanded}
			onToggle={() => setExpanded((v) => !v)}
			trailing={
				<span className="text-[11px] text-neutral-400">{scheduleLabel}</span>
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
					title={anyOutputPublishable ? undefined : "投稿可能な出力先がありません"}
				>
					この投稿をすべて投稿
				</Button>
			</div>
		</Disclosure>
	);
}
