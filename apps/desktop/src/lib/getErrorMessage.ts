/**
 * unknown な catch エラーからメッセージ文字列を取り出す。
 * `Error` インスタンスなら `.message`、それ以外は `String()` にフォールバックする。
 */
export function getErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
