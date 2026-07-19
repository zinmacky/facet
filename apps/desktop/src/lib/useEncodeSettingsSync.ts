import { useEffect } from "react";
import { useSettings } from "./settings";
import { setMaxConcurrentEncodes } from "./tauri";

/**
 * `settings.maxConcurrentEncodes` を Rust 側(`set_max_concurrent_encodes`)へ同期する。
 * 初回マウント時と値の変更時の双方で invoke する(App.tsx から呼ぶ想定 — useSettings が
 * 使えるコンポーネントで、かつ一度だけマウントされる場所)。
 * settings.tsx 本体には tauri 依存を持ち込まない方針のため、同期処理はこの専用フックへ分離する。
 */
export function useEncodeSettingsSync(): void {
	const { settings } = useSettings();

	useEffect(() => {
		// invoke が reject すると unhandled rejection になり、かつ UI(設定値)と Rust 側の
		// 同時実行数上限が silently 乖離してしまう。他の非致命的 invoke 失敗と同様
		// console.warn に留める(tauriJobLifecycle.ts の cancelOrphanJob 等と同じ方針)。
		setMaxConcurrentEncodes(settings.maxConcurrentEncodes).catch((err: unknown) => {
			console.warn(
				`同時実行数の上限設定の同期に失敗しました(max=${settings.maxConcurrentEncodes})`,
				err,
			);
		});
	}, [settings.maxConcurrentEncodes]);
}
