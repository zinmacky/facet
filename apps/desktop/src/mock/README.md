# src/mock

`pnpm --filter @facet/desktop dev:mock`(`vite --mode mock --port 5190`)専用の
Tauri ランタイムモック。**プロダクトビルド(`pnpm build`)・通常の `pnpm dev`(実 Tauri)には
一切含まれない** — `../../vite.config.ts` が `mode === "mock"` のときのみ
`resolve.alias` で以下のモジュールへ差し替える(通常ビルドでは alias 自体が無いため、
`@tauri-apps/api/*` 等は実パッケージのまま解決され、このディレクトリは import グラフに
現れない)。

## ファイル

- `core.ts` — `@tauri-apps/api/core` 差し替え(`invoke`/`convertFileSrc`)。
- `event.ts` — `@tauri-apps/api/event` 差し替え(`listen`)。
- `path.ts` — `@tauri-apps/api/path` 差し替え(`join`)。
- `dialog.ts` — `@tauri-apps/plugin-dialog` 差し替え(`open`)。
- `opener.ts` — `@tauri-apps/plugin-opener` 差し替え(`openPath`)。
- `eventBus.ts` — `listen`/`emit` を模した renderer 内完結のイベントバス。
- `jobRunner.ts` — `reframe_start`/`preview_start` の進捗シミュレーション
  (200ms 刻み、3s で 0→100%、`reframe_cancel` で中断)。
- `fixtures.ts` — 固定のダミーパス・probe 結果・サンプル動画 URL。

`src/test/tauri-mock.ts`(vitest 用、`vi.mock` ベース)とは独立実装。こちらは
実行時の動的 import 差し替え(vite alias)のため `vi.mock` は使えない。

## 挙動

- `pickVideoFile`(dialog `open`, `directory: false`): 固定パスを即返す。
- `pickExportDirectory`(dialog `open`, `directory: true`): 固定ディレクトリを即返す。
- `probe`: 1920x1080 / 30fps / 37.5s / h264 / 音声ありを返す。
- `convertFileSrc`: 引数を無視して常に `/mock/sample.mp4`
  (= `public/mock/sample.mp4`、ffmpeg 生成の testsrc2+sine 5秒素材)を返す。
- `reframe_start`/`preview_start`: ジョブ ID を発行し、`jobRunner` が
  `{namespace}://progress/{jobId}` を 200ms 刻みで発火 → 3s で `{namespace}://done/{jobId}`。
  `reframe_cancel` で該当ジョブのタイマーを止める(done は発火しない)。
- `openPath`(フォルダを開く): `console.log` のみ。

## 状態注入(P2、未実装)

URL クエリ(例 `?fixture=clips3`)での初期状態注入は今回のスコープ外。
素の初期状態からブラウザで手操作して各画面に到達する運用を想定する。
