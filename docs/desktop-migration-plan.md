# Facet デスクトップアプリ移行 実装計画

> ステータス: **実装着手可(§11 未決事項をすべて確定, v2.3。v2.4 でパッケージング
> 方針を変更, §2・§6.6)**
> 対象読者: レビュアー / 実装者
> 最終更新: 2026-07-13

> **v2 での主な変更**(レビュー反映): §1 の移行動機を実装事実に合わせて訂正
> (進捗は `-progress`+stdout、HW アクセルは既に明示制御済み)/ YouTube 連携を
> 現行機能として明記し Phase 3 に実作業を追加 / §6.3 のプリセット認識を訂正
> (真実の源は web 側、Rust はプリセット表を持たない)/ LGPL とソフトフォールバック
> の矛盾を整理し未決事項化 / プレビュー配信・中断・VideoToolbox 同時実行制限を追加。

> **v2.1 での追記**: 配布方針を確定 — **OSS として無料配布し、公開連携(IG 予約
> 公開 / YouTube)は配布版の既定では無効。設定駆動の実行時ゲートで解放**(§2
> 配布方針・§6.6)。scheduler への Bearer トークン認証追加を必須化(§6.4・Phase 3)。
> §11-5 を確定。付録の依存図を更新(公開リリースは Phase 2 + 4 で成立)。

> **v2.2 での追記**: プラットフォーム公開仕様を公式ドキュメントで検証し §12 に
> 集約(2026-07 時点)。重要な発見: **IG の `media_type=VIDEO` が現行リファレンス
> から削除されており contract の `mediaType` 整理が必要**(Phase 0)/ IG の
> ファイル上限は **300MB**(enqueue 前バリデーション必須, Phase 3)/ レート制限は
> 100 投稿/24h。出力仕様を MP4/H.264/AAC に固定(§6.2・§12.3)。
> 外部仕様を検証(2026-07 時点): IG 予約枠(75 日先 / **1 日 25 件**、2026-03 に全公開
> アカウントへ開放)と YouTube 未監査アプリの制約を確認し §2 に日付注記を追加。

> **v2.3 での確定**(§11 未決事項をすべて解消し着手可能化): §11-2 コーデック =
> **HW エンコーダ第一 / libx264 は破棄 / openh264 は実行時 DL の保険を Phase 2.5 へ
> 後置**(Phase 2 は OS エンコーダのみで着手)/ §11-4 YouTube = **案 A(Rust,
> `google-youtube3`+`yup-oauth2`)確定・案 B(Node サイドカー)破棄** / §11-3 資格情報 =
> OS キーチェーン(`keyring`)で確定 / §11-6 生成コード = build.rs 生成 + CI diff
> ゲートで確定。あわせて **CLI spawn が担っていた GPL 回避シールドが in-process libav
> リンクで失われる論点**を §10 に追記(§6.2・Phase 4 と整合)。

> **v2.4 での決定変更**(2026-07-13、パッケージング方針): §6.6 の「ビルドは単一、
> 実行時ゲートのみ」を**ビルド分離(エディション)+ 実行時ゲートのハイブリッド**
> に変更。**public(配布版)= 切り抜き+reframe+書き出しのみ**(§2 が挙げていた
> 「受け渡し補助」も配布版からは外す)/ **private = 現行 3-step UI + Phase 3 の
> 公開連携**、identifier/productName を分離し public と共存インストール可能・
> updater 無効・第三者配布はしない。ゲートは cargo feature `publish` + Vite
> エディション注入(ビルド時、投稿系コードを物理除外)+ 設定駆動の実行時ゲート
> (private 内、v2.3 から維持)の二段。private を配布しないため v2.3 が懸念した
> CI/署名/updater チャネルの倍増は発生しない(§2・§6.6・§8 Phase 3)。変更理由は
> 秘匿ではなく配布物の体験と表面積の最小化(OSS のためコードは公開のまま)。

---

## 1. 背景と目的

Facet は横向き動画を複数のターゲット形状(**YouTube 横 16:9、YouTube ショート/IG
Reels 9:16、IG フィード 1:1・4:5**、クロップ枠テンプレートは 4:3・自由比を含む)へ
再フレーミングし、**YouTube と Instagram へ予約公開**するツール群である。現状の
編集アプリ `apps/studio` は Node/Hono サーバ + React/Vite Web UI + CLI `ffmpeg` の
spawn で構成される。

### 移行の動機(実装事実に基づく)

現状は妥当に作られており、以下は既に実装済みである(誤認しないこと):

- 進捗は `ffmpeg -progress pipe:1` の**構造化レコードを stdout でパース**している
  ([runner.ts](packages/ffmpeg-runner/src/runner.ts))。stderr はエラー末尾保持のみ。
- HW エンコードは既定で `h264_videotoolbox` を**明示指定**し、失敗時に `libx264`
  へフォールバックする制御も実装済み([encode.ts](apps/studio/server/src/services/encode.ts))。

その上で、CLI spawn 構成には次の実利上の限界があり、これが移行の動機である:

- **Windows の HW エンコード対応が皆無**(現状は VideoToolbox = macOS のみ)。Win は
  実質ソフトエンコードに落ちる。libav 統合で Media Foundation を叩けるようにする。
- **中間ファイル依存とプロセス起動オーバーヘッド**(プレビュー・エクスポートで
  都度 spawn)。インプロセス化でディスク I/O とレイテンシを削減。
- **フレーム精度の制御**が CLI 引数の粒度に縛られる。libav なら細粒度に制御できる。

本計画は `apps/studio` を **Tauri + Rust コア(libav 直接統合)**へ移行し、
Windows / macOS へ**単体インストール可能なアプリとして配布**することを目的とする。

### 変更しないもの(重要な前提)

- **Instagram の予約公開はクラウド(`apps/scheduler`, Cloudflare)で維持する。**
  IG は予約公開 API を持たないため、時刻公開をクラウドの Cron が担う現構成を保持
  する(PC の電源が落ちていても発火する強み)。
- 予約公開契約 `packages/contract`(job-manifest)は存続し、デスクトップアプリと
  scheduler の境界であり続ける。
- **YouTube の予約公開は方式が異なる**: `publishAt` 付きでアップロードすると
  **YouTube 側が時刻公開を担う**([youtube.ts](apps/studio/server/src/services/youtube.ts))
  ため Cloudflare は経由しない。この非対称性を移行後も維持する(§6.5)。

---

## 2. スコープ

### 対象(In scope)

- `apps/studio`(server + web)を `apps/desktop`(Tauri + Rust)へ置換する。
- メディア処理を CLI `ffmpeg` spawn から **libav インプロセス統合**へ移行する。
- `packages/contract` を **TS/Rust の多言語共有**に対応させる。
- **YouTube 連携(アップロード + `publishAt` 予約)を desktop へ移行する**(§6.5)。
- Windows / macOS 向けの署名済みインストーラの生成と配布 CI。

### 非対象(Out of scope)

- `apps/scheduler`(Cloudflare Workers: D1 / DO / KV / Cron)の変更。IG 公開
  ステートマシンは現状のまま。**例外は 2 点のみ: Bearer トークン認証の追加(§6.6)
  と、`mediaType` の REELS 一本化への追随(§12.1, Phase 0)**。
- 予約公開ロジックのローカル化(= IG クラウド予約の廃止)。本計画では採らない。

### 配布方針(予約投稿・公開連携の扱い)

**決定: OSS として無料配布する。公開連携(IG 予約公開・YouTube アップロード)は
public(配布版)エディションには含めず、private エディション内で設定駆動の実行時
ゲートにより解放する(実装方式は §6.6。v2.4 でビルド分離 + 実行時ゲートの
ハイブリッドに変更)。**

> **v2.4 での変更**: エディションを **public(配布版)/ private(自分 + セルフ
> ホスト用)** に分離(詳細は §6.6)。これに伴い、下記の「配布版の既定機能」から
> **受け渡し補助を外す**(private 限定機能とする)。理由は秘匿ではなく配布物の
> 体験・表面積の最小化(§6.6)。

- **エディション(v2.4 で追加)**:
  - **public(配布版)**: 切り抜き + reframe + 書き出しのみ。
  - **private(自分 + セルフホスト用)**: 現行の 3-step UI(編集 → 書き出し →
    公開連携)一式 + Phase 3 の公開連携。第三者配布はしない(§6.6)。
- **配布版の既定機能**: ~~再フレーミング + 書き出し + 受け渡し補助(キャプションの
  コピー、Meta Business Suite を開く導線)~~(v2.3 時点の決定)。**→ v2.4:
  再フレーミング + 書き出しのみ**。受け渡し補助も含め、投稿系に触れる機能は
  private エディション側に寄せる(§6.6)。IG の予約投稿は公式機能(2026-03 の
  更新で全公開アカウントに開放。アプリ内予約 / Meta Business Suite。無料・
  最長 75 日先・1 日 25 件)へ受け渡す。大半の個人運用はこれで足りる。
- **公開連携の解放対象**: 自分の環境と、セルフホストできる技術者(知り合い等)に
  限る。解放の手段は ~~ビルドの出し分けではなくセルフホスト手順書~~(v2.3 時点の
  決定)。**→ v2.4: private エディションを自分でビルドする手順を含むセルフホスト
  手順書**(各自の Cloudflare に scheduler をデプロイし、各自の Meta/Google
  アプリを接続する手順に加え、`build:*-private` での自己ビルド手順を含める。
  §6.6)。
- **理由**: 公開連携を第三者向けに既定で開くと、Meta App Review / YouTube API 監査 /
  マルチテナント基盤 / 運用・サポート責任を自分が背負う構造になる。各自が自分の
  Meta/Google アプリ(開発モード、審査不要)で自分のアカウントに投稿する形なら、
  審査・運用の負債が**構造的に発生しない**。摩擦の本体は Cloudflare ではなく Meta
  開発者アプリの作成であり、どの無料ホスティングに変えても消えないため、クラウドの
  乗り換えではなく「公式予約への受け渡し」を既定にする。この理由(審査・運用負債の
  構造的回避)は v2.4 でも変わらない。エディション分離(v2.4)は別の理由 — **配布物
  自体の体験と表面積を最小化する**(無効化された機能の痕跡を配布版に残さない)—
  によるもので、両者は独立している(§6.6)。

> 注: 本節の外部プラットフォーム仕様(IG 予約枠 75 日/1 日 25 件、YouTube 未監査
> アプリの private ロック挙動)は **2026-07 時点で確認**。ポリシーは変動するため、
> 配布前および手順書公開時に各自で再確認する。

---

## 3. 現状アーキテクチャ(As-Is)

```
apps/studio/web (React/Vite)  ──HTTP──▶  apps/studio/server (Hono/Node)
  OUTPUT_TARGETS / FIXED_DIMS が                │
  実プリセット源(§6.3)                        ├─ @facet/core          (FilterPlan 生成: CLI 用文字列)
  プレビューは /files/raw で再生               ├─ @facet/ffmpeg-runner (ffmpeg/ffprobe を spawn)
                                               ├─ services/encode      (h264_videotoolbox → libx264 fb)
                                               ├─ services/youtube     (アップロード + publishAt 予約)
                                               │      └──────────────▶ YouTube Data API(時刻公開は YT 側)
                                               └─ services/scheduler-client
                                                     │ R2 に PUT (aws4fetch, S3 sigv4)
                                                     │ POST /jobs (JobManifest)
                                                     ▼
                                          apps/scheduler (Cloudflare) ──▶ Instagram Graph API
```

### 移行で影響を受ける接合部(コードで確認済み)

| 箇所 | 現状 | 移行での扱い |
|---|---|---|
| `packages/contract/src/job-manifest.ts` | zod スキーマ | **真実の源として存続**。JSON Schema 経由で Rust へ型生成 |
| `web/src/types.ts`(`OUTPUT_TARGETS`/`FIXED_DIMS`/`masterSpec`/`finalSpec`) | **実プリセット源**。`Preset` をインライン組立 | web 側に残す。`EditSpec` のみ Rust と共有(§6.3) |
| `packages/core`(`EditSpec`/`CropRect`/`Trim` 等の型) | 純データ型 | スキーマを共有(移植は最小) |
| `packages/core/src/presets.ts`(`PRESETS`/`getPreset`) | **アプリ未参照**(テストのみ) | 実質デッドコード。移行対象外(§6.3) |
| `packages/core/src/filtergraph/*`(`compose`/`blur-pad` 等) | ffmpeg CLI 文字列を生成 | **破棄**。libav 呼び出しで再実装 |
| `packages/ffmpeg-runner`(`spawn`)/ `services/encode.ts` | CLI 実行 + VideoToolbox 制御 | **破棄**。libav に置換(同時実行制御は要移植, §6.2) |
| `services/scheduler-client.ts`(R2 PUT + POST /jobs) | aws4fetch + fetch | **Rust で再実装**(§6.4) |
| `services/youtube.ts`(OAuth + アップロード + publishAt) | googleapis | **desktop へ移行**(Rust 実装 or TS サイドカー, §6.5) |
| `routes/preview.ts` + `routes/files.ts`(`/files/raw`) | 仮エンコード + HTTP 配信 | HTTP サーバが無いため asset protocol へ再設計(§7 注記) |
| `routes/export.ts`(切断で SIGKILL) | プロセス kill で中断 | インプロセスのキャンセル機構へ再設計(§6.2) |

---

## 4. 目標アーキテクチャ(To-Be)

```
apps/desktop
┌───────────────────────────────────────────────┐
│ renderer (React/Vite, webview)                 │  ← studio/web から移植
│   UI・プレビュー枠描画・入力検証(zod)         │
│   OUTPUT_TARGETS/FIXED_DIMS はここに残す        │
│   プレビュー再生は asset protocol(convertFileSrc)│
└──────────────┬────────────────────────────────┘
               │ Tauri invoke / event (IPC): EditSpec を渡す / 進捗を受ける
┌──────────────▼────────────────────────────────┐
│ src-tauri (薄い接着層: commands + events)      │
│   crates/media-core   libav パイプライン(HWアクセル + 同時実行制御 + キャンセル)│
│   crates/contract-rs  JSON Schema 由来の serde 型   │
│   jobs                IG: R2 upload + POST /jobs    │
│   youtube             YT: OAuth + upload + publishAt│
└──────┬──────────────────────────┬──────────────┘
       │ R2 PUT + POST /jobs       │ upload + publishAt
       ▼                           ▼
apps/scheduler (Cloudflare, 無変更)   YouTube Data API(時刻公開は YT 側)
       │
       ▼
Instagram Graph API
```

---

## 5. 技術選定と根拠

| レイヤ | 採用 | 主な代替 | 選定理由 |
|---|---|---|---|
| シェル | **Tauri v2** | Electron | 起動が速くバンドル小・メモリ小、Rust コアと自然に接続 |
| コア言語 | **Rust** | Node 継続 | メモリ安全・並行処理・ネイティブ速度。メディア処理の本体を担う |
| メディア | **libav(`ffmpeg-next`)** | GStreamer / CLI spawn | インプロセスでフレーム精度・HWアクセル明示制御・中間ファイル排除 |
| HW アクセル | **VideoToolbox(mac)/ Media Foundation(Win)** | ソフトエンコード | OS 標準。**Win の HW エンコード対応が移行の主目的の一つ** |
| フロント | **React/Vite を継続** | 全面書き直し | UI 品質はシェル言語に非依存。既存資産を移植でき無駄がない |
| 配布 | **Tauri bundler + 署名/公証** | 手動配布 | dmg/MSI 生成・自動アップデータ内蔵 |

> Windows 実機検証(2026-07-11、go 確定): `h264_amf` を第一候補とする(詳細→
> [docs/phase2-0-windows-setup.md](./phase2-0-windows-setup.md) §7)。

**リポジトリ形態: モノレポに `apps/desktop` を追加**。`apps/scheduler` と
`packages/contract` が存続・共有され続けるため別リポジトリは契約の二重管理を生む。
旧 `studio` を残したまま並走でき段階移行に適する。

---

## 6. 主要な設計論点と決定

### 6.1 contract の多言語共有(TS ⇄ Rust)

**決定: zod を真実の源に保ち、JSON Schema を中間表現として挟む。**

```
packages/contract/src/job-manifest.ts (zod, 真実の源)
   │ zod-to-json-schema(build 時に出力)※zod v4 移行時は z.toJSONSchema() 内蔵(§Phase0 注記)
   ▼
packages/contract/schema/job-manifest.json (コミット / 言語中立)
   │ typify(バージョン固定, apps/desktop の build.rs で生成)
   ▼
apps/desktop/crates/contract-rs (serde 構造体, OUT_DIR / 非コミット)
```

- TS 側(scheduler・renderer)は無改修。Rust 側だけ追加する形で既存を壊さない。
- scheduler と同一 JSON をやり取りするため**シリアライズ互換が構造的に保証**される。
- **生成 Rust コードは非コミット**(build.rs で毎ビルド生成)。ドリフト源を「zod →
  コミット済み JSON Schema」の一方向に絞る。
- **CI ゲート**: `contract` を build して `git diff --exit-code schema/` で更新漏れを
  検出 + Rust 側で JSON の round-trip テスト。

対象スキーマ: `jobManifest` / `jobRecord` / `jobStatus` / `jobCreateResponse` /
`mediaType`。desktop が送信するのは主に `jobManifest`(POST /jobs body)。

### 6.2 メディアパイプライン(CLI → libav)

現 `core` の `compose()` が生成するパイプラインを libav で再現する:

```
[入力] → trim(seek + duration) → 任意の事前クロップ(正規化矩形→px)
       → fit: blur-pad | crop-cover → preset 解像度へスケール → [エンコード]
```

移植で保持すべき実装挙動(現コード基準):

- **blur-pad の正確な構成**: `split=2` → 背景は `scale(force_original_aspect_ratio
  =increase) → crop → gblur=sigma=20`、前景を中央 `overlay=(W-w)/2:(H-h)/2`
  ([blur-pad.ts](packages/core/src/filtergraph/blur-pad.ts))。同等性検証の基準に
  なるため sigma=20 とフィルタ構成を維持する。
- **trim** はデコード側のシーク + 尺(現状の `seekArgs`/`durationArgs` 相当)。
- **エンコード**は OS の HW エンコーダ(H.264)を第一候補とする(§11-2 確定)。
  **libx264 は GPL のため破棄**(現状の CLI spawn は別プロセスの ffmpeg を持参する
  形で GPL 汚染を回避していたが、in-process libav リンクではその盾が消えるため。§10)。
  ソフトフォールバックは **openh264 の Cisco 配布バイナリを実行時 DL** する方式(BSD +
  Cisco が MPEG-LA へ特許料肩代わり)だが、**Phase 2 には入れず Phase 2.5 の hardening に
  後置**する(YAGNI: 両対象 OS とも OS エンコーダが事実上常在し、-12903 セッション枯渇は
  下記セマフォが緩和するため、no-HW が実機で出たときに追加する)。
- **出力仕様は MP4 / H.264 / AAC(≤48kHz)/ +faststart に固定**(§12.3)。現 runner の
  既定と同一であり、プラットフォーム仕様(§12)への適合を構造的に保つ。ビットレートは
  IG の上限(VBR 25Mbps)内に収める。
- **VideoToolbox の同時セッション制限**: 現 `encode.ts` は `err=-12903`(同時に開ける
  HW エンコーダ枯渇)を検知して**同時実行セマフォ + libx264 フォールバック**で回避
  している。**Rust `media-core` でも同等の同時実行制御とフォールバックが必要**
  (Phase 2 受け入れ基準)。
- **中断(キャンセル)**: 現状はプロセス切断で SIGKILL([export.ts](apps/studio/server/src/routes/export.ts))。
  インプロセス libav では kill 手段が消えるため、**デコード/エンコードループに明示的
  キャンセル機構**を設計する(Phase 2 受け入れ基準)。

### 6.3 プリセット / EditSpec の共有(認識を訂正)

**現状認識の訂正**: `packages/core` の `PRESETS`/`getPreset` は**アプリから参照されて
おらず**(`compose.test.ts` のみ)、実際に UI が使うプリセット定義は
[web/src/types.ts](apps/studio/web/src/types.ts) の `OUTPUT_TARGETS` / `FIXED_DIMS`
である(`masterSpec`/`finalSpec` が `Preset` をインライン組立)。

**決定**: renderer から Rust へは具体的な width/height/fit を含む `EditSpec` が
そのまま渡るため、**Rust 側はプリセット表を持たない**。

- 共有するのは **`EditSpec` のスキーマのみ**(contract と同じ JSON Schema 方式)。
- **プリセット表(`OUTPUT_TARGETS`/`FIXED_DIMS`)は web 側に閉じる**。真実の源は
  core ではなく web。`core/presets.ts` は実質デッドコードなので移行対象外。
- これで「プレビューと出力のズレ」は、UI が組み立てた `EditSpec` をそのまま Rust が
  実行する構造により自然に防がれる(共有すべきは表ではなく仕様の型)。

### 6.4 IG 連携の Rust 再実装

現 `scheduler-client.ts` の 2 ステップを Rust の `jobs` モジュールで再現する:

1. **R2 へ署名付き PUT**(S3 互換 sigv4)。URL 形式・`content-type: video/mp4`・
   キー規則(`posts/<YYYY-MM-DD>/<uuid>.mp4`, publishAt を UTC 解釈)を踏襲。
   Rust では `aws-sigv4` + `reqwest` 等。
2. **POST /jobs**(`JobManifest` JSON)。`idempotencyKey`(uuid)による二重登録防止も
   踏襲。**scheduler には Bearer トークン認証を追加する**(§6.6。配布方針の確定に
   より必須化。デプロイ時に生成したトークンを desktop 側は設定画面で保持する)。

プラットフォーム仕様(§12.1)から追加で確定する事項:

- **`mediaType` は REELS に一本化**する(`VIDEO` は現行 Graph API リファレンスの
  許容値に無い。1:1 / 4:5 も REELS として投稿する)。contract の enum 整理は Phase 0。
- **enqueue 前バリデーション**: ファイルサイズ ≤300MB・尺 3 秒〜15 分を desktop 側で
  検査してから R2 へアップロードする(Phase 3)。
- `video_url` 方式のため **R2 オブジェクトの公開読取が前提**(Meta 側が cURL で取得)。
  セルフホスト手順書のバケット設定に明記する。

### 6.5 YouTube 連携の移行(現行機能)

YouTube は IG と方式が異なる: `publishAt` 付きアップロードで **YouTube 側が時刻公開**
を担うため、Cloudflare を経由しない。現 `youtube.ts` は OAuth + 再開可能アップロード
+ `privacyStatus="private"` + `publishAt` 登録を行う(private→public フリップには
API 監査が前提、というコメント上の注意も引き継ぐ)。

**移行方針(§11-4 確定): 案 A(Rust 再実装)。案 B(Node サイドカー)は不採用。**

- YouTube アップロードは **OAuth + resumable PUT + `videos.insert` の REST のみ**で、
  media-core を Rust にした理由(フレーム精度・低レイテンシ・中間ファイル排除)は
  ここには当てはまらない。Node ランタイムを引き込む技術的必然がない。
- 案 B を魅力的にしていた「resumable/OAuth が面倒」は、**`google-youtube3`(保守継続・
  `upload_resumable` 提供)+ `yup-oauth2`** に乗ることで解消。手書きしない。
- 案 B は単一バイナリ・小バンドルという Tauri 採用の中核思想と矛盾する(Node 同梱 →
  署名・公証・自動更新の対象増)。よって不採用。

いずれにせよ **YouTube 移行は Phase 3 の明示作業**とする(先送りの「方針確定のみ」
にはしない。Phase 5 の全機能カバー要件に必要)。

セルフホスト利用者への注意(手順書に明記): 未監査 OAuth クライアントの非公開
ロックは**各利用者の Google プロジェクトにも個別に適用される**。監査(YouTube API
Services の Audit フォーム、無料・個人でも申請可)を各自で通すか、手動フォールバック
(非公開でアップロード → YouTube Studio で予約設定)を使う。

### 6.6 公開連携のゲート方式(配布方針 §2 の実装)

> **v2.4 での変更**: v2.3 の「ビルドは単一、実行時ゲートのみ」を、**ビルド分離
> (エディション)+ 実行時ゲートのハイブリッド**に変更した。変更理由は秘匿ではなく
> **配布物の体験と表面積の最小化**(OSS のためコード自体は公開のまま。配布版に
> 無効化された機能の痕跡を残さないことが目的)。

> **切り分けミスの修正(ウィザード再構成)**: v2.4 当初の実装は「投稿(アップロード)
> ステップ自体を public から丸ごと除外する」粒度だったが、その画面がターゲット別
> アスペクト/フィットの選択・レンダリング・フォルダへの保存(製品の核であるリフレーム
> 機能そのもの)も同居していたため、投稿系コードと一緒にリフレーム機能まで配布版から
> 消えてしまっていた。**現構造では画面(`ReframeScreen.tsx`)自体を両エディション共通とし、
> 投稿(スケジュール・キャプション・IG/YT 連携)の部分だけを `PublishSlots` 経由で
> private 専用ファイル群(`usePublishExtras.tsx` 等)に分離する**(§7 のディレクトリ構成、
> `apps/desktop/src/features/upload/entry.ts` / `entry.public.ts` 参照)。ウィザードの
> step 数(編集/確認/リフレーム)は両エディション共通の 3 step に統一し、投稿系 UI の
> 有無は各画面内部の描画で出し分ける。

~~**v2.3 時点の決定: ビルドは単一。公開連携はビルド分岐(Cargo feature / env
フラグでの出し分け)ではなく、実行時ゲートで解放する。**~~

- ~~OSS なのでコードを公開ビルドから除外しても秘匿にならない(リポジトリで公開済み)。
  ビルド分岐は CI マトリクス・署名・アップデータのチャネルを倍にするコストだけが
  残るため採らない。知り合いへの解放が「非公式ビルドの手動配布」になり、自動
  アップデートから外れる点も不利。~~(v2.3 時点の決定)
  **→ v2.4: private を第三者配布しないため、上記のコスト増(CI マトリクス・署名・
  アップデータチャネルの倍増)は発生しない**(下記)。

**v2.4 の決定: ビルド分離(エディション)+ 実行時ゲートのハイブリッド。**

- **エディション**:
  - **public(配布版)**: 切り抜き + reframe + 書き出しのみ。cargo feature
    `publish` + Vite のエディション注入により、投稿系コードを配布物から
    **物理的に除外**する(dynamic import で tree-shaking。renderer 側も
    未使用コードとしてバンドルから落ちる)。§2 の「受け渡し補助」もここには
    含めない。
  - **private**: 現行の 3-step UI(編集 → 書き出し → 公開連携)一式 + Phase 3
    の公開連携。identifier `com.facet.desktop.private` / productName
    `Facet desktop Private` で public と共存インストール可能(`app_data_dir`
    も分離)。**updater は無効**(作者が手動リビルドで更新)。**第三者配布は
    しない**(自分 + セルフホストできる技術者向けにビルド手順を渡すのみ)。
- **ゲートは二段**:
  1. **ビルド時(v2.4 で新設)**: `publish` feature の有無 + Vite edition 注入
     で、public ビルドの成果物から投稿系コードを物理的に除外する。
  2. **実行時(v2.3 から維持)**: private ビルド内では引き続き**設定駆動の
     実行時ゲート**を使う。ゲート条件 = 設定の有無。IG は `SCHEDULER_URL` +
     API トークン、YouTube は OAuth 資格情報(いずれも OS キーチェーン保管,
     §11-3)。未設定なら公開連携の UI 自体が現れず、設定投入時は疎通チェック
     (scheduler へのヘルスチェック等)を行い、半端な設定状態で機能が現れる
     ことを防ぐ。
- **解放手段 = セルフホスト手順書(v2.4 で更新)**。~~解放の手段はビルドの出し
  分けではなくセルフホスト手順書~~(v2.3 時点の決定)。**→ v2.4: 各自が自分の
  Cloudflare(無料枠で可)に scheduler をデプロイし、自分の Meta アプリ(開発
  モード)を接続する手順に加えて、「自分で private をビルドする」手順
  (`build:*-private` 系コマンド)を含める。** **自分の scheduler インスタンス
  への相乗り(他人の IG トークンを自分の D1/KV で預かる形)は採らない** —
  運用責任を背負わない前提が崩れるため(v2.3 から変更なし)。
- **CI(v2.4 で追加)**: `--features publish` のコンパイルチェックと、配布物
  (public ビルド成果物)への投稿系マーカー不在検査を追加する。private を
  第三者配布しないため、CI マトリクス・署名・アップデータチャネルは倍増しない
  (v2.3 が挙げていたビルド分岐コスト増の懸念への回答)。
- **前提作業: scheduler の Bearer トークン認証**(§6.4)。セルフホストでも Worker
  URL は公開網に露出するため、無認証 POST /jobs のままでは URL を知った第三者に
  投稿ジョブを積まれる。手順書を配る時点で必須(v2.3 から変更なし)。

---

## 7. ディレクトリ構成

```
apps/desktop/
  package.json            # renderer 依存 + @tauri-apps/cli / scripts: dev, build
  vite.config.ts
  index.html
  src/                    # ← studio/web から移植(React/Vite/Tailwind)
    features/             # 既存の機能分割を踏襲。OUTPUT_TARGETS/FIXED_DIMS も含む
  Cargo.toml              # Rust workspace ルート(apps/desktop 配下に閉じ込める)
  src-tauri/
    tauri.conf.json       # ウィンドウ / バンドル / 署名 / アップデータ設定
    build.rs              # typify で contract 型を OUT_DIR に生成
    Cargo.toml
    src/
      main.rs
      commands/           # invoke 境界(reframe, probe, enqueue_ig, publish_youtube ...)
      jobs/               # IG: R2 upload(S3 sigv4)+ POST /jobs
      youtube/            # YT: OAuth + upload + publishAt(Rust, google-youtube3+yup-oauth2)
  crates/
    media-core/           # libav ラッパ(Tauri 非依存, 同時実行制御 + キャンセル, テスト対象)
    contract-rs/          # typify 生成型の re-export ラッパ
```

**プレビュー再生とファイル選択の再設計(要注意)**:

- 現 UI は `preview.ts`(低ビットレート ~2M 仮エンコード + ハッシュキャッシュ)→
  `/files/raw?path=` の HTTP 配信で動画を再生している。**Tauri には HTTP サーバが
  無い**ため、webview 再生は **asset protocol(`convertFileSrc`)**等で再設計する。
  仮エンコード + キャッシュ自体は `media-core` に移せる。
- ファイル選択は現状 `osascript`(macOS 限定)。**Tauri の dialog プラグイン**に
  置き換えると Windows 対応が自然に得られる(移行の副次的利点)。

**二重ワークスペースの共存**: pnpm workspace は `apps/desktop` を JS パッケージとして
登録。Cargo workspace は `apps/desktop/Cargo.toml` をルートにし Rust をここに閉じ込め、
TS 側ツーリング(Biome / turbo)と干渉させない。

---

## 8. 段階移行計画

**方針: 旧 `apps/studio` を残したまま `apps/desktop` を並走させ、フェーズごとに検証**
(常に動くものを保ち、長期ブランチ分岐によるマージ地獄を回避)。

### Phase 0 — 契約の言語中立化

- 目的: contract を多言語共有可能にし、Rust codegen を疎通させる。
- 作業: zod→JSON Schema 出力ステップ追加、`schema/*.json` コミット、typify 試作、
  CI diff ゲート追加。**`mediaType` の整理**: `VIDEO` は現行 Graph API リファレンス
  の許容値に無いため REELS へ一本化する(§12.1)。ただし現行運用で `VIDEO` 送信が
  まだ通っている可能性があるため、**廃止前に実機で 1:1 動画の REELS 投稿を確認**
  してから contract と scheduler([instagram.ts](apps/scheduler/src/instagram.ts))
  を揃えて更新する(scheduler 変更の第 2 の例外として扱う)。
- 注記: contract は zod v3(`^3.23.8`)なので当面 `zod-to-json-schema` を使う。将来の
  zod v4 移行時は内蔵 `z.toJSONSchema()` に切替可(道具選定の分岐点として記録)。
  typify は**バージョン固定**して codegen ドリフトを防ぐ。
- 受け入れ基準: `git diff --exit-code schema/` が緑 / Rust で `jobManifest` JSON の
  round-trip テストが通る。
- 規模感: **S**。

### Phase 1 — desktop スキャフォルド

- 目的: Tauri v2 の空アプリが Win/mac で起動し turbo に統合される。
- 作業: `apps/desktop` 作成、`studio/web` をレンダラ移植、Cargo workspace 設定、
  turbo の `apps/desktop#build` を `@facet/contract#build` に `dependsOn` 連結。
- 受け入れ基準: `turbo run build` で Win/mac 起動 / renderer から `invoke` 疎通 /
  既存 `pnpm -r typecheck`・`pnpm test` が緑。
- 規模感: **M**。

### Phase 2 — メディアコア(品質の本体・主リスク)

- 目的: libav でリフレーム/エンコードを実装し旧実装と品質を突き合わせる。
- **前提(mac 側は先行スパイクで実証済み, 2026-07-11)**: `ffmpeg-next = "8.1"` が
  システム FFmpeg 8.1.2(libavcodec 62)にビルド・リンク成功。decode → blur-pad
  フィルタグラフ(studio と同一文字列)→ `h264_videotoolbox` → mp4 `+faststart` が
  in-process で完走し、同一フィルタの CLI 参照と **SSIM=1.0(ビット一致)**。crop-cover も確認。
  → §10 筆頭リスク「libav 統合の難度」「出力差」は **mac 経路では解消**。残リスクは
  **Windows / Media Foundation に集中**するため、下記を Phase 2 の先頭ゲートに置く。

- **作業 2-0(先行ゲート・Windows 検証)**: **Windows で `h264_mf`(Media Foundation)
  による in-process H.264 エンコードが成立するかを、mac スパイクと同じ最小 reframe で
  先に貫通する**。
  - **実施環境 = GPU 付き Win 実機**(検証機: AMD Radeon RX 9070 XT 搭載機。AMD
    ドライバの HW MFT 経由で `h264_mf` の HW パスを検証する)。**標準の CI Windows
    ランナーはゲート判定に使えない** — GPU なしの VM のため HW エンコーダ MFT が
    存在せず、`h264_mf` は Microsoft のソフトウェア MFT に落ち、肝心の HW エンコードを
    検証できない。CI ランナーは **Windows での libav ビルド/リンク回帰**用として
    Phase 2 期間中に併設する(§9)。
  - Media Foundation は歴史的にレート制御・品質が不安定なため、これが移行の主目的
    (Win の HW エンコード対応)の成否を握る。
  - 副次の見込み: ソフトウェア MFT は **Windows 標準搭載の H.264 エンコーダ**(OS
    同梱でライセンスも OS 側)のため、Win の no-HW フォールバックは openh264 不要で
    `h264_mf`(ソフト MFT)が既定で使える可能性が高い。2-0 で合わせて確認し、
    §11-2 の「openh264 は Phase 2.5 後置」判断を補強する(openh264 が本当に要るのは
    実質 mac の no-HW ケースのみ、の見立てになる)。
  - **go 判定**: `h264_mf` で 1080×1920 の reframe が完走し、出力が実用品質
    (目視 + 寸法/尺アサーション。SSIM は encoder 差が乗るため参考値)。
  - **no-go 時の分岐**: `h264_mf` が不適なら、ベンダ HW(`h264_qsv` / `h264_nvenc` /
    `h264_amf`)の検出・優先順位付けにフォールバックする設計へ切替(検証機が AMD の
    ため、実機で試せる第一候補は `h264_amf`)。それも不可なら
    Windows の HW 方針を再検討(§10・§5 の HW アクセル前提の見直し)。
  - **この 2-0 が緑になるまで media-core 本体(下記)の Windows 対応部分は着手しない**
    (未実証の基盤の上に積まないため)。
  - **実機検証結果(2026-07-11, go 確定)**: AMD Radeon RX 9070 XT 実機で `h264_amf`
    が HW 稼働(video codec engine 最大 37.17%)・高画質(SSIM=0.9988)を確認。
    2026-07-11 に目視再生確認も完了(色破綻・ブロックノイズ・コマ落ちなし)。
    Windows 既定エンコーダは `h264_amf` を第一候補とし、`h264_mf`
    (`hw_encoding=1` 指定時のみ HW 稼働)はフォールバック候補とする。詳細は
    [docs/phase2-0-windows-setup.md](./phase2-0-windows-setup.md) §7 参照。
- 作業(本体, 2-0 の go 後): `crates/media-core` に trim / 事前クロップ /
  blur-pad(sigma=20)/ crop-cover / scale を実装。VideoToolbox / Media Foundation の
  HW エンコード + **同時実行セマフォ(-12903 対策)**。**Phase 2 のフォールバックは
  セマフォ待機 + 再試行まで**とし、**ソフト H.264(openh264 実行時 DL)は Phase 2.5 に
  後置**(§6.2・§11-2)。OS エンコーダ非対応時は明快なエラーで停止する。**キャンセル
  機構**。プレビュー仮エンコード + キャッシュ。進捗イベント配線。
- 受け入れ基準:
  - **(先行ゲート)Windows で `h264_mf` もしくはベンダ HW による reframe が完走**
    (作業 2-0 の go 判定。ここが緑にならない限り Phase 2 は完了扱いにしない)。
  - 同一入力・同一 `EditSpec` で旧 studio と**出力が実用上同等**。検証は目視 +
    **SSIM/PSNR + 解像度/尺のアサーションをスクリプト化**(旧 studio 並走中しか
    取れない検証資産なので早期に整備)。
  - HW エンコードが mac/**Win 両方**で有効化、非対応時フォールバック。
  - VideoToolbox 同時実行制限下でも枯渇せず完走(セマフォ動作確認)。
  - エクスポート中のキャンセルが即座に効く。
  - フレーム単位進捗が renderer に届く。
- 規模感: **L**。

### Phase 3 — 公開連携(IG + YouTube)※ゲート機能・配布のクリティカルパス外

- 目的: desktop から IG 予約公開と YouTube 予約公開を一気通貫で通す(**ビルド
  分離 + 実行時ゲートの向こう側の機能**, §6.6。自分 + セルフホスト利用者向け)。
- 作業:
  - **(v2.4 で追加・先行タスク)エディション分離の土台**: cargo feature
    `publish` の導入、Vite 側のエディション注入(public/private のビルド時
    切替)、`build:*-public` / `build:*-private` のビルドコマンド整備、
    identifier/productName の分離(`com.facet.desktop.private` 等)、CI ガード
    (`--features publish` のコンパイルチェック + public 成果物への投稿系
    マーカー不在検査)。**この土台がないと以降の IG/YouTube 実装がどちらの
    エディションに属するか切り分けられないため先行させる**(§6.6)。
  - IG: `jobs` で R2 アップロード(S3 sigv4)+ POST /jobs を Rust 再実装(§6.4)。
  - **scheduler に Bearer トークン認証を追加**(§6.6。scheduler 側の唯一の変更)。
  - YouTube: OAuth + アップロード + `publishAt` を移行(§6.5, 案 A = Rust 確定。
    `google-youtube3` + `yup-oauth2` に乗る)。
  - 認証情報の設定 UI + OS キーチェーン連携(§11-3)+ 設定有無による機能ゲート
    と疎通チェック(§6.6)。
  - **IG 向け enqueue 前バリデーション**(ファイルサイズ ≤300MB・尺 3 秒〜15 分,
    §12.1)。
  - **セルフホスト手順書**(wrangler deploy + トークン発行 + Meta アプリ作成 +
    R2 バケットの公開読取設定 + YouTube 監査/手動フォールバックの案内)。
- 受け入れ基準:
  - desktop で編集 → **IG は scheduler 経由で予約公開が発火**(`idempotencyKey`
    二重登録防止機能)/ **YouTube は publishAt で時刻公開**(ステージング/実機)。
  - トークンなしの POST /jobs が 401 で拒否される。
  - 300MB / 尺の制約外の動画は enqueue 前に UI でエラーになる(R2 に上がらない)。
  - ~~公開連携が未設定の状態では UI に現れない(配布版の既定体験に影響しない)~~
    (v2.3 時点の基準)。**→ v2.4: public(配布版)には投稿系コードそのものが
    含まれない(ビルド時ゲート)+ private でも公開連携が未設定の状態では UI に
    現れない(実行時ゲート)**(§6.6)。
  - `scheduler` は認証追加以外は無変更で既存フローが動く。
- 規模感: **L 寄り**(YouTube 案 A = Rust 確定のため)。
- 備考: R2 アップロード/POST /jobs は任意の mp4 で疎通できるため、**Phase 3 は
  Phase 2 の完了を待たず Phase 1 後に着手可**。さらに配布方針(§2)により Phase 3 は
  **公開リリースの前提ではない**(OSS 版は Phase 2 + Phase 4 で成立)。自分の
  ワークフロー移行と手順書整備のタイミングで進めればよい。

### Phase 4 — 配布(OSS 版はここで公開リリース成立)

- 目的: 署名済みインストーラを CI で生成し、**OSS 版(公開連携ゲート OFF の既定
  体験)を公開リリースする**。
- 作業: mac 署名 + notarization、Win Authenticode 署名。FFmpeg の LGPL ビルド同梱
  (**LGPL 再リンク要件のため動的リンクが実質必須** → 同梱 dylib の署名・公証に影響)。
  自動アップデータ。リリース CI(Node + Rust)。**受け渡し補助の整備**(キャプション
  コピー、Meta Business Suite を開く導線 — 配布版の既定体験の完成、§2 配布方針)。
  README に as-is 提供・サポート範囲(GitHub Issues のみ)を明記。
- 受け入れ基準: 署名済み dmg / MSI が警告なしでインストール・起動(Gatekeeper /
  SmartScreen 通過)/ アップデータで配信可能 / **公開連携が未設定の初期状態で
  「書き出し + 受け渡し」が完結する**。
- 規模感: **M**。

### Phase 5 — 旧 studio 撤去

- 目的: desktop が全機能(IG + YouTube + 全ターゲット形状)をカバーしたことを確認し
  旧実装を削除する。
- 作業: `apps/studio`(server + web)、`packages/ffmpeg-runner`、`core/filtergraph`・
  `core/presets`(未使用)を削除。ドキュメント更新。
- 受け入れ基準: 旧 studio の全ユースケースを desktop が満たすことをレビュー確認 /
  削除後も `pnpm build`・`pnpm test`・`pnpm -r typecheck` が緑。
- 規模感: **S**。

---

## 9. ビルド・CI・配布

- **turbo 駆動**: turbo → pnpm script → cargo/tauri の二段。desktop build は contract
  の schema 生成に `dependsOn`。JS 側は turbo キャッシュ、Rust は cargo incremental +
  `rust-cache`。
- **CI ツールチェーン**: `setup-node` + Rust toolchain 併設。Tauri のシステム依存
  (Win は WebView2)に注意。既存 CI(Node 24)は維持。
- **Rust 品質ゲート(Phase 2 で CI に追加)**: `cargo fmt --check`(規約は
  `apps/desktop/rustfmt.toml` の `hard_tabs = true`)+ `cargo clippy -- -D warnings` +
  **cargo-deny**(依存クレートのライセンス検査。GPL 系を deny リスト化し「GPL
  コンポーネント不同梱」(§11-2)を CI で構造的に担保)+ `cargo audit`(脆弱性)。
  Windows ランナーでの `cargo check` は libav ビルド回帰を兼ねる(§Phase2 作業 2-0)。
- **署名**: mac は Apple Developer 証明書 + notarization、Win は Authenticode。証明書
  は CI シークレット管理。

---

## 10. リスクと軽減策

| リスク | 影響 | 軽減策 |
|---|---|---|
| **libav 統合の難度**(ビルド・リンク・API) | Phase 2 遅延 | **mac は先行スパイクで実証済み**(ffmpeg-next 8.1 リンク成功・blur-pad SSIM=1.0, 2026-07-11)。**残リスクは Windows / Media Foundation に集中** → Phase 2 の先頭ゲート(作業 2-0)で先行検証。no-go 時はベンダ HW(qsv/nvenc/amf)へフォールバック。GStreamer を代替保持 |
| **FFmpeg ライセンス感染 / H.264 ソフトフォールバックの不在** | 配布不可 or フォールバック手段喪失 | **§11-2 確定**: HW エンコーダ第一・**libx264 破棄**・ソフトは openh264 実行時 DL(Cisco 特許肩代わり)を Phase 2.5 に後置。LGPL 動的リンク前提(§Phase4) |
| **in-process 化による GPL 回避シールドの喪失** | 配布時のライセンス露出 | 現状の CLI spawn は「別プロセスの ffmpeg を持参」で GPL 汚染を回避していた。libav を静的/動的リンクすると盾が消えるため、**LGPL ビルド + 動的リンク + GPL コンポーネント(x264 等)不同梱**を厳守(§6.2・Phase 4) |
| **YouTube 移行の依存**(OAuth + resumable upload) | Phase 3 遅延 | **§11-4 確定**: 案 A(Rust)を `google-youtube3` + `yup-oauth2` に乗せて実装(手書きせず既製クレートで de-risk)。Phase 3 は公開リリース経路外のため遅延しても OSS 版は非ブロック |
| **プレビュー配信の再設計**(HTTP サーバ喪失) | UI 再生不能 | asset protocol(`convertFileSrc`)で再設計。Phase 1〜2 で先行検証 |
| **中断機構の喪失**(kill 不可) | エクスポート中断不能 | libav ループに明示キャンセル。Phase 2 受け入れ基準 |
| **旧実装との出力差** | 品質退行 | SSIM/PSNR + 寸法/尺のスクリプト検証を受け入れ基準に |
| **contract のドリフト** | 登録失敗 | CI diff ゲート + Rust round-trip テスト |
| **二重ツールチェーンの CI 複雑化** | ビルド不安定 | Rust を `apps/desktop` 配下に閉じ込めキャッシュ分離 |
| **セルフホスト Worker の公開露出**(無認証 POST /jobs) | 第三者に投稿ジョブを積まれる | Bearer トークン認証を Phase 3 で追加(§6.6)。手順書配布の前提条件 |
| **セルフホスト利用者の YouTube 未監査ロック** | 予約公開フリップが機能しない | 手順書に監査申請(個人でも可)と手動フォールバックを明記(§6.5) |
| **プラットフォーム仕様の変動**(IG 300MB 上限・レート・media_type 許容値、YT クォータ等) | バリデーション齟齬 / 投稿失敗 | 仕様は §12 に検証日付きで集約し、Phase 3 / Phase 5 受け入れ時に公式リファレンスで再確認。`mediaType: VIDEO` 廃止は実機確認を先行(Phase 0) |

---

## 11. 未決事項(すべて確定済み — v2.3)

1. ~~プリセット共有の方式~~ → **確定(§6.3)**: `EditSpec` スキーマのみ共有、プリセット
   表は web 側に閉じる。Rust はプリセット表を持たない。
2. ~~フォールバックコーデックの選定~~ → **確定(§6.2・§10)**: HW エンコーダ(VideoToolbox /
   Media Foundation)を第一候補とし、**libx264 は GPL のため破棄**。ソフト H.264 は
   **openh264 の Cisco 配布バイナリを実行時 DL**(BSD + Cisco が MPEG-LA へ特許料肩代わり)
   する方式だが、両対象 OS で OS エンコーダが事実上常在し -12903 はセマフォが緩和するため、
   **Phase 2 には入れず Phase 2.5 の hardening に後置**(no-HW が実機で出たら追加)。LGPL
   動的リンク + GPL コンポーネント不同梱を厳守(§Phase4)。
3. ~~認証情報の保管方式~~ → **確定**: R2 キー / YouTube OAuth トークン / `SCHEDULER_URL` +
   Bearer トークンを **OS キーチェーン**(macOS Keychain / Windows Credential Manager,
   `keyring` クレート)+ 設定 UI に置く。Tauri 独自ストア(Stronghold)より OS 側を採る
   (マスターパスワード不要・OS レベル保護・生体認証ゲート可)。
4. ~~YouTube 移行方式~~ → **確定(§6.5)**: **案 A(Rust 再実装)**。REST のみで in-process の
   必然がなく、Node 同梱は単一バイナリ方針に反するため案 B は不採用。`google-youtube3` +
   `yup-oauth2` に乗り resumable upload / OAuth を手書きしない。
5. ~~配布対象~~ → **確定(§2 配布方針・§6.6)**: OSS として第三者へ無料配布する。
   公開連携は設定駆動の実行時ゲートで解放(対象は自分 + セルフホスト可能な技術者)。
   これに伴い scheduler への **Bearer トークン認証追加を必須化**(Phase 3)。
   マルチテナント化・課金基盤・Meta App Review は**構造的に不要**(各自が自分の
   Meta/Google アプリで自分のアカウントに投稿するため)。
6. ~~生成 Rust コードの扱い~~ → **確定**: build.rs 生成(非コミット)+ CI diff ゲート。
   typify は**バージョン固定**して codegen ドリフトを防ぐ(§6.1・Phase 0)。

---

## 12. プラットフォーム公開仕様(公式ドキュメント検証: 2026-07-07)

> 数値・許容値は変動する。**本節を更新する際は必ず検証日と出典を残し**、
> Phase 3 / Phase 5 の受け入れ時に最新の公式リファレンスで再確認すること。

### 12.1 Instagram(Graph API / Content Publishing)

公開フロー(現 scheduler 実装との一致を確認済み):
`POST /{ig-user-id}/media`(コンテナ作成)→ `status_code` ポーリング
(公式推奨: 1 分間隔・最大 5 分)→ `POST /{ig-user-id}/media_publish`。
コンテナは約 24 時間で失効するため公開時刻到来後に作成する(現
[cron.ts](apps/scheduler/src/cron.ts) + publish-do の構成は公式推奨と整合)。
**予約公開はネイティブ非対応**(`media_publish` は即時のみ)— scheduler が
存在する理由そのもの。

| 項目 | 公式仕様 | Facet への含意 |
|---|---|---|
| `media_type` | **CAROUSEL / REELS / STORIES のみ**。`VIDEO` は現行リファレンスの許容値に無い | **contract の `mediaType: "VIDEO"` は廃止対象**。1:1 / 4:5 も REELS として投稿する(比率 0.01:1〜10:1 が受理されるため可能)。→ Phase 0 |
| ファイル渡し | (a) `video_url`: 公開 URL を Meta 側が cURL で取得 / (b) resumable: `rupload.facebook.com` へ直アップ | 現構成は (a)。**R2 バケット(のオブジェクト)が公開読取可能であることが前提** |
| コンテナ形式 | MOV / MP4、**moov atom 先頭**、edit list なし | `-movflags +faststart` 相当。現 runner で実装済み、media-core でも維持(§6.2) |
| コーデック | 映像 H.264 / HEVC(プログレッシブ、closed GOP、4:2:0)、音声 AAC **≤48kHz**(1〜2ch) | 出力を H.264 + AAC に固定(§12.3) |
| 解像度 / 比率 | **水平最大 1920px**。比率 0.01:1〜10:1(推奨 9:16) | 全ターゲット(幅 1080〜1920)適合 |
| フレームレート | 23〜60 fps | ソース依存。probe で事前検証 |
| ビットレート | 映像 VBR ≤25Mbps、音声 128kbps | 既定(8M / 128k)で適合 |
| 尺 | **3 秒〜15 分** | クリップは短尺前提で適合。※「Reels タブ掲載は 5〜90 秒 / 9:16」という条件は現行公式リファレンスに明記なし(二次情報。参考扱いとする) |
| ファイルサイズ | **最大 300MB** | **enqueue 前のバリデーション必須**(8Mbps なら約 5 分で到達)→ Phase 3 |
| レート制限 | **100 API 投稿 / 24h(移動窓)**。残数は `GET /{ig-user-id}/content_publishing_limit` | 個人運用では実質制約なし |

### 12.2 YouTube(Data API v3 / `videos.insert`)

| 項目 | 公式仕様 | Facet への含意 |
|---|---|---|
| 認証 | OAuth 2.0 + `youtube.upload` スコープ | §6.5 |
| アップロード | **resumable upload**(チャンクは 256KB の倍数、最終チャンクのみ任意)。MIME は `video/*` / `application/octet-stream` | 案 A(Rust)確定。`google-youtube3` の `upload_resumable` に委ねる(手書きしない, §6.5・§11-4) |
| 上限 | ファイル **256GB** / 尺 12 時間 | 事実上制約なし |
| 予約公開 | `publishAt`(`privacyStatus=private` が条件)で **YouTube 側が時刻公開** | **監査済みプロジェクトのみ有効**。未監査は強制 private ロック(§6.5) |
| クォータ | `videos.insert` = **1,600 unit/回**、既定 10,000 unit/日 ≈ **6 本/日** | 個人運用では十分。セルフホスト手順書に注記 |

YouTube の予約公開は二本立てで扱う(§6.5 と整合):

- **監査済み(自分の環境)**: `publishAt` による予約公開(現 youtube.ts の方式を維持)。
- **未監査(セルフホスト利用者)**: `publishAt` は機能しないため、**非公開アップロード
  → YouTube Studio で手動予約**のフォールバックを手順書に明記する。

### 12.3 共通の出力仕様(re-frame 出力の固定)

- 出力は **MP4 / H.264 / AAC(≤48kHz)/ moov 先頭(+faststart)** に固定すれば
  両プラットフォームで齟齬が出ない。現 runner の既定(8M / aac 128k /
  `+faststart`)は適合しており、**media-core でも同一の出力仕様を維持する**
  (§6.2, Phase 2 の同等性検証項目)。
- IG のみ **300MB・尺 3 秒〜15 分**のきつい制約があるため、**IG 向け enqueue 前に
  ファイルサイズ・尺のバリデーション**を入れる(Phase 3)。

出典(検証 2026-07-07):
[Content Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/) /
[IG User Media リファレンス](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/) /
[videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) /
[Resumable Uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)

---

## 13. 用語

- **libav**: FFmpeg のライブラリ群。Rust バインディングは `ffmpeg-next`。
- **blur-pad / crop-cover**: fit モード。blur-pad は `split → gblur=sigma=20 →
  中央 overlay`、crop-cover は覆うスケール + 中央クロップ。
- **JobManifest**: ローカル → scheduler の境界となるジョブ契約(`packages/contract`)。
  IG 専用(YouTube は publishAt で YT 側が公開)。
- **EditSpec**: 編集の全指定(source/trim/crop/preset)。renderer → Rust コアの入力。
- **typify**: JSON Schema から Rust の serde 型を生成するツール。
- **asset protocol / convertFileSrc**: Tauri でローカルファイルを webview から参照
  する仕組み(HTTP サーバの代替)。
- **R2**: Cloudflare のオブジェクトストレージ(S3 互換)。

---

## 付録: フェーズ依存関係

```
Phase 0 (契約) ──▶ Phase 1 (スキャフォルド) ──┬──▶ Phase 2 (メディアコア, 主リスク) ──▶ Phase 4 (配布)
                                              │                                            │  = OSS 公開リリース
                                              └──▶ Phase 3 (公開連携: ゲート機能) ─────────┤
                                                    (Phase 1 後に Phase 2 と並走可。          │
                                                     公開リリースの前提ではない)             ▼
                                                                                     Phase 5 (旧撤去)
```

- **OSS 公開リリースの最短経路は Phase 0 → 1 → 2 → 4**(公開連携なしで成立)。
- **Phase 5(旧 studio 撤去)は Phase 3 + Phase 4 の両方の完了が前提**(自分の
  ワークフロー = IG/YouTube 予約公開が desktop で完結してから旧実装を消す)。
