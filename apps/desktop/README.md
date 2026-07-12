# @facet/desktop

Tauri v2 デスクトップ版(renderer は React/Vite、`apps/desktop/src`)。

## dev:mock(ブラウザ用モックモード)

`pnpm --filter @facet/desktop dev:mock` で renderer を通常ブラウザから
`http://localhost:5190` として開ける(Tauri ネイティブウィンドウ無し)。
`@tauri-apps/api/*`・`plugin-dialog`・`plugin-opener`・`plugin-updater`・`plugin-process` を
`src/mock/` のダミー実装へ差し替え、`probe`/`reframe_start`/`preview_start`/更新確認
(`check`)等をその場でシミュレートする(詳細は `src/mock/README.md`)。UIUX 確認の
スクリーンショット撮影専用で、
`pnpm build`/`pnpm dev`(実 Tauri)には一切混入しない。
