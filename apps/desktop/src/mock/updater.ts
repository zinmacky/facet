import { MOCK_UPDATE_INFO } from "./fixtures";

/**
 * `@tauri-apps/plugin-updater` の dev:mock 用差し替え(`check` のみ。`lib/updater.ts` が
 * 使うのはこれだけ — `Update`/`DownloadEvent` は型のみの import のため実行時には
 * 解決されない)。
 *
 * 常に `MOCK_UPDATE_INFO` の固定バージョンを「利用可能」として返す
 * (UpdateNotification バナーの目視確認用。§mock/README.md)。`downloadAndInstall` は
 * `jobRunner` と同様 200ms 刻みでダミー進捗を発火し、3s ほどで完了する。
 */

const STEP_MS = 200;
const STEPS = 15; // 200ms * 15 = 3s。
const TOTAL_BYTES = 42_000_000; // 見た目用の適当な合計サイズ(約 40MB)。

export interface MockDownloadEvent {
	event: "Started" | "Progress" | "Finished";
	data?: { contentLength?: number; chunkLength?: number };
}

export interface MockUpdate {
	version: string;
	body?: string;
	download: (onEvent?: (e: MockDownloadEvent) => void) => Promise<void>;
	install: () => Promise<void>;
	downloadAndInstall: (onEvent?: (e: MockDownloadEvent) => void) => Promise<void>;
	close: () => Promise<void>;
}

function makeMockUpdate(): MockUpdate {
	const downloadAndInstall = (
		onEvent?: (e: MockDownloadEvent) => void,
	): Promise<void> => {
		return new Promise((resolve) => {
			onEvent?.({ event: "Started", data: { contentLength: TOTAL_BYTES } });
			let tick = 0;
			const chunk = Math.round(TOTAL_BYTES / STEPS);
			const timer = setInterval(() => {
				tick += 1;
				onEvent?.({ event: "Progress", data: { chunkLength: chunk } });
				if (tick >= STEPS) {
					clearInterval(timer);
					onEvent?.({ event: "Finished" });
					resolve();
				}
			}, STEP_MS);
		});
	};

	return {
		version: MOCK_UPDATE_INFO.version,
		body: MOCK_UPDATE_INFO.body,
		download: (onEvent) => downloadAndInstall(onEvent),
		install: async () => undefined,
		downloadAndInstall,
		close: async () => undefined,
	};
}

/** 常に固定の更新が「利用可能」として見つかったことにする(dev:mock 専用)。 */
export async function check(): Promise<MockUpdate> {
	return makeMockUpdate();
}
