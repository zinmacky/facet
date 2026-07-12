/**
 * `@tauri-apps/plugin-process` の dev:mock 用差し替え(`relaunch` のみ)。
 * ブラウザにはアプリを再起動する手段が無いため、`console.log` するだけ。
 */
export async function relaunch(): Promise<void> {
	console.log("[mock] relaunch: アプリの再起動をシミュレートしました");
}
