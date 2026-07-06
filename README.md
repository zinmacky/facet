# reframe

横動画を 9:16 / 1:1 / 4:5 に再フレーミングし、**YouTube と Instagram へフル自動で予約公開**するためのローカル編集 + Cloudflare スケジューラ。

設計の核心は **「YouTube と Instagram で経路を無理に揃えない」** こと:

- **YouTube** はサーバ側予約(`publishAt`)が効くので、Mac から直接投げて終わり。Cloudflare を噛ませない。
- **Instagram** はサーバ側予約が無いので、Cloudflare 側にスケジューラ(Cron + Durable Object)を持つ。

この非対称をそのまま設計に落としている。

```
                 ┌──────────────── Mac (apps/studio) ────────────────┐
                 │  web (React/Vite)  ──  server (Hono @ localhost)   │
                 └───────┬───────────────────────────┬───────────────┘
       YouTube 直投稿    │                            │  R2 アップ + POST /jobs
   (resumable + publishAt)                            │
                 ┌───────▼────────┐        ┌──────────▼──────────────────────┐
                 │  YouTube Data  │        │  Cloudflare (apps/scheduler)     │
                 │   API v3       │        │  Worker + D1 + Durable Object    │
                 └────────────────┘        │  + Cron(毎分/日次)              │
                                           └──────────┬───────────────────────┘
                                    media_publish 時に │ video_url を取りに来る
                                           ┌──────────▼──────────┐
                                           │  R2 公開バケット      │  ← Graph API →
                                           │  media.dysalgia.com  │
                                           └──────────────────────┘
```

> 図に描きづらい重要な線が 1 本: Instagram は `media_publish` 時に **R2 の公開 URL へ動画を取りに来る**(Graph API → R2)。だから R2 は公開バケット(カスタムドメイン)にしておく必要がある。これが「1:1 を R2 に置く」理由。

## リポジトリ構成(pnpm monorepo)

編集コア(純粋ロジック)/ FFmpeg アダプタ / ローカルアプリ / Cloudflare の 4 層。`core` は FFmpeg もネットワークも知らない純関数だけ。

| パッケージ | 役割 | I/O |
|---|---|---|
| `packages/core` | filtergraph 合成・プリセット・EditSpec→FilterPlan | なし(純関数) |
| `packages/ffmpeg-runner` | ffprobe/ffmpeg の spawn・進捗パース | Node 専用 |
| `packages/contract` | ローカル↔クラウドの唯一の共有型(zod) | なし |
| `apps/studio/server` | Hono @ localhost。書き出し・YouTube 直・R2+ジョブ登録 | Node |
| `apps/studio/web` | React+Vite。プレビュー・イン/アウト・クロップ枠・キュー | ブラウザ |
| `apps/scheduler` | Cloudflare Worker。D1 + Cron + DO で IG 予約公開 | Worker |

`contract` が肝: ローカルとクラウドが共有する唯一の型。zod スキーマ 1 枚を両者が import することで、ジョブ登録の齟齬をコンパイル時に潰す。

## Instagram 公開のステートマシン(Durable Object)

Instagram は「コンテナ生成 → 処理完了までポーリング → 公開」の 3 手で、コンテナは約 24 時間で失効する。だから予約時刻より前に作り置きせず、時刻到来時に一気にやる。ポーリングの待ちは Worker 1 回の実行に押し込むと CPU 制限に触れるので、**DO の alarm で刻む非同期ステートマシン**にする。

1. Cron(毎分)が `status='pending' AND publish_at<=now` を拾い、対応する DO を起こす
2. DO: `/media` に POST(`media_type` と R2 公開 URL の `video_url`)→ `creating` → container_id 保存 → alarm を +15 秒
3. alarm: `?fields=status_code` をポーリング — `IN_PROGRESS` なら再 alarm、`FINISHED` なら `/media_publish`、`ERROR`/`EXPIRED` なら `failed`
4. 公開成功で `published`、media_id 保存

冪等キー(`idempotencyKey`)と attempts 上限で、Cron の多重発火や alarm 再試行でも二重投稿しない。

> 1:1 はフィード動画投稿(`media_type=VIDEO`、3〜60 秒)で Reels ではない。Reels(9:16・5〜90 秒)にしたければ別プリセット。

## 着工前に必ず潰すべきリスク(デリスク優先)

1. **YouTube publishAt の実証(半日)** — 2020-07-28 以降作成でコンプライアンス監査未通過のアプリは、動画を **private でしかアップできず public に切り替えられない**。これに引っかかると「フル自動でアップしたのに全部 private 止まり=手動公開が必要」になり前提が崩れる。自分のチャンネル+自分の OAuth アプリで、`publishAt` による private→public 自動フリップが実際に効くかを最小コードで先に確認。
2. **IG 最小公開(1〜2日)** — 開発モードで自アカウントをテストユーザー登録し、R2 の公開 URL → container → publish を手動トリガで 1 本通す。審査を回避できるか確認。
3. `core` の filtergraph + `ffmpeg-runner`(2〜3日) — trim/crop/blur-pad を合成、VideoToolbox で書き出し。CLI だけでテスト可能。
4. `studio` UI(プレビュー・イン/アウト・クロップ枠)
5. `scheduler`(D1 + Cron + DO + トークン更新)
6. 配線(studio → YouTube 直 / R2+contract → scheduler)

**1 と 2 が両方グリーンになってから 3 以降に本腰。** どちらかが赤なら「フル自動」の形が変わるので、そこだけ先に潰す。

## トークン更新

両方とも自動更新の設計が要る:

- **IG 長期ユーザートークン**は約 60 日で失効 → Cloudflare の日次 Cron(`token-refresh.ts`)で期限前にリフレッシュ、KV に保管。
- **YouTube の refresh token** は長寿命だが、失効時の再認証導線だけ用意しておく。

## 開発

```bash
corepack enable
pnpm install
pnpm build          # turbo で全パッケージビルド
pnpm test           # 全パッケージのテスト
pnpm typecheck

# 個別
pnpm --filter @reframe/core test
pnpm --filter @reframe/studio-server dev     # localhost:5178
pnpm --filter @reframe/studio-web dev        # localhost:5179
pnpm --filter @reframe/scheduler dev         # wrangler dev :8787
```

### 必要な環境

- Node.js >= 22, pnpm 9(corepack)
- FFmpeg 8+(VideoToolbox エンコーダ推奨: `h264_videotoolbox` / `hevc_videotoolbox`)
- Cloudflare アカウント(D1 / KV / Durable Objects / R2 公開バケット)
- Google Cloud プロジェクト(YouTube Data API v3 OAuth)
- Meta 開発者アプリ(Instagram Graph API / IG プロ アカウント)

シークレットは `.env`(studio)と `wrangler secret`(scheduler)で注入。リポジトリにコミットしない。
