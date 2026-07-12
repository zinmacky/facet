import { useMutation } from "@tanstack/react-query";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { cancelJob } from "../../lib/tauri";
import { getErrorMessage } from "../../lib/getErrorMessage";
import { basename } from "../../lib/format";
import type { ReframeTaskState } from "../../lib/useReframeQueue";
import { Button } from "../../components/ui/Button";

/**
 * 中央下: 選択中 clip 1 本ぶんの書き出し状態カード。ExportPreviewDetail(クロップ内容
 * プレビュー)の下に並べるコンパクトな補助表示で、video は一切埋め込まない
 * (再書き出しとの競合リスク・意図しないプレビュー表示への混乱を避けるため —
 * ExportScreen の openFolderMutation と同じ方針。以前は ExportDetail 自体が
 * 中央パネル全体を占有し、started フラグでプレビューと排他表示していたが、
 * 「内容確認はプレビュー」「ファイル出力は書き出し」を UI 上で分離するため、
 * この状態カードに縮小した)。
 *
 * 呼び出し側(ExportScreen)は「書き出しを開始」前はこのコンポーネント自体を
 * マウントしない(未開始の段階では表示するものが無いため)。
 */
export function ExportDetail({
	task,
	dirty,
}: {
	task: ReframeTaskState | undefined;
	/** true = sig 変更で結果が破棄済み(編集後の要再書き出し。右の一覧から実行する)。 */
	dirty: boolean;
}) {
	// 書き出し結果ファイルを OS 既定のアプリ(動画プレーヤー)で開く。
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

	// task が undefined = まだキューに乗っていない(「新規追加で未書き出し」または
	// 「編集で要再書き出し(dirty)」)。カード状の表示はせず、状態だけ伝える1行の
	// プレースホルダに留める(進捗バー等は「タスクが実在する」場合のみ意味を持つため)。
	if (!task) {
		return (
			<p className="shrink-0 text-xs text-neutral-400">
				{dirty
					? "要再書き出し(右の一覧の「再書き出し」から実行)"
					: "未書き出し(右の一覧の「書き出す」から実行)"}
			</p>
		);
	}

	const { status, ratio } = task;

	return (
		<div className="flex shrink-0 flex-col gap-1.5 rounded-lg border border-line bg-panel/40 px-3 py-2">
			{status === "done" && task.outputPath ? (
				// インライン <video> での結果再生は廃止した(WebView がファイルハンドルを
				// 保持し続け、再書き出しと競合するリスクがあったため)。OS 既定のアプリで
				// 開く/ファイルマネージャで表示する、の明示アクションに置き換える。
				<div className="flex flex-wrap items-center gap-3">
					<span className="shrink-0 text-sm text-neutral-100">✅ 完了</span>
					{/* clip.name ではなく実際の出力ファイル名を出す(同名 clip が複数ある場合、
					重複回避で "-2" 等が付いた実ファイル名と clip.name が食い違うため)。 */}
					<span
						className="min-w-0 truncate font-mono text-xs text-neutral-400"
						title={task.outputPath}
					>
						{basename(task.outputPath)}
					</span>
					<div className="flex shrink-0 items-center gap-2">
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
						<p className="w-full text-xs text-danger">
							再生できませんでした: {getErrorMessage(playMutation.error)}
						</p>
					)}
					{revealMutation.isError && (
						<p className="w-full text-xs text-danger">
							フォルダを表示できませんでした: {getErrorMessage(revealMutation.error)}
						</p>
					)}
				</div>
			) : status === "error" ? (
				<div className="flex flex-col gap-1">
					<p className="text-sm text-danger">
						{task.error ?? "書き出しに失敗しました。"}
					</p>
					<span className="text-[11px] text-neutral-400">
						右の一覧の「再試行」から再実行できます。
					</span>
				</div>
			) : (
				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-2">
						<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel">
							<div
								className="h-full rounded-full bg-accent transition-[width]"
								style={{ width: `${Math.round(ratio * 100)}%` }}
							/>
						</div>
						<span className="shrink-0 text-xs text-neutral-400">
							書き出し中… {Math.round(ratio * 100)}%
						</span>
						{task.fps !== undefined && (
							<span className="shrink-0 text-[11px] text-neutral-500">
								{Math.round(task.fps)}fps
							</span>
						)}
						{task.jobId && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => task.jobId && void cancelJob(task.jobId)}
							>
								キャンセル
							</Button>
						)}
					</div>
					{task.notice && (
						<span className="text-[11px] text-amber-700 dark:text-amber-400">
							{task.notice}
						</span>
					)}
				</div>
			)}
		</div>
	);
}
