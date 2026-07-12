/**
 * `@tauri-apps/plugin-opener` の dev:mock 用差し替え(`openPath`/`revealItemInDir`)。
 * ブラウザには OS のファイルマネージャ/既定アプリを開く手段が無いため、`console.log` するだけ。
 */
export async function openPath(path: string): Promise<void> {
	console.log(`[mock] openPath: ${path}`);
}

/** ExportDetail の「フォルダで表示」用(dev:mock 差し替え)。 */
export async function revealItemInDir(path: string | string[]): Promise<void> {
	console.log(`[mock] revealItemInDir: ${JSON.stringify(path)}`);
}
