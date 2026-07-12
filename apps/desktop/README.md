# @facet/desktop

Tauri v2 デスクトップ版(renderer は React/Vite、`apps/desktop/src`)。

## dev:mock(ブラウザ用モックモード)

`pnpm --filter @facet/desktop dev:mock` で renderer を通常ブラウザから
`http://localhost:5190` として開ける(Tauri ネイティブウィンドウ無し)。
`@tauri-apps/api/*`・`plugin-dialog`・`plugin-opener` を `src/mock/` のダミー実装へ
差し替え、`probe`/`reframe_start`/`preview_start` 等をその場でシミュレートする
(詳細は `src/mock/README.md`)。UIUX 確認のスクリーンショット撮影専用で、
`pnpm build`/`pnpm dev`(実 Tauri)には一切混入しない。
