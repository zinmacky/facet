import { MOCK_EXPORT_DIR, MOCK_SOURCE_PATH } from "./fixtures";

/**
 * `@tauri-apps/plugin-dialog` の dev:mock 用差し替え(`open` のみ)。
 * ブラウザにはネイティブファイルダイアログを開く権限がないため、`lib/tauri.ts` の
 * `pickVideoFile`/`pickExportDirectory` が渡すオプションから種別を判定し、
 * 固定のダミーパスを即座に返す(キャンセル UI は無い)。
 */

interface MockOpenOptions {
	multiple?: boolean;
	directory?: boolean;
	title?: string;
	filters?: { name: string; extensions: string[] }[];
}

export async function open(
	opts?: MockOpenOptions,
): Promise<string | string[] | null> {
	if (opts?.directory) return MOCK_EXPORT_DIR;
	return MOCK_SOURCE_PATH;
}
