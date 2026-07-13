import type { FitMode } from "@facet/core";
import type { Clip, OutputTarget } from "../../types";
import { clipPreviewSig } from "../../lib/clipSig";
import { cn } from "../../components/ui/cn";

/**
 * アップロード画面(Post / Output の二層モデル)で共有する型・定数。
 * UploadScreen 本体と、そこから抽出した各サブコンポーネント
 * (PostDetail / OutputCard / PostRow / BulkPresetsModal / ScheduleSettingsModal)の
 * 双方から参照する。
 *
 * Post = 「どの切り抜きを何時に投稿するか」。1 Post は複数の出力先(Output)を持ち、
 * すべて同じ publishAt(=同時刻)で投稿される。各 Output はターゲット/フィット/メタを持つ。
 */

/** 1 投稿の出力先(プラットフォーム別の書き出し・メタ)。 */
export interface UploadOutput {
	id: string;
	/** OUTPUT_TARGETS の id。既定 "yt-shorts"。 */
	targetId: string;
	/** 既定 "crop"。 */
	fit: FitMode;
	/** YouTube 用。 */
	title: string;
	/** YouTube 用。 */
	description: string;
	/** Instagram 用。 */
	caption: string;
}

/** 1 投稿(= どの clip を何時に投稿するか)。全 Output を同時刻で投稿する。 */
export interface UploadPost {
	id: string;
	clipId: string;
	/** この投稿の予約時刻。全出力に適用。未指定=即時。 */
	publishAt?: number;
	outputs: UploadOutput[];
}

/** 投稿処理の進行状態。 */
export type PubStatusKind =
	| "idle"
	| "rendering"
	| "publishing"
	| "success"
	| "error";

export interface PubStatus {
	kind: PubStatusKind;
	message?: string;
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

/**
 * プラットフォーム別の投稿対応状況(desktop 版, Phase 3)。
 *
 * - Instagram: R2 アップロード + POST /jobs を Rust で実装済み(§6.4)。ただし実際に
 *   投稿ボタンを有効化するにはこれに加えて実行時ゲート(`PublishGateContext.igReady` —
 *   scheduler 疎通 OK かつ R2 資格情報保存済み)も満たす必要がある
 *   (`isPlatformPublishSupported` はコード対応状況のみを表し、ゲートは呼び出し側で
 *   別途組み合わせる、`UploadScreen.tsx` 参照)。
 * - YouTube: 今回のスコープ外(Phase 3 の別作業として今後 OAuth + アップロードを実装する)。
 *   ボタン群は studio 版と UI 構造を保つため残しつつ disabled のままにする。
 */
export const INSTAGRAM_PUBLISH_SUPPORTED = true;
export const YOUTUBE_PUBLISH_SUPPORTED = false;

/** `target.platform` のコード対応状況(実行時ゲートは含まない)。 */
export function isPlatformPublishSupported(
	platform: OutputTarget["platform"],
): boolean {
	return platform === "instagram"
		? INSTAGRAM_PUBLISH_SUPPORTED
		: YOUTUBE_PUBLISH_SUPPORTED;
}

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

/** 共通の入力スタイル(ダークな編集ツール調)。 */
export const inputClass =
	"h-8 rounded-md border border-line bg-elevated px-2 text-xs text-neutral-200 " +
	"focus:border-accent focus:outline-none";
export const selectClass = cn(inputClass, "cursor-pointer");
export const textareaClass =
	"min-h-[56px] w-full rounded-md border border-line bg-elevated px-2 py-1.5 " +
	"text-xs text-neutral-200 focus:border-accent focus:outline-none";
