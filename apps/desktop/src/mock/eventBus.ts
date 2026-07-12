/**
 * `@tauri-apps/api/event` の `listen`/`emit` を模した、renderer 内で完結する
 * 最小のイベントバス。dev:mock 専用(apps/desktop/src/mock/README 参照)。
 */

type Handler = (event: { payload: unknown }) => void;

const handlers = new Map<string, Set<Handler>>();

/** `event` にハンドラを登録する。戻り値は購読解除関数(`listen` の戻り値と同形)。 */
export function mockOn(event: string, handler: Handler): () => void {
	let set = handlers.get(event);
	if (!set) {
		set = new Set();
		handlers.set(event, set);
	}
	set.add(handler);
	return () => {
		handlers.get(event)?.delete(handler);
	};
}

/** `event` に登録済みの全ハンドラへ `payload` を配送する。 */
export function mockEmit(event: string, payload: unknown): void {
	const set = handlers.get(event);
	if (!set) return;
	for (const handler of [...set]) handler({ payload });
}
