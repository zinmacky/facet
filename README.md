# Facet

![CI](https://github.com/zinmacky/facet/actions/workflows/ci.yml/badge.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-9135FF?logo=vite&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-00FF74?logo=vitest&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-F69220?logo=pnpm&logoColor=white)
![Turborepo](https://img.shields.io/badge/Turborepo-FF1E56?logo=turborepo&logoColor=white)
![Biome](https://img.shields.io/badge/Biome-60A5FA?logo=biome&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-24C8D8?logo=tauri&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?logo=ffmpeg&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?logo=cloudflareworkers&logoColor=white)

横向きに撮った動画(バンドのライブ映像など)から手動でクリップを切り出し、
**9:16 / 1:1 / 4:5 / 16:9** へ再フレーミングして書き出すツール群です。
pnpm + turbo のモノレポ(TypeScript / Node >=22)で、現在の主力は
Tauri v2 製デスクトップアプリ `apps/desktop`(Rust)です。

自動ハイライト検出のようなものは行わず、クリップの切り出しは常に手動です。

## 主な機能

- **クリップ作成**: 1 本のソース動画から複数クリップを切り出し。トリム(イン/アウト点)
  とクロップ枠(移動・リサイズ)を GUI で操作します。
- **再フレーミング**: クロップ枠は 16:9 / 4:3 / 1:1 / 9:16 / 自由比のテンプレートに
  スナップ。書き出し時は 9:16 / 1:1 / 4:5 / 16:9 向けのプリセットに対応し、
  余白なしでクロップする `crop` と、被写体を切らずぼかした自身の拡大コピーで
  余白を埋める `blur-pad` の 2 種のフィットモードを選べます。
- **ハードウェアエンコード**: macOS は `h264_videotoolbox`、Windows は `h264_amf`
  (フォールバックとして `h264_mf`)を優先的に使用します。
- **書き出し**: 進捗表示付きでクリップをエンコードし、ファイルとして出力します。

## 技術スタック

- **フロントエンド**: React + Vite
- **デスクトップ**: Tauri v2(Rust)
- **メディア処理**: FFmpeg(libav を `ffmpeg-next` 経由で直接統合。HW エンコードは videotoolbox / amf)
- **モノレポ**: pnpm + Turborepo + Biome(lint/format)
- **テスト**: Vitest(TypeScript)+ `cargo test`(Rust)
- **スケジューラ**: Cloudflare Workers(D1 + Durable Object + KV + Cron)

## モノレポ構成

| パッケージ | 役割 |
|---|---|
| `packages/contract` | studio/desktop と scheduler 間のジョブ契約。共有の型・zod スキーマ |
| `packages/core` | 再フレーミングのコアロジック(filtergraph 生成・プリセット・型) |
| `packages/ffmpeg-runner` | ffmpeg / ffprobe の実行ラッパ(probe・runner) |
| `apps/desktop` | Tauri v2 デスクトップアプリ(現在の主力)。React/Vite の renderer + Rust workspace(`crates/media-core` で libav を直接統合、`crates/contract-rs`、`crates/license-gate`、`src-tauri`) |
| `apps/studio` | `server`(Hono)+ `web`(React/Vite)。旧来のローカル編集アプリで、`apps/desktop` への移行元(詳細は `docs/desktop-migration-plan.md`) |
| `apps/scheduler` | Cloudflare Workers 上の予約公開スケジューラ(D1 + Durable Object + KV + Cron)。開発者運用向けのクラウドコンポーネント |

## 開発セットアップ

- Node.js **22 以上**、pnpm **9.7.0**(`packageManager` 指定、corepack 経由)
- Rust **stable**
- FFmpeg **8.x**
  - **Mac**: Homebrew(`brew install ffmpeg`)。pkg-config 経由でリンクされるため
    `FFMPEG_DIR` の設定は不要です。
  - **Windows**: 環境変数 `FFMPEG_DIR` と `LIBCLANG_PATH` の設定、および
    PATH への `ffmpeg\bin` の追加が必要です。

```bash
corepack enable
pnpm install
pnpm build
```

## 主要コマンド

ルートから実行します。

```bash
pnpm build          # 全パッケージビルド(turbo run build)
pnpm test           # 全パッケージのテスト(turbo run test)
pnpm -r typecheck   # 型チェック(全体で数秒)
pnpm lint           # biome lint .
pnpm format         # biome format --write .(整形目的以外では実行しない)
```

単一パッケージ・単一ファイルの実行例:

```bash
pnpm --filter @facet/core test
pnpm --filter @facet/contract exec vitest run src/job-manifest.test.ts
```

dev サーバの起動:

```bash
pnpm --filter @facet/desktop dev         # Tauri アプリ本体
pnpm --filter @facet/desktop dev:mock    # ブラウザから renderer のみ確認(モックハーネス)
pnpm --filter @facet/studio-server dev
pnpm --filter @facet/studio-web dev
pnpm --filter @facet/scheduler dev       # wrangler dev
```

`apps/desktop` の Rust 部分を変更した場合は `apps/desktop` 内で以下も実行します。

```bash
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

## ライセンス

本リポジトリ自体は MIT License(`LICENSE` 参照)です。`apps/desktop` の配布物には
FFmpeg の共有ライブラリを LGPL v3 構成で動的リンク・同梱しています。詳細な出典・
ライセンス条文へのリンクは [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) を
参照してください。

## 関連ドキュメント

- `docs/desktop-migration-plan.md` — `apps/studio` から `apps/desktop` への移行計画
- `docs/mac-handover.md` — 開発環境の現状と進捗
