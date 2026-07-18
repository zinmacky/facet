import type { OutputTarget } from "../../types";

/**
 * 投稿処理まわりの型・定数(private エディション専用)。
 * `usePublishExtras.ts` / `OutputPublishSection.tsx` からのみ参照される —
 * public ビルドの import グラフには一切含まれない(§features/upload/entry.public.ts)。
 */

/**
 * 投稿処理の進行状態。
 *
 * - `scheduled`: Instagram 専用。scheduler がジョブ登録を受理した(`ig_publish_start`
 *   の done イベント)後、公開時刻到来〜IG 側公開処理の完了までの間の状態。
 *   アーキテクチャレビュー指摘(desktop が IG 予約投稿の最終成否を追跡しない)への
 *   対応で追加した — 従来はこの時点で即座に `success` としていたが、scheduler が
 *   受理しただけで実際の IG 公開が成功したとは限らない(`usePublishExtras.tsx` の
 *   ポーリング/手動更新導線を参照)。YouTube は `ig_publish_start` を経由しないため
 *   この状態を通らず、直接 `success` になる(既存挙動を維持)。
 */
export type PubStatusKind =
	| "idle"
	| "rendering"
	| "publishing"
	| "scheduled"
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
 * - YouTube: OAuth(Installed App フロー)+ resumable upload + publishAt を Rust で
 *   実装済み(§6.5)。実行時ゲートは `PublishGateContext.ytReady`(Google 接続済み)。
 */
export const INSTAGRAM_PUBLISH_SUPPORTED = true;
export const YOUTUBE_PUBLISH_SUPPORTED = true;

/** `target.platform` のコード対応状況(実行時ゲートは含まない)。 */
export function isPlatformPublishSupported(
	platform: OutputTarget["platform"],
): boolean {
	return platform === "instagram"
		? INSTAGRAM_PUBLISH_SUPPORTED
		: YOUTUBE_PUBLISH_SUPPORTED;
}
