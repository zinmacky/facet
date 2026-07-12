import { useUpdateChecker } from "../../lib/updater";
import { Button } from "../../components/ui/Button";
import { cn } from "../../components/ui/cn";

/**
 * 画面隅の非モーダルバナー(App.tsx に 1 行マウントするだけの独立コンポーネント)。
 * `useUpdateChecker` の状態のみを描画する。"idle"/"error" では何も描画しない
 * (§lib/updater.ts — 404/署名検証失敗などは黙って UI に出さない方針)。
 */
export function UpdateNotification() {
	const { status, version, body, progress, download, dismiss, restart } =
		useUpdateChecker();

	if (status === "idle" || status === "error") return null;

	return (
		<div
			role="status"
			aria-live="polite"
			className={cn(
				"fixed bottom-4 right-4 z-50 w-80 rounded-lg border border-line",
				"bg-elevated p-4 text-neutral-200 shadow-lg",
			)}
		>
			<p className="text-sm font-medium text-neutral-100">
				バージョン {version} が利用可能です
			</p>
			{body && status === "available" && (
				<p className="mt-1 max-h-24 overflow-y-auto text-[11px] text-neutral-400">
					{body}
				</p>
			)}

			{(status === "downloading" || status === "ready") && (
				<div className="mt-3">
					<div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
						<div
							className={cn(
								"h-full rounded-full bg-accent transition-[width]",
								status === "ready" && "w-full",
							)}
							style={
								status === "downloading"
									? {
											width:
												progress?.total && progress.total > 0
													? `${Math.min(100, (progress.downloaded / progress.total) * 100)}%`
													: "40%",
										}
									: undefined
							}
						/>
					</div>
					<p className="mt-1 text-[11px] text-neutral-400">
						{status === "ready" ? "ダウンロード完了" : "ダウンロード中…"}
					</p>
				</div>
			)}

			<div className="mt-3 flex justify-end gap-2">
				{status === "available" && (
					<>
						<Button size="sm" variant="ghost" onClick={dismiss}>
							後で
						</Button>
						<Button size="sm" variant="primary" onClick={download}>
							更新する
						</Button>
					</>
				)}
				{status === "downloading" && (
					<Button size="sm" variant="ghost" disabled>
						ダウンロード中…
					</Button>
				)}
				{status === "ready" && (
					<Button size="sm" variant="primary" onClick={restart}>
						再起動
					</Button>
				)}
			</div>
		</div>
	);
}
