# Mac 開発への引き継ぎ(2026-07-12 時点)

Windows 機(RX 9070 XT)での開発セッションから Mac へ主開発を移すための引き継ぎ。
以後の役割分担: **開発 = Mac、Windows は動作確認(HW エンコード検証・更新 e2e)専用**。

## 1. 現在地(何がどこまで終わっているか)

- **Phase 0〜1**: contract の JSON Schema 生成、Tauri v2 スキャフォルド + studio/web レンダラ移植(PR #15)
- **Phase 2**: media-core 完成(PR #17〜#22)+ renderer 配線(#23)+ E2E バグ修正(#24, #25)
- **UI 品質固め**: 書き出し/アップロード画面の洗練(#26, #27, #30, #32)、ウィザード化(#33)、
  シークバー改善(#31)、音量調節(#29)、フロントテスト基盤(#35)、P1 バグ修正(#36, #41, #44)、
  モックハーネス(#37)、リファクタ(#39)、プレビューキャッシュ削除ポリシー(#45)
- **設定画面**: エンコーダ選択・同時実行数(#47)、通知/設定画面は別途進行中だったはず(要状況確認)
- **Phase 4(配布)**: 実装完了(#50 license-gate、#51/#52 updater、#53 LGPL 同梱、#55 release.yml + LICENSE)。
  **初回リリースは未実施 — §5 のチェックリスト参照**
- **Phase 3(IG/YouTube 公開連携)**: 未着手。計画書 §8 参照。投稿ボタンは UI 上 disabled のまま

テスト資産: renderer vitest 84件 / media-core 129件+ / src-tauri 14件 / #[ignore] の実機統合テスト
(audio_regression, concurrency_reframe, cancellation_and_output_busy_reframe)。

## 2. 検証状態のマトリクス(重要)

| 項目 | Windows | Mac |
|---|---|---|
| TS モノレポ(build/test/lint) | ✅ | ✅(OS 非依存) |
| media-core コンパイル | ✅ | ✅(cfg ゲート済みの設計。CI では未保証 → §4-1) |
| media-core 実機動作(書き出し・音声・キャンセル・プレビュー) | ✅ 検証済み | ❌ **未検証** |
| HW エンコード | ✅ h264_amf(GPU 実測済み) | ❌ h264_videotoolbox は本体未検証(旧スパイクのみ) |
| VideoToolbox の -12903 リトライ(concurrency.rs) | -(AMF はエラーにならず時分割) | ❌ 未検証(このリトライの本来の対象) |
| インストーラ(NSIS + LGPL DLL 同梱) | ✅ 実機検証済み | -(Mac 配布は未計画) |

**Mac での最優先タスクは「media-core 実機検証」**(§4-2 のチェックリスト)。

## 3. Mac 環境セットアップ

- Node >=22 + pnpm 9.7.0(packageManager 指定)、Rust stable、FFmpeg 8.x を Homebrew で
  (`brew install ffmpeg` — 8.1 系であること。ffmpeg-next 8.1 は FFmpeg 8.x ヘッダ必須)。
  リンクは pkg-config 経由で自動(FFMPEG_DIR 不要)。CLAUDE.md の Rust 節参照
- セットアップ順: `pnpm install` → `pnpm build`(または `pnpm test`)→ `pnpm -r typecheck`
  (**クローン直後に typecheck 単独実行は dist/ 未生成で必ず失敗する**)
- 品質ゲート(コミット前): `pnpm -r typecheck` / `pnpm test` / `pnpm lint` +
  Rust 変更時は apps/desktop で `cargo fmt --check` / `cargo clippy --workspace -- -D warnings` / `cargo test --workspace`
- UI 確認: `pnpm --filter @facet/desktop dev`(実 Tauri)/ `pnpm --filter @facet/desktop dev:mock`
  (port 5190、ブラウザで renderer を操作できるモックハーネス — UI 作業のスクショ・計測に便利)
- 実機依存テスト: `cargo test --workspace -- --ignored`(実 FFmpeg 必須。Mac では videotoolbox 経路になる)

## 4. Mac でやるべきタスク(優先順)

### 4-1. macOS CI ジョブの追加(小)
.github/workflows/ci.yml に macos-latest ジョブ(brew ffmpeg + cargo build/test + pnpm test)を追加し、
Mac のビルド回帰を CI で守る。現状 ubuntu + windows のみで Mac は無防備。

### 4-2. media-core の Mac 実機検証(最優先・Mac でしかできない)
Windows 検証(docs/phase2-0-windows-setup.md §4 と同じ観点)の Mac 版:
1. `cargo run -p media-core --example reframe -- <input> <out> blur-pad 1080 1920`(エンコーダ自動選択で
   h264_videotoolbox が選ばれること — stderr/戻り値で確認)
2. HW 動作確認: アクティビティモニタ or `sudo powermetrics` 等で HW エンコードの稼働を確認
   (ソフトウェアフォールバックの静落ちに注意 — Windows で h264_mf が静かに SW MFT に落ちた前科あり)
3. 音声付き(ステレオ/44.1k/96k→48k ダウンサンプル)、trim 付き、キャンセル(一時ファイルが残らない)、
   同一出力先の二重実行が OutputBusy になること
4. **-12903 リトライの実地確認**: MAX_CONCURRENT_ENCODES を上げて同時多重書き出しし、
   VideoToolbox セッション枯渇 → concurrency.rs のリトライで回復すること(このコードの本来の検証)
5. `cargo test --workspace -- --ignored` が Mac で green
6. tauri dev でアプリを起動し、読み込み→編集→書き出し→アップロード画面の通し確認

### 4-3. 初回リリース(§5)/ 4-4. Phase 3(IG/YouTube 連携、計画書 §8)

## 5. 初回リリース前チェックリスト(docs/phase4-packaging.md に詳細)

1. updater 鍵生成: `pnpm tauri signer generate -w ~/.tauri/facet-updater.key`(apps/desktop で。
   **エージェントは権限ガードで実行不可 — 人間が実行**)
2. GitHub Secrets: `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
3. tauri.conf.json の `plugins.updater.pubkey`(現在 `TODO_REPLACE_WITH_UPDATER_PUBKEY`)を差し替え
4. 秘密鍵のオフラインバックアップ(紛失 = 既存ユーザーへ更新配信不能)
5. バージョン bump(tauri.conf.json が単一ソース、package.json / Cargo.toml を同時更新)→
   `vX.Y.Z` タグ push → draft Release 確認 → publish(publish した瞬間に updater 配信開始)
6. 更新 e2e: **Windows 機に検証用の旧版がインストール残置済み** — 新版 publish 後、
   Windows 機でアプリ内更新が通ることを確認する(ここだけ Windows 作業)

## 6. 運用ノウハウ(Windows セッションで確立したもの)

- **マージ規律**: main はブランチ保護が実質未設定のため、`gh pr merge --auto` は **CI を待たず即マージ
  される**(これで main が一時 red になった事故あり)。鉄則: `gh pr checks <PR> --watch` で全 green を
  確認してから `gh pr merge --merge`。恒久対策として「Require status checks」の再設定を推奨(未実施)
- **CI トリガー**: ci.yml は base=main の PR しか走らない。スタック PR はローカルゲートで代替
- **LGPL 規律**: 配布ビルドは必ず `FFMPEG_DIR`=LGPL でリンク(DLL だけ差し替え禁止)。
  BtbN pin タグ `autobuild-2026-07-11-13-13`(scripts/fetch-ffmpeg-lgpl.ps1 と THIRD_PARTY_NOTICES.md、
  変更時は両方同時に)。license-gate が構造ガード
- **Windows 固有**: `pnpm build` 後に packages/contract/schema/*.json へ CRLF 見かけ差分が出る
  (コミットに含めない)。Mac では発生しないはず
- **既知の残課題**: 音声と映像の trim 終端に数十 ms 差(インターリーブ順序依存)/
  facet-desktop の Linux CI 未整備(GTK 依存で clippy/test から exclude 中)/
  EditSpec は暫定手書き型(contract-rs 生成型への差し替えは将来)/
  Dependabot #26(glib、Linux 専用チェーン、上流待ち、実害なし)
- スクリプト類(scripts/*.ps1)は PowerShell。Mac から使う場合は `brew install powershell` か、
  必要になった時点で sh 版を追加

## 7. Windows 機に残っているもの

- 検証用インストール済みアプリ(更新 e2e 用に意図的に残置)
- 開発用 GPL FFmpeg(C:\ffmpeg\)、FFMPEG_DIR / LIBCLANG_PATH のユーザー環境変数
- Windows 動作確認(h264_amf の GPU 実測、インストーラ検証)はこの機で行う
