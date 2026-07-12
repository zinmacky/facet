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
		void setMaxConcurrentEncodes(settings.maxConcurrentEncodes);
	}, [settings.maxConcurrentEncodes]);
}
