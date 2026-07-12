import { useMutation } from "@tanstack/react-query";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Clip } from "../../types";
import { aspectRatio } from "../../types";
import { cancelJob } from "../../lib/tauri";
import { getErrorMessage } from "../../lib/getErrorMessage";
import { basename } from "../../lib/format";
import type { ReframeTaskState } from "../../lib/useReframeQueue";
import { Button } from "../../components/ui/Button";

/** 中央: 選択中 clip 1 本ぶんの書き出し詳細。 */
export function ExportDetail({
	clip,
	task,
	dirty,
}: {
	clip: Clip;
	task: ReframeTaskState | undefined;
	/** true = sig 変更で結果が破棄済み(編集後の要再書き出し。右の一覧から実行する)。 */
	dirty: boolean;
}) {
	// task が undefined = まだキューに乗っていない。自動再書き出しの廃止により、
	// これは一瞬の状態ではなく「新規追加で未書き出し」または「編集で要再書き出し
	// (dirty)」のどちらかとして持続しうる — 誤解を避けるため実情に即した文言を出す
	// (以前の「待機中」は起動 effect にすぐ拾われる前提の文言だった)。
	const pending = task === undefined;
	const status = task?.status ?? "running";
	const ratio = task?.ratio ?? 0;
	const boxRatio = aspectRatio(clip.aspect) ?? 16 / 9;

	// 書き出し結果ファイルを OS 既定のアプリ(動画プレーヤー)で開く。
	// インライン <video> 表示は廃止した(再書き出しとの競合リスク・意図しないプレビュー
	// 表示への混乱を避けるため — ExportScreen の openFolderMutation と同じ方針)。
	const playMutation = useMutation({
		mutationFn: async (path: string) => {
			await openPath(path);
		},
	});
	// 書き出し結果ファイルを OS 既定のファイルマネージャで選択状態にして表示する。
	const revealMutation = useMutation({
		mutationFn: async (path: string) => {
			await revealItemInDir(path);
		},
	});

	return (
		<div className="flex h-full min-h-0 w-full flex-col items-center justify-center rounded-lg bg-panel/40 p-4">
			{/* ExportPreviewDetail と同じ縦スタック構造(ファイル名 + 枠 + 補足行を
			    1 グループとして縦センター)。幅の式も共有する。 */}
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
					{status === "running" && task?.fps !== undefined && (
						<span className="shrink-0 text-[11px] text-neutral-500">
							{Math.round(task.fps)}fps
						</span>
					)}
				</div>

				<div
					style={{ aspectRatio: boxRatio }}
					className="flex w-full items-center justify-center overflow-hidden rounded-lg border border-line bg-black/5 dark:bg-black/40"
				>
					{status === "done" && task?.outputPath ? (
						// インライン <video> での結果再生は廃止した(WebView がファイルハンドルを
						// 保持し続け、再書き出しと競合するリスクがあったため)。OS 既定のアプリで
						// 開く/ファイルマネージャで表示する、の明示アクションに置き換える。
						<div className="flex w-2/3 flex-col items-center gap-3 text-center">
							<p className="text-sm text-neutral-100">
								✅ 完了
								<br />
								{/* clip.name ではなく実際の出力ファイル名を出す(同名 clip が複数ある場合、
								重複回避で "-2" 等が付いた実ファイル名と clip.name が食い違うため)。 */}
								<span className="font-mono text-xs text-neutral-400">
									{basename(task.outputPath)}
								</span>
							</p>
							<div className="flex items-center gap-2">
								<Button
									variant="secondary"
									size="sm"
									disabled={playMutation.isPending}
									onClick={() => {
										const path = task.outputPath;
										if (path) playMutation.mutate(path);
									}}
								>
									{playMutation.isPending ? "開いています…" : "再生"}
								</Button>
								<Button
									variant="secondary"
									size="sm"
									disabled={revealMutation.isPending}
									onClick={() => {
										const path = task.outputPath;
										if (path) revealMutation.mutate(path);
									}}
								>
									{revealMutation.isPending ? "開いています…" : "フォルダで表示"}
								</Button>
							</div>
							{/* play/reveal は独立した操作のため、エラーも混線させず個別に出す。 */}
							{playMutation.isError && (
								<p className="text-xs text-danger">
									再生できませんでした: {getErrorMessage(playMutation.error)}
								</p>
							)}
							{revealMutation.isError && (
								<p className="text-xs text-danger">
									フォルダを表示できませんでした:{" "}
									{getErrorMessage(revealMutation.error)}
								</p>
							)}
						</div>
					) : status === "error" ? (
						<div className="flex w-2/3 flex-col items-center gap-1.5 text-center">
							<p className="text-sm text-danger">
								{task?.error ?? "書き出しに失敗しました。"}
							</p>
							<span className="text-[11px] text-neutral-400">
								右の一覧の「再試行」から再実行できます。
							</span>
						</div>
					) : (
						<div className="flex w-2/3 flex-col items-center gap-1.5 text-center">
							<div className="h-1.5 w-full overflow-hidden rounded-full bg-panel">
								<div
									className="h-full rounded-full bg-accent transition-[width]"
									style={{ width: `${Math.round(ratio * 100)}%` }}
								/>
							</div>
							<div className="flex items-center gap-2">
								<span className="text-xs text-neutral-400">
									{pending
										? dirty
											? "要再書き出し(右の一覧の「再書き出し」から実行)"
											: "未書き出し(右の一覧の「書き出す」から実行)"
										: `書き出し中… ${Math.round(ratio * 100)}%`}
								</span>
								{task?.jobId && (
									<Button
										variant="ghost"
										size="sm"
										onClick={() => task.jobId && void cancelJob(task.jobId)}
									>
										キャンセル
									</Button>
								)}
							</div>
							{task?.notice && (
								<span className="text-[11px] text-amber-700 dark:text-amber-400">
									{task.notice}
								</span>
							)}
						</div>
					)}
				</div>

				{status === "done" && task?.outputPath && (
					<p
						className="truncate font-mono text-[11px] text-neutral-500"
						title={task.outputPath}
					>
						{task.outputPath}
					</p>
				)}
			</div>
		</div>
	);
}
