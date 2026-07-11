/**
 * `@tauri-apps/plugin-opener` の dev:mock 用差し替え(`openPath` のみ)。
 * ブラウザには OS のファイルマネージャを開く手段が無いため、`console.log` するだけ。
 */
export async function openPath(path: string): Promise<void> {
	console.log(`[mock] openPath: ${path}`);
}
