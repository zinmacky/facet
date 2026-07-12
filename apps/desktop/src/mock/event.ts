import { mockOn } from "./eventBus";

/**
 * `@tauri-apps/api/event` の dev:mock 用差し替え(`listen` のみ)。
 * `lib/tauri.ts` が購読する `reframe://progress/<id>` 等の動的イベント名は
 * `jobRunner.ts` が `eventBus` 経由で発火する。
 */

export type UnlistenFn = () => void;

export async function listen<T>(
	event: string,
	handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
	return mockOn(event, handler as (event: { payload: unknown }) => void);
}
