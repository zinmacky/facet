import type { Clip } from "../../types";
import { aspectRatio } from "../../types";
import { convertFileSrc } from "../../lib/tauri";
import type { PreviewState } from "../../lib/usePreview";
import { clipPreviewSig } from "../../lib/clipSig";
import { Button } from "../../components/ui/Button";

/**
 * 中央: 選択中 clip 1 本ぶんのクロップ内容プレビュー。`preview_start`(低ビットレート・
 * app キャッシュ)を使い、ユーザー向けのファイルダウンロード/保存は行わない
 * (結果は画面内の <video> 表示のみ)。
 *
 * 「書き出しを開始」の前後を問わず常時表示する(UX変更: 以前は started フラグで
 * ExportDetail(書き出し状態)と排他表示していたが、書き出し開始後にクロップ内容を
 * 確認する導線が消えてしまっていたため廃止した。書き出しの進捗/完了/エラーは
 * ExportScreen 側で下に並べる ExportDetail(コンパクトな状態カード)が担う)。
 *
 * ウィザードは3画面(編集/確認/リフレーム)を常時マウントするため、プレビュー
 * 生成後に別画面でクロップ内容(トリム/クロップ/アスペクト)を編集して戻ってきても
 * state はそのまま残る。表示のたびに生成時の sig(state.sig)と現在の clip の sig を
 * 照合し、不一致なら古い video を表示せず「要更新」を案内する
 * (UploadScreen の OutputCard にある stale バッジと同じ考え方)。
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
	const sig = clipPreviewSig(clip);
	const fresh = outputPath !== undefined && state?.sig === sig;
	const stale = outputPath !== undefined && !fresh;
	const boxRatio = aspectRatio(clip.aspect) ?? 16 / 9;

	return (
		<div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center rounded-lg bg-panel/40 p-4">
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
						{stale && (
							<span className="ml-1 text-amber-700 dark:text-amber-400">
								(要更新)
							</span>
						)}
					</span>
				</div>

				<div
					style={{ aspectRatio: boxRatio }}
					className="flex w-full items-center justify-center overflow-hidden rounded-lg border border-line bg-black/5 dark:bg-black/40"
				>
					{fresh && outputPath ? (
						/* biome-ignore lint/a11y/useMediaCaption: 書き出し内容確認用のプレビューで字幕データが存在しない */
						<video
							controls
							src={convertFileSrc(outputPath)}
							className="h-full w-full object-contain"
						/>
					) : stale ? (
						<p className="max-w-[75%] text-center text-xs text-neutral-500">
							編集内容が変わりました。「プレビュー更新」で最新のクロップ内容を
							確認できます。
						</p>
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
