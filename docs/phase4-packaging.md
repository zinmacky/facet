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
| ビルドコマンド | `pnpm --filter @facet/desktop dev` / `cargo build`(`tauri.conf.json`) | `pnpm --filter @facet/desktop build:release`(`tauri.release.conf.json` オーバーレイ) |
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
3. `pnpm --filter @facet/desktop build:release` を実行する
   (`tauri build --config src-tauri/tauri.release.conf.json`)。
   - `tauri.release.conf.json` は `bundle.resources` で
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
