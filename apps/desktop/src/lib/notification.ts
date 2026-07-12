import {
	isPermissionGranted,
	requestPermission,
	sendNotification,
} from "@tauri-apps/plugin-notification";

/**
 * 書き出し完了時にデスクトップ通知(OS 標準のトースト)を送る。
 *
 * 通知はあくまで補助的な UX であり、書き出し自体の成否には影響しない。
 * そのため権限確認・要求・送信のいずれかで失敗しても例外を投げず、単に
 * 通知を諦める(ベストエフォート)。呼び出し側(ExportScreen)が
 * `await` を省略して `void` 呼び出しできるのはこの前提があるため。
 */
export async function notifyExportComplete(count: number): Promise<void> {
	try {
		let granted = await isPermissionGranted();
		if (!granted) {
			const permission = await requestPermission();
			granted = permission === "granted";
		}
		if (!granted) return;

		await sendNotification({
			title: "書き出しが完了しました",
			body: `${count} 本の切り抜きを書き出しました。`,
		});
	} catch {
		// 通知 API が使えない環境(権限 API 未対応、OS 側の通知拒否等)でも
		// 書き出しフロー自体は継続させたいため、ここで握りつぶす。
	}
}
