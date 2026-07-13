import type { OutputTarget } from "../../types";

/**
 * 投稿処理まわりの型・定数(private エディション専用)。
 * `usePublishExtras.ts` / `OutputPublishSection.tsx` からのみ参照される —
 * public ビルドの import グラフには一切含まれない(§features/upload/entry.public.ts)。
 */

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
 * プラットフォーム別の投稿対応状況(desktop 版, Phase 3)。
 *
 * - Instagram: R2 アップロード + POST /jobs を Rust で実装済み(§6.4)。ただし実際に
 *   投稿ボタンを有効化するにはこれに加えて実行時ゲート(`PublishGateContext.igReady` —
 *   scheduler 疎通 OK かつ R2 資格情報保存済み)も満たす必要がある
 *   (`isPlatformPublishSupported` はコード対応状況のみを表し、ゲートは呼び出し側で
 *   別途組み合わせる、`usePublishExtras.ts` 参照)。
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
