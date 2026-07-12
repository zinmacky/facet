# Facet

横向き動画を 9:16 / 1:1 / 4:5 / 16:9 に再フレーミングし、YouTube/Instagram へ
予約公開まで自動化するツール群。pnpm + turbo のモノレポ(TypeScript / Node >=22)。
`apps/desktop` のみ Rust(Tauri v2)を含む。

## コマンド

パッケージマネージャは **pnpm**。ルートから実行する。

- ビルド: `pnpm build`(= `turbo run build`)
- テスト: `pnpm test`。単一パッケージ: `pnpm --filter @facet/core test`。
  単一ファイル: `pnpm --filter @facet/contract exec vitest run src/job-manifest.test.ts`
- 型チェック: `pnpm -r typecheck`(全体で約6秒)
- lint: `pnpm lint`(= `biome lint .`)。整形: `pnpm format`(= `biome format --write .`)
- dev: `pnpm --filter @facet/studio-server dev` / `pnpm --filter @facet/studio-web dev`
  / `pnpm --filter @facet/scheduler dev`(wrangler)

### Rust(apps/desktop 内で実行)

- fmt: `cargo fmt --check` / clippy: `cargo clippy --workspace -- -D warnings`
  / テスト: `cargo test --workspace`(CI と同一ゲート)
- ローカルの FFmpeg は Homebrew + pkg-config で解決される。CI のみ FFMPEG_DIR を
  明示設定(.github/workflows/ci.yml 参照)
- `cargo deny` / `cargo audit` は CI のみ(ローカル未インストール)

コミット前に `pnpm -r typecheck` と `pnpm test` を実行する(フックは per-file lint のみ)。
apps/desktop の Rust を変更した場合は上記 fmt / clippy / テストも実行する。

## 構成

- `packages/contract` — studio と scheduler 間のジョブ契約(job-manifest)。共有の型/スキーマ。
- `packages/core` — 再フレーミングのコアロジック(filtergraph 生成、プリセット、型)。
- `packages/ffmpeg-runner` — ffmpeg/ffprobe の実行ラッパ(probe, runner)。
- `apps/studio/server` — ローカル編集アプリのサーバ(Hono @ localhost)。routes/ + services/。
- `apps/studio/web` — 編集 UI(React/Vite)。features/ 単位で機能を分割。
- `apps/scheduler` — Cloudflare Workers 上の予約公開スケジューラ(D1 + Durable Object + KV + Cron)。
- `apps/desktop` — Tauri v2 デスクトップアプリ(studio の後継として移行中、
  docs/desktop-migration-plan.md 参照)。React/Vite の `src/` +
  Rust workspace(`crates/media-core`, `crates/contract-rs`, `src-tauri`)。

パッケージ間参照は `@facet/*` の workspace エイリアスで行う。

## 注意

- `pnpm lint` は現在クリーン(0件)。編集ファイルに対する PostToolUse フックは
  lint **エラー**時のみ発火する(warning/info は非発火)。a11y 系の warning は
  フックをすり抜けるため、コミット前に `pnpm lint` で担保する。
- `pnpm format` は Biome 設定(タブインデント)で全体を再整形するため、意図せず
  広範な差分を生む。整形目的以外では実行しない。
- `dist/` は tsc の生成物。編集しない(生成元は各パッケージの `src/`)。
- `packages/contract/schema/*.json` は zod スキーマから build 時に生成される
  **コミット対象**。contract を変更したら `pnpm build` 後に
  `git diff --exit-code -- packages/contract/schema/` で生成漏れがないか確認する(CI がガード)。
