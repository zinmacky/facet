import type { EditSpec, FitMode } from "@facet/core";
import type { Source } from "../../App";
import type { Clip } from "../../types";
import { finalSpec, targetById } from "../../types";
import { clipPreviewSig } from "../../lib/clipSig";
import { cn } from "../../components/ui/cn";

/**
 * リフレーム画面(Post / Output の二層モデル)で共有する型・定数。
 * 両エディションに存在する共通コード(ReframeScreen 本体・PostDetail・PostRow・
 * OutputCard・BulkPresetsModal)と、private 専用の投稿系コード(usePublishExtras 等、
 * §docs/desktop-migration-plan.md の該当セクション)の双方から参照する。
 *
 * Post = 「どの切り抜きをどの出力先(ターゲット×フィット)一式で書き出すか」の単位。
 * private エディションでは、同じ Post に属する全 Output が同一の予約日時
 * (`publishAt`)で投稿される(`UploadPost.publishAt`・`PostScheduleSection` 参照)。
 * public エディションは `publishAt` を一切設定しない(スケジュール UI 自体を持たない)
 * ため、この場合の Post は単に「1 クリップぶんの出力先グループ」として振る舞う。
 *
 * `title`/`description`/`caption`(投稿メタデータ)は private 専用の概念だが、
 * 2つ目の実装(投稿以外の用途)が無い現状では型を分けるコストに見合わないため、
 * あえて `UploadOutput` に残している(YAGNI)。public では常に空文字のまま
 * 生成され、対応する入力 UI 自体が存在しない(OutputPublishSection.tsx が
 * private 専用ファイルのため)ので、公開ビルドに文言が漏れることはない。
 */

/** 1 出力先(プラットフォーム別の書き出し・メタ)。 */
export interface UploadOutput {
	id: string;
	/** OUTPUT_TARGETS の id。既定 "yt-shorts"。 */
	targetId: string;
	/** 既定 "crop"。 */
	fit: FitMode;
	/** YouTube 用(private 専用。§uploadTypes.ts 冒頭コメント)。 */
	title: string;
	/** YouTube 用(private 専用)。 */
	description: string;
	/** Instagram 用(private 専用)。 */
	caption: string;
}

/** 1 Post(= どの clip をどの出力先一式で扱うか)。 */
export interface UploadPost {
	id: string;
	clipId: string;
	/** private 専用: この Post の予約投稿時刻。全出力に適用。未指定=即時。 */
	publishAt?: number;
	outputs: UploadOutput[];
}

/**
 * Output の設定シグネチャ。これが変わったらレンダリングは古い(要更新)。
 * `finalSpec` に効く clip.trim/crop/aspect(`clipPreviewSig`)も含める — clip 側の
 * 編集(トリム/クロップ/アスペクト変更)後にプレビューが古いままになる P1 バグの修正
 * (ExportScreen の clipPreviewSig と同じ考え方)。clip が見つからない場合(参照先
 * clip が削除された等)は "missing" を返し、いずれにせよ再レンダリングが必要になる
 * ようにする。
 */
export function outputSig(
	clip: Clip | undefined,
	post: UploadPost,
	output: UploadOutput,
): string {
	const clipSig = clip ? clipPreviewSig(clip) : "missing";
	return `${post.clipId}|${clipSig}|${output.targetId}|${output.fit}`;
}

export const DEFAULT_TARGET_ID = "yt-shorts";
export const DEFAULT_FIT: FitMode = "crop";

/** 既定の Output を生成する。 */
export function createOutput(): UploadOutput {
	return {
		id: crypto.randomUUID(),
		targetId: DEFAULT_TARGET_ID,
		fit: DEFAULT_FIT,
		title: "",
		description: "",
		caption: "",
	};
}

/** clip から既定の Post(Output 1 つ)を生成する。 */
export function createPost(clipId: string): UploadPost {
	return {
		id: crypto.randomUUID(),
		clipId,
		outputs: [createOutput()],
	};
}

/**
 * `output` のレンダリング引数(入力パス・spec・設定シグネチャ)を組み立てる。
 * ReframeScreen の共通プレビュー(`ensureRendered`)と、private 専用の投稿用
 * レンダリング(`ensurePublishRendered`、§usePublishExtras.ts)の双方が使う共通ガード節
 * (元動画未選択・対象クリップ不明・出力ターゲット無効を早期 throw する)。
 */
export function buildRenderArgs(
	source: Omit<Source, "videoSrc"> | null,
	clips: Clip[],
	post: UploadPost,
	output: UploadOutput,
): { input: string; spec: EditSpec; sig: string } {
	if (!source) throw new Error("元動画が未選択です。");
	const clip = clips.find((c) => c.id === post.clipId);
	if (!clip) throw new Error("対象クリップが見つかりません。");
	const target = targetById(output.targetId);
	if (!target) throw new Error("出力ターゲットが無効です。");

	const spec = finalSpec(
		clip,
		{ width: source.probe.width, height: source.probe.height },
		target,
		output.fit,
	);
	return {
		input: source.inputPath,
		spec,
		sig: outputSig(clip, post, output),
	};
}

/** 共通の入力スタイル(ダークな編集ツール調)。 */
export const inputClass =
	"h-8 rounded-md border border-line bg-elevated px-2 text-xs text-neutral-200 " +
	"focus:border-accent focus:outline-none";
export const selectClass = cn(inputClass, "cursor-pointer");
export const textareaClass =
	"min-h-[56px] w-full rounded-md border border-line bg-elevated px-2 py-1.5 " +
	"text-xs text-neutral-200 focus:border-accent focus:outline-none";
