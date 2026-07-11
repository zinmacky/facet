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
