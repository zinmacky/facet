# Facet

横向きに撮った動画を **9:16 / 1:1 / 4:5 / 16:9** に再フレーミングし、**YouTube と Instagram へ予約公開まで自動化**するためのツール群です。

Mac 上で動くローカル編集アプリ(**studio**)で切り抜き・書き出しを行い、
YouTube へは直接、Instagram へは Cloudflare 上のスケジューラ(**scheduler**)経由で公開します。

- **YouTube** … サーバ側予約(`publishAt`)が使えるため、Mac から直接アップロードして予約公開まで完結します。
- **Instagram** … サーバ側予約が無いため、Cloudflare 側に常駐スケジューラ(Cron + Durable Object)を置き、指定時刻に自動公開します。

```
        ┌──────────── Mac: studio(ローカル編集アプリ)────────────┐
        │   web (React/Vite ブラウザ UI)  ──  server (Hono @ localhost) │
        └──────┬─────────────────────────────────────┬──────────────┘
   YouTube 直投稿 │                                     │ R2 アップロード + ジョブ登録
 (resumable+予約) │                                     │
        ┌───────▼────────┐              ┌──────────────▼───────────────────┐
        │ YouTube Data   │              │ Cloudflare: scheduler             │
        │ API v3         │              │ Worker + D1 + Durable Object + KV │
        └────────────────┘              │ + Cron(毎分:公開 / 日次:トークン)│
                                        └──────────────┬───────────────────┘
                             media_publish 時に video_url を取得
                                        ┌──────────────▼──────────────┐
                                        │ R2 公開バケット(カスタムドメイン)│ ←Graph API→
                                        └──────────────────────────────┘
```

> Instagram は公開実行(`media_publish`)時に **R2 の公開 URL へ動画を取りに来ます**。そのため R2 は公開バケット(カスタムドメイン付き)である必要があります。

---

## 主な機能

### 動画編集(studio web)
- **ソース選択**: macOS のネイティブファイルダイアログから動画を選択。`ffprobe` で解像度・尺・fps・音声有無などを自動取得。
- **プレビュー**: ブラウザ上で元動画を再生(サーバが Range 対応でローカルファイルを配信)。
- **イン/アウト点(トリム)**: タイムラインのハンドルをドラッグして開始・終了位置を秒単位で指定。離した瞬間に該当区間を自動再生。
- **クロップ枠**: 動画の上に重なる矩形をドラッグ移動・四隅リサイズ。目標アスペクト比へのスナップ、三分割ガイド線、外側の暗幕表示付き。
- **複数クリップ**: 1 本のソースから複数の切り抜き(クリップ)を作成。名前のインライン編集・並び管理が可能。
- **アスペクト比テンプレート**: 16:9 / 4:3 / 1:1 / 9:16 / 自由。

### 書き出し(エンコード)
- **フィットモード 2 種**:
  - `crop` … 目標枠を覆うようにスケールして中央クロップ(余白なし・端が切れる)。
  - `blur-pad` … 全体を収め、余白をぼかした自身の拡大コピーで埋める(被写体を切らない)。
- **ハードウェアエンコード**: Apple VideoToolbox(`h264_videotoolbox` / `hevc_videotoolbox`)を既定使用。
- **ソフトウェアフォールバック**: VideoToolbox が使えない場合は自動的に `libx264` へ 1 回だけ再試行。UI に「SW」バッジで表示。
- **同時実行制御**: VideoToolbox の同時セッション上限に合わせ、既定 2 本までに制限(`MAX_CONCURRENT_ENCODES` で変更可)。
- **進捗表示**: SSE(Server-Sent Events)で書き出し進捗・fps・通知をリアルタイム配信。
- **一括ダウンロード**: 全クリップを ZIP で保存(mp4 は無圧縮 store)。

### 公開(アップロード)
- **Post / Output の二層モデル**: 1 つの Post(投稿)は複数の出力先(Output)を持ち、同一時刻に複数プラットフォームへ同時投稿できます。
- **出力先テンプレート**:
  | 出力先 | プラットフォーム | 解像度 |
  |---|---|---|
  | YouTube 横 (16:9) | YouTube | 1920×1080 |
  | YouTube ショート (9:16) | YouTube | 1080×1920 |
  | Instagram 正方形 (1:1) | Instagram | 1080×1080 |
  | Instagram 縦 (4:5) | Instagram | 1080×1350 |
  | Instagram リール (9:16) | Instagram | 1080×1920 |
- **一括設定**: 出力先 × フィットモードの組を全 Post へまとめて適用。
- **予約スケジュール生成**: 開始日/終了日・曜日・曜日ごとの時刻を指定すると公開時刻リストを生成し、各 Post に順番に割り当て。
- **YouTube 直投稿**: OAuth(refresh token)で resumable upload。`publishAt` 指定により private → public への自動切り替え(予約公開)。
- **Instagram 予約公開**: 動画を R2 にアップロードし、scheduler にジョブ登録。指定時刻に Cloudflare 側が自動公開。VIDEO(フィード動画)/ REELS に対応。
- **キュー監視**: 登録したジョブの状態(pending → creating → processing → publishing → published / failed)を UI からポーリング。

### 自動スケジューラ(scheduler / Cloudflare)
- **毎分 Cron**: 公開時刻が到来した Instagram ジョブを検出し、対応する Durable Object を起動。
- **公開ステートマシン(Durable Object)**: コンテナ生成 → 処理完了を 15 秒間隔でポーリング → 公開、を 1 ジョブ 1 インスタンスで直列実行。冪等キーと試行回数上限で二重投稿を防止。
- **日次 Cron**: Instagram の長期トークン(約 60 日で失効)を期限前に自動リフレッシュし KV に保管。

---

## 技術スタック

| 領域 | 採用技術 |
|---|---|
| 言語 / ビルド | TypeScript 5.6、pnpm workspace(monorepo)、Turborepo |
| 編集コア | 純 TypeScript(FFmpeg filtergraph 合成ロジック、外部依存なし) |
| エンコード | FFmpeg 8+ / ffprobe(VideoToolbox・libx264) |
| ローカルサーバ | Hono 4 + @hono/node-server(Node.js) |
| ローカル UI | React 18 + Vite 5 + Tailwind CSS 3 + TanStack Query 5 |
| 型の共有 | zod 3(ローカル↔クラウドの共有スキーマ) |
| 外部 API | YouTube Data API v3(googleapis)、Instagram Graph API、Cloudflare R2(aws4fetch / S3 互換) |
| クラウド | Cloudflare Workers + D1 + Durable Objects + KV + Cron + R2 |

### リポジトリ構成(pnpm monorepo)

| パッケージ | 役割 | I/O |
|---|---|---|
| `packages/core` | filtergraph 合成・プリセット・`EditSpec` → `FilterPlan` | なし(純関数) |
| `packages/ffmpeg-runner` | ffprobe / ffmpeg の実行・進捗パース・フォールバック | Node 専用 |
| `packages/contract` | ローカル↔クラウドの唯一の共有型(zod) | なし |
| `apps/studio/server` | Hono @ localhost。書き出し・YouTube 直投稿・R2+ジョブ登録 | Node |
| `apps/studio/web` | React+Vite。プレビュー・トリム・クロップ枠・キュー | ブラウザ |
| `apps/scheduler` | Cloudflare Worker。D1 + Cron + DO で IG 予約公開 | Worker |

---

## 推奨スペック

### studio(ローカル編集アプリ)を動かす環境
- **OS**: **macOS 必須**。
  - ファイル選択に `osascript`、ハードウェアエンコードに Apple VideoToolbox を使うため、動作対象は macOS のみです。
- **CPU/GPU**: **Apple Silicon(M1 以降)を推奨**。
  - VideoToolbox によるハードウェアエンコードで書き出しが高速化します。Intel Mac でも動作しますが `libx264`(ソフトウェア)中心となり低速です。
- **メモリ**: 8GB 以上(16GB 推奨)。複数クリップの同時書き出しを行う場合は余裕を持たせてください。
- **ストレージ**: 書き出し中間ファイルを `./.work`(既定)に生成するため、扱う動画の数倍の空き容量。
- **ソフトウェア**:
  - Node.js **22 以上**、pnpm **9**(corepack 経由)
  - **FFmpeg 8+**(`ffmpeg` / `ffprobe` が PATH 上にあること。VideoToolbox 対応ビルド推奨)

### クラウド側(Instagram 予約公開を使う場合)
- **Cloudflare アカウント**: Workers / D1 / Durable Objects / KV / **R2 公開バケット(カスタムドメイン)**。
- **Google Cloud プロジェクト**: YouTube Data API v3 の OAuth クライアント。
- **Meta 開発者アプリ**: Instagram Graph API + Instagram プロアカウント(ビジネス/クリエイター)。

> YouTube への公開のみであれば Cloudflare / Meta の設定は不要です。studio 単体でも編集・書き出し・YouTube 予約公開まで利用できます。

---

## セットアップ

### 1. 依存関係のインストールとビルド

```bash
corepack enable
pnpm install
pnpm build          # turbo で全パッケージをビルド
pnpm test           # 全パッケージのテスト
pnpm typecheck
```

FFmpeg が入っていない場合(macOS / Homebrew):

```bash
brew install ffmpeg
ffmpeg -version   # VideoToolbox 対応ビルドか確認
```

### 2. 環境変数(studio server)

`apps/studio/server` に `.env` を用意します(リポジトリにはコミットしないこと)。

| キー | 既定値 | 説明 |
|---|---|---|
| `PORT` | `5178` | server の待受ポート |
| `WORK_DIR` | `./.work` | 書き出し中間ファイルの置き場 |
| `SCHEDULER_URL` | `http://localhost:8787` | scheduler の URL(IG 公開時) |
| `YOUTUBE_CLIENT_ID` | — | YouTube OAuth(YouTube 公開時のみ) |
| `YOUTUBE_CLIENT_SECRET` | — | 同上 |
| `YOUTUBE_REDIRECT_URI` | — | 同上 |
| `YOUTUBE_REFRESH_TOKEN` | — | 同上 |
| `R2_ACCOUNT_ID` | — | Cloudflare R2(IG 公開時のみ) |
| `R2_ACCESS_KEY_ID` | — | 同上 |
| `R2_SECRET_ACCESS_KEY` | — | 同上 |
| `R2_BUCKET` | `facet-media` | R2 バケット名 |
| `R2_PUBLIC_BASE` | — | R2 の公開ベース URL(例: `https://media.dysalgia.com`) |
| `MAX_CONCURRENT_ENCODES` | `2` | 同時書き出し本数 |

> YouTube / R2 の値は未設定でも起動します(実際に公開機能を使う経路で不足が検出されます)。編集と書き出しだけなら空でも構いません。

### 3. 環境変数(scheduler / Cloudflare)

`apps/scheduler/wrangler.toml` の `database_id`・KV `id` を自分のリソース ID に差し替え、公開バリューを設定します。

```toml
[vars]
IG_USER_ID     = "<Instagram ユーザー ID>"
IG_APP_ID      = "<Facebook App ID>"
R2_PUBLIC_BASE = "https://media.example.com"
GRAPH_VERSION  = "v21.0"
MAX_ATTEMPTS   = "5"
```

シークレットは `wrangler secret` で投入(リポジトリに置かない):

```bash
wrangler secret put IG_APP_SECRET
```

D1 のマイグレーション適用:

```bash
pnpm --filter @facet/scheduler migrate:local    # ローカル
pnpm --filter @facet/scheduler migrate:remote   # 本番
```

---

## 利用マニュアル

### 起動

3 つのプロセスを起動します(YouTube のみ使う場合は scheduler は不要)。

```bash
# 1) ローカル API サーバ(書き出し・公開の実処理)
pnpm --filter @facet/studio-server dev     # http://localhost:5178

# 2) ブラウザ UI(操作画面)
pnpm --filter @facet/studio-web dev        # http://localhost:5179

# 3) Instagram スケジューラ(IG 予約公開を使う場合のみ)
pnpm --filter @facet/scheduler dev         # wrangler dev :8787
```

ブラウザで **http://localhost:5179** を開きます。

### 編集〜公開の流れ

1. **ソースを選択**
   「ファイルを開く」でネイティブダイアログから横向き動画を選択します。選択と同時に 1 本目の切り抜きが自動追加されます。

2. **切り抜きを作る**
   - **トリム**: タイムラインのハンドルをドラッグして公開したい区間の開始/終了を決めます。
   - **クロップ枠**: プレビュー上の枠を移動・リサイズし、被写体が入る範囲を決めます。アスペクト比テンプレート(9:16 など)を選ぶと枠がその比率にスナップします。
   - 必要に応じて「+」で切り抜きを追加し、1 本のソースから複数のクリップを作成します。各クリップは名前を編集できます。

3. **書き出し(EXPORT)**
   「すべて書き出し」で EXPORT モーダルを開きます。各クリップのマスター(クロップ内容そのもの)をエンコードします。
   - 進捗バーと fps が表示されます。
   - VideoToolbox が使えない場合は自動で `libx264` に切り替わり、「SW」バッジが出ます(そのまま完了します)。
   - 完了後、個別プレビュー・ダウンロード、または全クリップの ZIP 一括ダウンロードが可能です。

4. **公開(UPLOAD)**
   EXPORT から UPLOAD モーダルへ進みます。
   - **出力先を追加**: 各 Post に対し、YouTube 横/ショート、Instagram 正方形/縦/リールなどの出力先(Output)を複数指定できます。同一 Post 内の出力先はすべて同じ時刻に投稿されます。
   - **フィット**: 出力先ごとに `crop` / `blur-pad` を選択。
   - **メタデータ**: YouTube はタイトル・説明、Instagram はキャプション(最大 2200 文字)を入力。
   - **一括設定**: 出力先とフィットの組を全 Post にまとめて適用できます。
   - **予約時刻**: 開始日・終了日・曜日・時刻を指定してスケジュールを生成し、「この順で割り当て」で各 Post に公開時刻を割り当てます。
   - 「生成/プレビュー更新」で各出力先の最終動画を確認し、投稿を実行します。

5. **投稿後の状態**
   - **YouTube**: `publishAt` 指定で private アップロード → 指定時刻に自動公開。
   - **Instagram**: R2 へアップロード後、scheduler にジョブ登録。UI 上のステータス(pending → creating → processing → publishing → published)で進行を確認できます。失敗時は `failed` と理由が表示されます。

### 補足・注意

- **Instagram の公開種別**: 1:1 はフィード動画(`VIDEO`、3〜60 秒)、9:16 はリール(`REELS`、5〜90 秒)です。尺の制約に注意してください。
- **R2 は公開バケット必須**: Instagram は公開時に R2 の URL へ動画を取りに来るため、R2 はカスタムドメイン付きの公開バケットにしておく必要があります。
- **トークン失効**:
  - Instagram の長期トークンは約 60 日で失効しますが、日次 Cron が自動リフレッシュします。
  - YouTube の refresh token 失効時は再認証が必要です。
- **YouTube の予約公開(重要)**: 2020-07-28 以降に作成し、コンプライアンス監査を通過していない OAuth クライアントは、動画を private でしかアップロードできず public に切り替えられない場合があります。本番運用前に、自分のチャンネルで `publishAt` による private→public 自動切り替えが効くか実証してください。

---

## 配布(デスクトップ版 / Windows)

`apps/desktop`(Tauri v2)は Windows 向けに NSIS インストーラとして
GitHub Releases 経由で配布します(公開リポジトリ、署名なし・as-is 提供)。

- **as-is 提供**: 動作を保証するものではなく、無償・現状有姿で提供します。
  不具合や環境依存の問題について個別サポートは行いません。
- **同梱 FFmpeg のライセンス**: 配布物には FFmpeg の共有ライブラリ(LGPL v3、
  動的リンク)を同梱しています。GPL 専用コンポーネント(libx264 等)は
  同梱していません。詳細は [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)
  を参照してください。

### Windows SmartScreen の警告について

このインストーラは Authenticode 署名を行っていません。初回ダウンロード・
初回実行時に Windows から以下のような警告が表示されることがあります。

- ブラウザのダウンロード時: 「このファイルは一般的にダウンロードされていません。
  安全に開けない可能性があります」等の警告
- 実行時: 「Windows によって PC が保護されました」という SmartScreen の警告画面

これは署名済みバイナリではないこと、かつダウンロード数が少ないことに起因する
一般的な挙動であり、回避することはできません(署名証明書の取得コストの都合で
現時点では署名を行っていません)。内容を確認のうえ実行する場合は、以下の手順で
進めてください。

1. SmartScreen の警告画面で「**詳細情報**」をクリックする
2. 表示された「**実行**」ボタンをクリックする

> **アプリ内更新(自動アップデート)時は通常この警告が表示されません**。
> Windows の SmartScreen / MOTW(Mark of the Web)チェックは主に
> ブラウザ経由でダウンロードしたファイルに付与される識別子(Zone.Identifier)に
> 基づいており、アプリ内蔵のアップデータ(Tauri updater)が取得・適用する
> 更新ファイルにはこの識別子が付与されないため、初回インストール時のような
> 警告は基本的に発生しません。

---

## 開発

```bash
pnpm build          # 全パッケージビルド(turbo)
pnpm test           # 全パッケージのテスト
pnpm typecheck      # 型チェック
pnpm lint

# 個別パッケージ
pnpm --filter @facet/core test
pnpm --filter @facet/scheduler test
```

- `packages/core` は FFmpeg もネットワークも知らない純関数のみで構成され、`EditSpec` → `FilterPlan` の変換をスナップショットテストで検証します。
- `packages/contract` の zod スキーマ 1 枚をローカルとクラウドの双方が import することで、ジョブ登録の齟齬をコンパイル時に検出します。

### シークレット管理

認証情報は `.env`(studio)と `wrangler secret`(scheduler)で注入し、**リポジトリにはコミットしません**。`.gitignore` で `.env` 系・`.dev.vars`・`.wrangler/` を除外済みです。
