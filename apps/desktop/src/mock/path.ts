import { MOCK_DOCUMENT_DIR } from "./fixtures";

/**
 * `@tauri-apps/api/path` の dev:mock 用差し替え。`join` は `lib/tauri.ts` 経由では使われず、
 * `ExportScreen`/`UploadScreen` が出力ファイル名の組み立てに直接使う。`documentDir` は
 * `lib/tauri.ts` の `pickExportDirectory` が defaultPath 解決に使う。
 */

/** 単純な `/` 区切りの結合(実 OS パス区切りの再現はしない — 表示・DL リンク用途のみ)。 */
export async function join(...parts: string[]): Promise<string> {
	return parts.join("/");
}

/** 固定のダミー書類フォルダを返す。 */
export async function documentDir(): Promise<string> {
	return MOCK_DOCUMENT_DIR;
}
