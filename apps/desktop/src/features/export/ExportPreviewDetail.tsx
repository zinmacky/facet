import type { Clip } from "../../types";
import { aspectRatio } from "../../types";
import { convertFileSrc } from "../../lib/tauri";
import type { PreviewState } from "../../lib/usePreview";
import { Button } from "../../components/ui/Button";

/**
 * 中央: 選択中 clip 1 本ぶんのクロップ内容プレビュー。「書き出しを開始」前の画面用。
 * `preview_start`(低ビットレート・app キャッシュ)を使い、ユーザー向けの
 * ファイルダウンロード/保存は行わない(結果は画面内の <video> 表示のみ)。
 */
export function ExportPreviewDetail({
	clip,
	state,
	onGenerate,
	onCancel,
}: {
	clip: Clip;
	state: PreviewState | undefined;
	onGenerate: () => void;
	onCancel: () => void;
}) {
	const rendering = state?.rendering ?? false;
	const outputPath = state?.outputPath;
	const boxRatio = aspectRatio(clip.aspect) ?? 16 / 9;

	return (
		<div className="flex h-full min-h-0 w-full flex-col items-center justify-center rounded-lg bg-panel/40 p-4">
			{/*
			 * ファイル名 + プレビュー枠 + 生成ボタンを 1 つの縦スタックにまとめ、
			 * スタックごと縦センターに置く(枠を flex-1 で伸ばすと、横長アスペクトでは
			 * 枠だけが縦センターに contain され、ボタンが下端に取り残されて視覚グループが
			 * 分断される)。枠の高さは「幅 = min(横いっぱい, 利用可能な縦空間 × アスペクト比)」
			 * から従属的に決まる — 300px はヘッダ/フッタ/タイトル行/ボタン行ぶんの固定オフセット。
			 */}
			<div
				className="flex min-h-0 flex-col gap-3"
				style={{
					width: `min(100%, max(280px, calc((100vh - 300px) * ${boxRatio})))`,
				}}
			>
				<div className="flex shrink-0 items-center justify-between gap-2">
					<h3
						className="truncate font-mono text-sm text-neutral-100"
						title={`${clip.name}.mp4`}
					>
						{clip.name}.mp4
					</h3>
					<span className="shrink-0 text-[11px] text-neutral-400">
						クロップ内容プレビュー
					</span>
				</div>

				<div
					style={{ aspectRatio: boxRatio }}
					className="flex w-full items-center justify-center overflow-hidden rounded-lg border border-line bg-black/40"
				>
					{outputPath ? (
						/* biome-ignore lint/a11y/useMediaCaption: 書き出し内容確認用のプレビューで字幕データが存在しない */
						<video
							controls
							src={convertFileSrc(outputPath)}
							className="h-full w-full object-contain"
						/>
					) : (
						<p className="max-w-[75%] text-center text-xs text-neutral-500">
							「プレビュー生成」でクロップ内容を確認できます(ファイルはアプリの
							キャッシュにのみ作成され、保存・ダウンロードはされません)。
						</p>
					)}
				</div>

				<div className="flex shrink-0 items-center justify-center gap-2">
					<Button
						variant="secondary"
						size="sm"
						onClick={onGenerate}
						disabled={rendering}
					>
						{rendering ? "生成中…" : outputPath ? "プレビュー更新" : "プレビュー生成"}
					</Button>
					{rendering && (
						<Button variant="ghost" size="sm" onClick={onCancel}>
							キャンセル
						</Button>
					)}
					{state?.error && <p className="text-xs text-danger">{state.error}</p>}
				</div>
			</div>
		</div>
	);
}
