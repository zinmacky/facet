# Facet セルフホスト手順書

> 最終更新: 2026-07-13(記載内容は 2026-07-13 時点の実装・外部仕様に基づく。
> Meta / Google 側のポリシー・画面は変動するため、詰まった場合は各社の公式
> ドキュメントを優先する)

## 対象読者

この手順書は、Facet desktop の **private エディション**(公開連携込みのフル機能版)
を自分の環境で動かしたい技術者向けです。Facet は OSS として無料配布されていますが、
配布版(public エディション)には Instagram / YouTube への予約公開機能が含まれて
いません(切り抜き + reframe + 書き出しのみ)。理由は審査・運用負債を避けるためで、
公開連携を使うには **自分の Cloudflare / Meta / Google アカウントを使って private
エディションを自分でビルドする**必要があります(詳細な設計判断は
[docs/desktop-migration-plan.md](./desktop-migration-plan.md) §2・§6.6 を参照)。

運用責任(Meta/Google のポリシー順守、トークンの管理、Cloudflare の費用)はすべて
セルフホストする本人が負います。作者による相乗り・サポートはありません。

### 現状でできること / できないこと(重要)

- **Instagram の予約公開は実装済み**です(R2 アップロード + scheduler 経由の予約公開)。
- **YouTube の予約公開は desktop 側に未実装**です(2026-07-13 時点。コード上も
  YouTube 投稿は明示的にスコープ外とされており、UI 上のボタンも「デスクトップ版
  では未対応」と表示されます)。§4 は将来の実装に備えた**準備作業**として記載して
  いますが、desktop アプリ側の接続 UI が存在しないため、今すぐ接続はできません。
  実装が進み次第この文書を更新します。

---

## 1. private ビルド

private ビルドは `com.facet.desktop.private` という別 identifier でビルドされ、
public エディションと共存インストールできます。自動アップデートは無効なので、
更新したい場合は都度ソースを pull して再ビルドします(§6)。

### 1.0 共通の前提ツール

- Node >=22
- pnpm 9.7.0(リポジトリの `package.json` の `packageManager` で固定)
- Rust stable
- FFmpeg 8.x(OS ごとに入手方法が異なる。下記参照)

まずリポジトリ直下で依存関係を入れ、`@facet/contract` / `@facet/core` などの
ビルド成果物(dist/schema)を先に作ります(private ビルドコマンド自体は
`turbo` の `build` タスクに連結されていないため、これを飛ばすと desktop 側の
ビルドが依存パッケージ未生成で失敗します)。

```sh
pnpm install
pnpm --filter "@facet/desktop^..." build   # contract/core 等の依存を先にビルド
```

### 1.1 Mac 版(`build:mac-private`)

Homebrew で FFmpeg を入れます(pkg-config 経由で自動リンクされるため
`FFMPEG_DIR` の設定は不要です)。

```sh
brew install ffmpeg   # 8.1系であること(ffmpeg-next 8.1 が要求する ABI)
ffmpeg -version        # 8.1.x であることを確認
```

ビルド:

```sh
pnpm --filter @facet/desktop build:mac-private
```

生成物: `apps/desktop/src-tauri/target/release/bundle/macos/Facet desktop Private.app`
(dmg も同時生成されます)。

Mac の private ビルドは FFmpeg の共有ライブラリを同梱せず、ビルド時にリンクした
Homebrew の FFmpeg を実行時にも参照します。**ビルドしたマシンと同じマシンで実行**
する分には問題ありませんが、別マシンに `.app` だけコピーして動かす場合は、
そのマシンにも同じ系統の Homebrew FFmpeg が入っている必要があります(mac 版の
配布用パッケージング — LGPL 動的リンクの同梱 — はこの計画では想定していません。
[docs/phase4-packaging.md](./phase4-packaging.md) 参照)。

### 1.2 Windows 版(`build:win-private`)

Windows は Media Foundation / AMF 用のビルド環境(Visual Studio Build Tools、
LLVM/libclang、FFmpeg の shared ビルド)が必要です。手順の詳細(winget コマンド等)
は [docs/phase2-0-windows-setup.md](./phase2-0-windows-setup.md) §2 を参照してください
(そこは開発用 GPL ビルドの手順ですが、Build Tools/rustup/LLVM のセットアップ部分は
共通です)。

**配布物と同じ LGPL 構成でビルドする**ため、開発用の GPL ビルドではなく
`scripts/fetch-ffmpeg-lgpl.ps1` で LGPL ビルドを取得します:

```powershell
$lgplRoot = ./scripts/fetch-ffmpeg-lgpl.ps1
$env:FFMPEG_DIR = $lgplRoot
$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"

pnpm --filter @facet/desktop build:win-private
```

`fetch-ffmpeg-lgpl.ps1` は BtbN の日付固定タグから LGPL shared ビルドを取得し、
DLL のみを `apps/desktop/src-tauri/ffmpeg-dist/` にステージングします(実行ファイル
は含めません)。`tauri.win-private.conf.json` がこの DLL 群と
`LICENSES/COPYING.LGPLv3` をインストーラに同梱します。

生成物: `apps/desktop/src-tauri/target/release/bundle/nsis/Facet desktop Private_*.exe`

任意の追加検証(推奨): `./scripts/run-license-gate.ps1` で、実際に LGPL の
FFmpeg にリンクされ GPL 系コンポーネント(libx264 等)が混入していないことを
確認できます(release ビルドの CI が使っているのと同じゲート)。

---

## 2. scheduler のデプロイ

Instagram はネイティブの予約公開 API を持たないため、`apps/scheduler`
(Cloudflare Workers + D1 + Durable Object + KV + Cron)が公開時刻の到来を検知して
実際の投稿を行います。自分の Cloudflare アカウント(無料枠で足ります)にデプロイ
します。

### 2.1 リソースの作成

`apps/scheduler/wrangler.toml` は以下のリソースを要求します:

- D1 データベース(`facet-jobs`、binding `DB`)
- KV ネームスペース(binding `TOKENS`、Instagram 長期トークンの保管用)
- Durable Object(`PublishDO`、binding `PUBLISH_DO`、ジョブごとの状態機械)

```sh
cd apps/scheduler
wrangler login
wrangler d1 create facet-jobs
wrangler kv namespace create TOKENS
```

出力される `database_id` / KV の `id` を `wrangler.toml` の
`REPLACE_WITH_D1_ID` / `REPLACE_WITH_KV_ID` に書き込みます(このファイルは
リポジトリにコミットされていますが、セルフホストでは自分の clone 上でのみ
書き換えれば十分です。third-party への配布は想定していないため公開リポジトリに
反映する必要はありません)。

D1 のスキーマ(`jobs` テーブル)を適用します:

```sh
pnpm migrate:remote   # = wrangler d1 migrations apply facet-jobs --remote
```

### 2.2 vars の設定

`wrangler.toml` の `[vars]` を自分の値に置き換えます:

- `IG_USER_ID`: 投稿先の Instagram プロフェッショナル(ビジネス/クリエイター)
  アカウントの IG User ID(§3 で取得)
- `IG_APP_ID`: 自分の Meta アプリの App ID(§3 で作成)
- `R2_PUBLIC_BASE`: R2 バケットの**公開読取可能な**ベース URL(§3.3。既定値の
  `https://media.dysalgia.com` は作者自身のカスタムドメインなので、自分の
  バケットの URL に必ず差し替える)
- `GRAPH_VERSION`: Graph API のバージョン(既定 `v21.0` のままで通常問題ない)
- `MAX_ATTEMPTS`: ポーリング失敗時の最大リトライ回数(既定 5)

### 2.3 シークレットの投入

vars ではなく `wrangler secret` で投入します(値が git に残らないようにするため):

```sh
wrangler secret put IG_APP_SECRET
wrangler secret put SCHEDULER_API_TOKEN
```

`SCHEDULER_API_TOKEN` は自分で生成したランダムな値(例:
`openssl rand -hex 32`)を使います。これは `/health` を除く全公開エンドポイント
(`GET /`、`POST /jobs`、`GET /jobs/:id`)を Bearer 認証で保護するトークンです。
**未設定のままデプロイすると保護対象エンドポイントは fail-closed で常に 503 を
返します**(無認証で通ることは絶対にありません — `apps/scheduler/src/auth.ts`
参照)。同じ値を desktop 側の設定画面にも登録します(§3.4)。

### 2.4 IG 長期アクセストークンの投入(手動・初回のみ)

Instagram への投稿には Graph API の長期(long-lived)ユーザーアクセストークンが
必要です。取得は Meta 側の OAuth フロー(§3.1〜3.2)で行い、`ig_long_lived` という
キーで KV(`TOKENS`)へ手動で書き込みます:

```sh
wrangler kv key put ig_long_lived "<取得したトークン>" --binding=TOKENS --remote
```

このトークンは毎日 3 時の cron(`token-refresh.ts`)が自動更新します(長期トークン
は約 60 日で失効しますが、失効前に `ig_refresh_token` grant で延命されます)。
更新後のトークンと有効期限も同じ KV に書き戻されるため、通常は初回投入のみで
以降のメンテナンスは不要です。

### 2.5 デプロイと疎通確認

```sh
pnpm deploy   # = wrangler deploy
```

`/health`(無認証)でデプロイ自体の到達性を確認できます:

```sh
curl https://<your-scheduler>.workers.dev/health
# {"ok":true}
```

トークンありで保護エンドポイントの疎通も確認できます:

```sh
curl -H "Authorization: Bearer <SCHEDULER_API_TOKEN>" https://<your-scheduler>.workers.dev/
# facet-scheduler
```

desktop アプリの設定画面(§3.4)でも同様の2段階疎通チェック(health → Bearer 認証)
を実行できます。

---

## 3. Instagram 連携のセットアップ

### 3.1 前提

- 投稿先が Instagram の**プロフェッショナル(ビジネス/クリエイター)アカウント**
  であること、かつ Facebook ページと接続されていること(Graph API 経由の投稿には
  この接続が前提です)。
- Meta for Developers で自分のアプリを作成します(開発モードのままで OK — 自分の
  アカウントに自分で投稿するだけなので Meta のアプリ審査は不要です)。Instagram
  Graph API を使えるプロダクトを追加し、投稿(`instagram_content_publish` 相当)に
  必要な権限を持つユーザーアクセストークンを、Graph API Explorer 等の画面で発行
  します。短期トークンを長期トークンに交換する手順(`fb_exchange_token` grant)を
  経て、§2.4 の長期トークンを得ます。
- 画面遷移の詳細(ボタン名・メニュー位置)は Meta 側の UI 変更で陳腐化しやすいため、
  本書では記載しません。詰まった場合は Meta for Developers の公式ドキュメント
  (Instagram Platform / Content Publishing)を参照してください。

### 3.2 IG_USER_ID の確認

Graph API で自分のページに接続された Instagram アカウントの ID を取得し、
`IG_USER_ID`(§2.2)に設定します(`/{page-id}?fields=instagram_business_account`
等、Graph API Explorer の画面から確認できます)。

### 3.3 R2 バケットの作成と公開読取設定

Instagram の Content Publishing API はコンテナ作成時に `video_url`(公開 URL)
を渡し、**Meta 側がその URL に cURL でアクセスして動画を取得します**
(resumable アップロード方式ではなく `video_url` 方式。
[apps/scheduler/src/publish-do.ts](../apps/scheduler/src/publish-do.ts) の
`videoUrl = R2_PUBLIC_BASE + "/" + r2Key` 参照)。そのため **R2 バケットの
オブジェクトが公開読取可能である必要があります**。

1. Cloudflare ダッシュボードで R2 バケットを作成する(名前は自由。desktop 側の
   既定値は `facet-media` — 空欄で保存すると Rust 側がこの既定値にフォールバック
   します)。
2. バケットの公開アクセスを有効にする(R2 の「Public Development URL」を有効に
   するか、独自ドメインを R2 バケットにバインドする)。どちらの方式でも、得られた
   公開ベース URL を `wrangler.toml` の `R2_PUBLIC_BASE`(§2.2)に設定する。
3. R2 の API トークン(S3 互換の Access Key ID / Secret Access Key)を、対象
   バケットへの読み書き権限で発行する。これは desktop アプリが署名付き PUT で
   直接アップロードするために使う資格情報で、公開読取設定とは別物(こちらは
   非公開のシークレット)。

### 3.4 desktop 側の設定

private エディションの設定画面(公開連携セクション)で以下を入力します:

- **scheduler URL**: `https://<your-scheduler>.workers.dev`(秘密ではないため
  ローカルに平文保存されます)
- **API トークン**: §2.3 の `SCHEDULER_API_TOKEN`(OS キーチェーンに保存され、
  保存後は値を再表示しません)
- **R2 資格情報**: アカウント ID(Cloudflare アカウント ID。R2 のエンドポイントは
  `https://<accountId>.r2.cloudflarestorage.com`)、アクセスキー ID、シークレット
  アクセスキー、バケット名(§3.3。いずれも OS キーチェーンに保存)

入力後「疎通チェック」を押すと、health → Bearer 認証の2段階で scheduler への
到達性を確認します。scheduler の疎通 OK かつ R2 資格情報が保存済みになると、
Instagram への投稿が有効になります。

### 3.5 制約(enqueue 前にバリデーションされる)

- ファイルサイズ: 最大 300MB
- 尺: 3秒〜15分
- キャプション: 最大 2200 文字(UTF-16 換算)
- 予約枠: 75日先まで、1日25件(2026-03 に全公開アカウントへ開放。Instagram 公式の
  アプリ内予約 / Meta Business Suite 経由の制約であり、Facet 独自の制限ではない)
- レート制限: 100 API 投稿/24h(移動窓)

超過分は R2 へのアップロード前にアプリ内でエラーになります(R2 に一切アップロード
されません)。

---

## 4. YouTube 連携のセットアップ(準備作業のみ・接続 UI は未実装)

前述のとおり、desktop 側に YouTube への OAuth 接続・アップロード UI は
まだ実装されていません。以下は実装が入った際にすぐ使えるよう、外部側の準備を
先に済ませておきたい場合の手順です。

- Google Cloud のプロジェクトを作成し、YouTube Data API v3 を有効化する。
- OAuth 同意画面を設定し、OAuth クライアントを**「デスクトップアプリ」種別**で
  作成する(ブラウザ埋め込みでなくローカルアプリからの認可コードフローを想定する
  ため)。
- テスト段階(Google の審査前)では OAuth 同意画面のテストユーザーに自分の
  Google アカウントを登録しておく。
- **未監査(unverified)のアプリでは `publishAt` による予約公開が private ロック
  される**(非公開のままフリップされない)制約があります。個人の自己ホスト用途
  では通常この監査(Audit)は通っていないため、次のいずれかで運用します:
  - YouTube API Services の Audit フォームから監査を申請する(無料、個人でも
    申請可能)。
  - 監査を通さない場合は、Facet からは**非公開でアップロードし、YouTube Studio
    側で手動予約設定**するフォールバックを使う。

desktop アプリ側の対応が実装され次第、この節を接続手順込みで更新します。

---

## 5. 動作確認とトラブルシュート

### 5.1 e2e の流れ(Instagram)

1. desktop でクリップを編集・reframe し、投稿設定でキャプション・公開時刻を入力
   して投稿を開始する。
2. desktop が enqueue 前バリデーション(§3.5)→ R2 へ署名付き PUT → scheduler へ
   `POST /jobs`(Bearer 認証、idempotencyKey で二重登録防止)の順に実行する。
3. scheduler 側では `pending` → (公開時刻到来後)`creating`(コンテナ作成)→
   `processing`(status_code ポーリング、1分間隔)→ `publishing` → `published`
   と状態が遷移する(`GET /jobs/:id` で確認可能)。エラー時は `failed` になり
   `last_error` に理由が入る。

### 5.2 desktop 側のエラー分類(疎通チェック)

| 状態 | 意味 | 対応 |
|---|---|---|
| `no_token` | APIトークン未保存 | 設定画面でトークンを保存する |
| `unauthorized` | Bearer トークンが scheduler 側と不一致(401) | desktop とscheduler 双方のトークンを再確認・再設定する |
| `service_unavailable` | scheduler 側で `SCHEDULER_API_TOKEN` 自体が未設定(503, fail-closed) | `wrangler secret put SCHEDULER_API_TOKEN` を実行したか確認する |
| `unreachable` | health エンドポイントに到達できない(ネットワークエラー・タイムアウト・非200応答) | scheduler URL の綴り・デプロイ状態・Cloudflare 側の障害を確認する |
| `unexpected_status` | 上記以外の想定外ステータス | scheduler のログ(`wrangler tail`)を確認する |

### 5.3 IG 投稿ジョブ側のエラー分類

投稿実行中(R2 アップロード〜enqueue)のエラーは `UploadFailed` /
`EnqueueUnauthorized` / `EnqueueServiceUnavailable` / `EnqueueRejected` /
`Network` / `Cancelled` / `Internal` に分類されます。`EnqueueUnauthorized`
/ `EnqueueServiceUnavailable` は §5.2 の 401/503 と同じ原因(トークン不一致
/ scheduler 未設定)なので同様に対処してください。`EnqueueRejected` は
scheduler が `jobManifest` のバリデーションで 400 を返した場合(通常は
desktop 側の事前バリデーションで弾かれるため稀)です。

### 5.4 それでも公開されない場合

- scheduler のログを見る: `wrangler tail`(Cloudflare ダッシュボードの Logs
  でも確認可能)。
- ジョブの状態を直接確認する: `GET /jobs/:id`(Bearer 認証必須)で `status` /
  `lastError` / `attempts` を見る。
- `creating` から進まない場合は Meta 側のコンテナ処理待ち(公式推奨のポーリング
  間隔は最大5分)。`ERROR`/`EXPIRED` になっている場合は Graph API 側のエラー
  メッセージ(`last_error`)を確認する。
- R2 の公開読取設定(§3.3)が漏れていると、Meta 側が `video_url` を取得できず
  コンテナ作成が失敗する。R2_PUBLIC_BASE + キー(`posts/<date>/<uuid>.mp4`)に
  ブラウザで直接アクセスできるか確認する。

---

## 6. 更新について

private エディションは自動アップデータが無効化されています(作者の手動リビルド
前提のため)。更新する場合は自分の clone を最新化して再ビルドしてください:

```sh
git pull
pnpm install
pnpm --filter "@facet/desktop^..." build
pnpm --filter @facet/desktop build:mac-private   # または build:win-private
```

`apps/scheduler` を変更した場合は `pnpm deploy` で再デプロイしてください
(D1 スキーマに変更が入っている場合は `pnpm migrate:remote` も忘れずに)。

---

## 注意事項

- **トークン・資格情報の扱い**: scheduler の API トークン、R2 のアクセスキー、
  IG/YouTube の資格情報はすべて OS キーチェーン(macOS Keychain / Windows
  Credential Manager)に保存され、desktop アプリはこれらの値を返す API を
  持ちません(「保存済みか」の真偽値のみ)。誰とも共有しないでください。
- **Meta / Google のポリシーは変動します**。本書の外部プラットフォーム仕様
  (Instagram の 300MB/3秒〜15分/予約枠、YouTube の未監査ロック等)は 2026-07 時点
  で確認したものです([docs/desktop-migration-plan.md](./desktop-migration-plan.md)
  §12 参照)。実際に運用する前に各社の公式ドキュメントで最新仕様を確認してください。
- **相乗り不可**: 自分の scheduler インスタンスに他人の Instagram トークンを
  預かる運用(マルチテナント化)は想定していません。各自が自分の Cloudflare /
  Meta / Google アカウントでセルフホストしてください。
