import type { Clip } from "../types";

/**
 * `masterSpec`/`finalSpec` に効く(=クロップ内容そのものへ影響する) clip フィールドの
 * シグネチャ。これが変わればプレビュー/書き出し結果は古い(要更新) — usePreview の sig、
 * および ExportScreen の results エントリの sig・UploadScreen の outputSig の一部として使う。
 * ExportScreen(クロップ内容プレビュー・書き出し)と UploadScreen(最終プレビュー)の
 * 双方から使う共通実装。
 */
export function clipPreviewSig(clip: Clip): string {
	const crop = clip.crop
		? `${clip.crop.x}:${clip.crop.y}:${clip.crop.width}:${clip.crop.height}`
		: "full";
	return `${clip.trim.start}:${clip.trim.end}|${clip.aspect}|${crop}`;
}
