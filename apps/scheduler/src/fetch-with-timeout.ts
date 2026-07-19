/**
 * 外部 API(Meta Graph API)呼び出し共通のタイムアウト付き fetch ラッパー。
 * 素の fetch はハングすると無期限に待ち続け、DO の1回の呼び出し(runCreate /
 * alarm)や token-refresh の cron 実行を無期限に held-open にしてしまう
 * (instagram.ts の createContainer/getContainerStatus/publishContainer、
 * token-refresh.ts の fb_exchange_token 呼び出しが対象)。AbortController で
 * タイムアウトを課し、期限超過時は呼び出し元の既存のエラーハンドリング
 * (DO の handleFailure による transient リトライ、token-refresh の
 * recordFailureIfNearExpiry)にそのまま乗せられる Error を投げる。
 */

/**
 * Graph API 呼び出しのタイムアウト(ms)。
 * 通常のレスポンスは数秒で返る想定だが、Meta 側の一時的な遅延を考慮しつつ、
 * DO の1回の実行(runCreate/alarm)や cron 実行を無期限にブロックしないよう
 * 「これを超えたら異常」とみなせる30秒を上限とする。
 */
export const GRAPH_API_TIMEOUT_MS = 30_000;

/**
 * `fetch` の薄いラッパー。`timeoutMs`(既定 GRAPH_API_TIMEOUT_MS)を超えても
 * 応答が無ければ abort し、わかりやすいメッセージの Error を投げる。
 * 呼び出し元は素の fetch と同様に catch すればよく、AbortError を特別扱いする
 * 必要はない(既存の「例外 = transient 失敗」経路にそのまま乗る)。
 *
 * `init.signal` は呼び出し元から渡されても無視する(タイムアウト用の signal で
 * 上書きする)。現状の呼び出し元(instagram.ts / token-refresh.ts)はいずれも
 * signal を渡していない。
 */
export async function fetchWithTimeout(
	input: string,
	init: RequestInit,
	timeoutMs: number = GRAPH_API_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} catch (err) {
		// workerd 実行時の AbortError が Error のサブクラスとは限らないため、
		// instanceof Error では絞らず name だけで判定する(堅牢性優先)。
		if ((err as { name?: unknown } | null)?.name === "AbortError") {
			throw new Error(`fetch timed out after ${timeoutMs}ms: ${input}`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}
