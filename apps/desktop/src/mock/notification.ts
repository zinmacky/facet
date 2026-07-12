/**
 * `@tauri-apps/plugin-notification` の dev:mock 用差し替え
 * (`isPermissionGranted`/`requestPermission`/`sendNotification` のみ)。
 * ブラウザ単体では OS 通知の権限モデルを再現しないため、常に許可済みとして
 * 扱い、通知内容は `console.log` するだけ。
 */
export async function isPermissionGranted(): Promise<boolean> {
	return true;
}

export async function requestPermission(): Promise<"granted"> {
	return "granted";
}

export async function sendNotification(options: {
	title: string;
	body?: string;
}): Promise<void> {
	console.log(`[mock] sendNotification: ${options.title} — ${options.body}`);
}
