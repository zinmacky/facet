# Phase 4 パッケージング(FFmpeg ライセンス切り替え)

Facet desktop(`apps/desktop`)は `media-core` crate(`ffmpeg-next`)経由で FFmpeg の
共有ライブラリ(`avcodec` / `avformat` / `avutil` / `avfilter` / `swscale` /
`swresample` / `avdevice`)に動的リンクする。**開発時と配布時で使う FFmpeg ビルドの
ライセンス種別が異なる**ため、取り違えないようにこの文書にまとめる。

## 開発(GPL)とリリース(LGPL)の使い分け

| | 開発(dev / CI) | リリース(配布物) |
| --- | --- | --- |
| FFmpeg ビルド | BtbN `win64-gpl-shared`(`docs/phase2-0-windows-setup.md` §2) | BtbN `win64-lgpl-shared`(`scripts/fetch-ffmpeg-lgpl.ps1`) |
| タグ | `latest`(検証専用、再現性は求めない) | 日付固定タグに pin(`autobuild-YYYY-MM-DD-HH-MM`)。再現性・監査可能性のため |
| 取得先 | 開発者が手動 or CI キャッシュ(`.ffmpeg`) | `apps/desktop/src-tauri/ffmpeg-dist/`(DLL のみ) |
| 同梱物 | ffmpeg.exe / ffprobe.exe を含む(dev 実行に使わないが zip 構成のまま) | **DLL のみ**。ffmpeg.exe / ffprobe.exe は同梱しない |
| ビルドコマンド | `pnpm --filter @facet/desktop dev` / `cargo build`(`tauri.conf.json`) | `pnpm --filter @facet/desktop build:win-release`(`tauri.win-release.conf.json` オーバーレイ) |
| リンク先 | `FFMPEG_DIR` を GPL ビルドのルートに向ける | `FFMPEG_DIR` を **LGPL ビルドのルート**に向ける(`fetch-ffmpeg-lgpl.ps1` の戻り値) |

**重要**: 配布物は DLL を LGPL 版に差し替えるだけでは不十分。`cargo build` /
`tauri build` 自体を LGPL ビルドの `lib/`(import library)に対してリンクし直す
必要がある(`FFMPEG_DIR` を LGPL ルートに向けた状態でビルドすること)。GPL ビルドで
リンクした exe に LGPL の DLL だけ差し替えて配布することは禁止(ライセンス上・
動作上どちらの理由でも不可)。

`apps/desktop/crates/license-gate`(Wave B)が、配布ビルドが実際に LGPL DLL に
リンクされ GPL/nonfree コンポーネント(libx264 等)を含まないことを機械検証する。
`scripts/run-license-gate.ps1` で PATH を `ffmpeg-dist/` に絞って実行する。

## リリースビルド手順(骨子)

1. `./scripts/fetch-ffmpeg-lgpl.ps1` を実行し、LGPL ビルドを取得・展開して
   `apps/desktop/src-tauri/ffmpeg-dist/` に DLL をステージングする。
   戻り値(標準出力の最終行)が LGPL ビルドのルートパス。
2. `$env:FFMPEG_DIR` にそのルートパスを設定する(`$env:LIBCLANG_PATH` は
   従来どおり `C:\Program Files\LLVM\bin` 等、bindgen 用に別途必要)。
3. `pnpm --filter @facet/desktop build:win-release` を実行する
   (`tauri build --config src-tauri/tauri.win-release.conf.json`)。
   - `tauri.win-release.conf.json` は `bundle.resources` で
     `ffmpeg-dist/*.dll` と `LICENSES/COPYING.LGPLv3`(リポジトリ直下)を exe 隣接
     (`"./"`)に配置する設定のみを持つオーバーレイ(`tauri dev` には影響しない)。
4. 生成された NSIS インストーラ
   (`apps/desktop/src-tauri/target/release/bundle/nsis/*.exe`)を検証機に
   インストールし、**PATH から FFmpeg の bin ディレクトリを除外した状態**で
   起動 → 書き出しが完走し、GPU の Video Encode エンジンが稼働すること
   (`docs/phase2-0-windows-setup.md` §4 の手順を実機バイナリに対して再実施)を
   確認する。

## タグ更新時の注意

`scripts/fetch-ffmpeg-lgpl.ps1` 冒頭の `$Tag` / `$AssetName` は BtbN の
GitHub Releases API(`gh api repos/BtbN/FFmpeg-Builds/releases`)で実在を
確認した日付固定タグに pin している。`latest` は使わない。更新する場合は
`THIRD_PARTY_NOTICES.md`(Wave B で追加予定)の記載も同時に更新すること。

## 現在の pin

- タグ: `autobuild-2026-07-11-13-13`
- アセット: `ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1.zip`
- DLL(機械列挙、変更されうる): `avutil-60` / `avcodec-62` / `avformat-62` /
  `avfilter-11` / `swscale-9` / `swresample-6` / `avdevice-62`

---

## リリース手順(完全版、Wave D)

`.github/workflows/release.yml` が `v*` タグの push をトリガに Windows ランナー
1 ジョブでビルド・署名・GitHub Release(draft)作成までを行う。ローカルでの
作業は「バージョン bump → タグ push」のみで、それ以外は CI が担う。

### 1. バージョン bump

バージョンの**単一ソースは `apps/desktop/src-tauri/tauri.conf.json` の
`version`**。bump 時は以下 3 箇所を**同時に**更新する(CI 側で
`scripts/check-release-version.ps1` が 3 箇所 + git タグの一致を機械検証し、
1つでもズレていればビルド全体を fail させる):

1. `apps/desktop/src-tauri/tauri.conf.json` の `version`
2. `apps/desktop/package.json` の `version`
3. `apps/desktop/Cargo.toml` の `[workspace.package]` `version`
   (`src-tauri` / `crates/*` 配下の全クレートがここを `version.workspace = true`
   で参照しているため、この 1 箇所を変えれば全クレートに伝播する)

ルート直下の `package.json`(`facet` パッケージ自体のバージョン)は対象外
(モノレポ全体のバージョンとデスクトップアプリのリリースバージョンは独立)。

ローカルで一致を確認したい場合:

```pwsh
./scripts/check-release-version.ps1 -Tag "v0.1.0"
```

### 2. タグ push

```pwsh
git tag v0.1.0
git push origin v0.1.0
```

タグ形式は `vX.Y.Z`(正式版)または `vX.Y.Z-rc.N`(release candidate)。
`-` を含むタグ(rc 等)は GitHub Release 上で自動的に `prerelease` フラグが
付き、`releases/latest`(updater の配信先)には影響しない。

### 3. CI の流れ(`.github/workflows/release.yml`)

1. checkout + pnpm/Node セットアップ + `pnpm install --frozen-lockfile`
2. タグとバージョン単一ソースの一致チェック(`check-release-version.ps1`、
   不一致で即 fail)
3. Rust toolchain + rust-cache + `LIBCLANG_PATH` 設定
4. `scripts/fetch-ffmpeg-lgpl.ps1` で LGPL FFmpeg を取得し `FFMPEG_DIR` に設定
5. `scripts/run-license-gate.ps1`(tauri build 前のゲート。fail で全停止)
6. `pnpm --filter "@facet/desktop^..." build`(`@facet/contract` /
   `@facet/core` の dist/schema を先にビルド)
7. `tauri-apps/tauri-action@v0`(`--config src-tauri/tauri.win-release.conf.json`、
   `releaseDraft: true`、`TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` で署名)
8. 成果物検査: NSIS の updater 用 zip(`*.nsis.zip`)を展開し、期待する DLL が
   すべて同梱・実行ファイルの混入なし・`COPYING.LGPLv3` 同梱・
   `license-gate` の再実行、を確認

### 4. draft 確認 → publish

CI 成功後、GitHub の Releases ページに **draft** リリースが作成される
(自動公開はしない)。以下を目視確認してから `Publish release` する:

- 添付アセット: NSIS インストーラ(`*.exe`)、`*.nsis.zip`、`*.sig`、
  `latest.json`(updater 用マニフェスト)が揃っていること
- リリースノート(`releaseBody`)の内容
- `prerelease` フラグが意図通りか(rc は on、正式版は off)

publish すると `latest.json` が
`https://github.com/zinmacky/facet/releases/latest/download/latest.json`
から取得可能になり、既存ユーザーのアプリ内更新チェック(Wave C
`useUpdateChecker`)が新バージョンを検知するようになる。**publish は
ユーザー作業**(§ ユーザー作業 参照)。

### 5. 初回リリース前チェックリスト(未完了の前提)

Wave D 時点では updater の署名鍵が未生成のため、`tauri-action` の署名ステップは
`TAURI_SIGNING_PRIVATE_KEY` が未設定のままだと失敗する(既知・意図的。
下記が揃うまで実際のリリースは実行できない)。初回リリース前に**ユーザーが**
行う必要がある作業:

1. **updater 鍵の生成**:
   ```pwsh
   pnpm tauri signer generate -w ~/.tauri/facet-updater.key
   ```
   パスワード付きで生成すること。生成される公開鍵(pubkey)と秘密鍵
   (`.key` ファイル)の 2 つを次のステップで使う。
2. **GitHub Secrets への登録**(リポジトリの Settings → Secrets and variables →
   Actions):
   - `TAURI_SIGNING_PRIVATE_KEY`: 生成した秘密鍵ファイルの中身
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: 鍵生成時に設定したパスワード
3. **pubkey の差し替え**: `apps/desktop/src-tauri/tauri.conf.json` の
   `plugins.updater.pubkey` は現在プレースホルダ
   (`TODO_REPLACE_WITH_UPDATER_PUBKEY`)のまま。手順 1 で生成した公開鍵の
   文字列に差し替えるコミットを作成すること(このコミットもバージョン bump と
   同様にタグより前に main へマージしておく必要がある)。
4. **秘密鍵のオフラインバックアップ**: 秘密鍵ファイル(`~/.tauri/facet-updater.key`)
   と、そのパスワードを Secrets とは別の場所にバックアップする。**紛失すると
   既存ユーザーへの更新配信ができなくなる**(pubkey を差し替えると既存インストール
   済みアプリが新しい更新を検証できなくなるため)。
5. **初回 e2e 更新テスト**(ユーザー立ち会い): 旧バージョンをインストール → 新
   タグを publish → アプリ内通知が表示され更新が完走することを確認する。
6. **タグ push / publish の実運用**: 上記 1〜3 が完了した状態で、初回タグ
   (例 `v0.1.0`)の push と draft の publish を行う。

上記が未完了の間は、`release.yml` は署名ステップ(手順 7)まで到達してエラーで
停止する(検証は Wave D で実施済み。エラーメッセージ含め本文書の変更履歴・
PR の報告を参照)。それより前のステップ(バージョンチェック・LGPL FFmpeg
取得・ライセンスゲート・ワークスペースビルド)はすべて正常に通ることを確認済み。
