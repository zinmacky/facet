import type { JobRecord } from "@facet/contract";
import type { MediaInfo } from "../lib/tauri";

/**
 * dev:mock 専用フィクスチャ(`vite --mode mock`、apps/desktop/src/mock/README 参照)。
 * ブラウザで renderer 単体を起動し、UIUX 確認用のスクリーンショットを撮れるようにするための
 * ダミーデータ群。プロダクトビルド(`pnpm build`)・実 Tauri 実行には一切含まれない
 * (vite.config.ts が `mode === "mock"` のときのみ `resolve.alias` でこのモジュール群に
 * 差し替える)。
 */

/** `pickVideoFile` が返す固定のダミー元動画パス。 */
export const MOCK_SOURCE_PATH = "C:\\Users\\mock\\Videos\\sample-source.mp4";

/** `pickExportDirectory` が返す固定のダミー書き出し先ディレクトリ。 */
export const MOCK_EXPORT_DIR = "C:\\Users\\mock\\Videos\\exports";

/** `documentDir()` が返す固定のダミー書類フォルダ(`pickExportDirectory` の defaultPath 解決用)。 */
export const MOCK_DOCUMENT_DIR = "C:\\Users\\mock\\Documents";

/**
 * `convertFileSrc` が返すサンプル動画の URL(dev サーバの `public/mock/sample.mp4`)。
 * 元動画プレビュー・書き出し結果プレビュー・最終プレビューのすべてで同じサンプルを使う
 * (`convertFileSrc` は引数のパスを無視して常にこの URL を返す)。
 */
export const MOCK_SAMPLE_URL = "/mock/sample.mp4";

/** `preview://done`/`reframe://done` のダミー出力パス(`convertFileSrc` で上記 URL に解決される)。 */
export const MOCK_OUTPUT_PATH = "C:\\Users\\mock\\Videos\\mock-output.mp4";

/**
 * `probe` が返す固定の解析結果。1920x1080 / 30fps / 37.5s / h264 / 音声ありの
 * 横向き素材を模す(`public/mock/sample.mp4` の実尺とは独立したダミー値)。
 */
export const MOCK_PROBE: MediaInfo = {
	duration: 37.5,
	width: 1920,
	height: 1080,
	sar: "1:1",
	dar: "16:9",
	fps: 30,
	hasAudio: true,
	codec: "h264",
};

/**
 * `check()`(`@tauri-apps/plugin-updater`)が dev:mock で返す固定の更新情報
 * (§mock/updater.ts)。UpdateNotification バナーの目視確認用に、起動のたびに
 * 「更新あり」状態を再現する固定値。
 */
export const MOCK_UPDATE_INFO = {
	version: "9.9.9-mock",
	body: "モック更新(UI 確認用のダミーリリースノートです。dev:mock では常にこの更新が「利用可能」として通知されます。",
};

/**
 * `ig_job_status` の既定応答(`IgJobStatusOutcome` の `found` variant)が包む
 * `JobRecord` 本体。`src/test/tauri-mock.ts` の `MOCK_IG_JOB_RECORD` と同じ値
 * (テスト用モックとブラウザ用 dev:mock で見た目を揃える)。`id` は呼び出し側が
 * 渡した `schedulerJobId` で上書きされる(§mock/core.ts の `ig_job_status` ケース)。
 */
export const MOCK_IG_JOB_RECORD: JobRecord = {
	id: "scheduler-job-1",
	idempotencyKey: "11111111-2222-3333-4444-555555555555",
	platform: "instagram",
	r2Key: "posts/2026-07-10/uuid.mp4",
	mediaType: "REELS",
	caption: "",
	publishAt: 1_783_686_896_000,
	status: "published",
	igContainerId: "container-1",
	igMediaId: "media-1",
	attempts: 1,
	lastError: null,
	createdAt: 1_783_686_896_000,
	updatedAt: 1_783_686_896_000,
};
