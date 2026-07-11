# Phase 2-0 Windows 検証手順(先行ゲート: h264_mf / h264_amf)

`docs/desktop-migration-plan.md` Phase 2 作業 2-0(§8「Phase 2 — メディアコア」・
§12.3)に対応する、Windows 実機での go/no-go 判定手順。人間・Claude Code どちらが
実行しても自己完結するように書いている。

目次:

1. [前提](#1-前提)
2. [環境構築](#2-環境構築)
3. [検証実行](#3-検証実行)
4. [go/no-go チェックリスト](#4-gono-go-チェックリスト)
5. [no-go 時の分岐手順](#5-no-go-時の分岐手順)
6. [落とし穴集](#6-落とし穴集)

---

## 1. 前提

- **対象機**: AMD Radeon RX 9070 XT 搭載の Win 実機(手元の検証機。CI の Windows
  ランナーは GPU なし VM のため HW MFT が存在せず、この検証には使えない
  — 計画書 §8 Phase 2 作業 2-0 参照)。
- **目的**: `h264_mf`(Media Foundation)で in-process H.264 HW エンコードが成立するか
  の go/no-go 判定。mac 側は `h264_videotoolbox` で先行検証済み(spikes/libav-reframe、
  blur-pad が完走・CLI 参照と SSIM=1.0)。残るリスクは Windows/Media Foundation に
  集中しており、この 2-0 が緑になるまで media-core 本体の Windows 対応は着手しない。
- **所要の目安**: 環境構築(初回)約 30〜45 分(ダウンロード時間に依存)、検証実行
  自体は 10〜15 分。

---

## 2. 環境構築

PowerShell(管理者権限)で実行する。winget が使える前提(Windows 10 1809+ / 11 は標準
搭載)。

### 2.1 Visual Studio 2022 Build Tools(C++ ワークロード)

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override `
  "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

rustc の MSVC ターゲットには MSVC リンカ(link.exe)と Windows SDK が要る。GUI で入れる
場合は「Visual Studio Installer」→「C++ によるデスクトップ開発」ワークロードを選択。

### 2.2 rustup(stable-msvc)

```powershell
winget install --id Rustlang.Rustup -e
# 新しいシェルを開くか、PATH を再読込してから:
rustup toolchain install stable-msvc
rustup default stable-msvc
rustc --version
```

### 2.3 LLVM(bindgen 用 libclang)

`ffmpeg-sys-next` はヘッダ解析に bindgen を使い、bindgen は libclang(`libclang.dll`)を
必要とする。

```powershell
winget install --id LLVM.LLVM -e
[Environment]::SetEnvironmentVariable("LIBCLANG_PATH", "C:\Program Files\LLVM\bin", "User")
```

設定後は **新しいシェルを開き直す**(現在のセッションに反映するだけなら
`$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"` を都度実行してもよい)。

### 2.4 FFmpeg 8.x(shared ビルド)

`ffmpeg-sys-next` を事前ビルド済み FFmpeg にリンクするため、**shared(動的リンク用の
import lib + dll 同梱)ビルド**を使う。static ビルドは `include/`・`lib/`(.lib)構成が
異なり `FFMPEG_DIR` 解決に失敗しやすいので避ける。

BtbN の win64-gpl-shared(zip、Windows 標準の `Expand-Archive` で展開できる)を推奨。
**必ず `n8.1` 固定のアセットを使う**(`master-latest` は FFmpeg の開発版スナップショット
で、`ffmpeg-next = "8.1"` のバインディングと不一致になり得る。mac 側の検証も 8.1 系で
実施しており、条件を揃える):

```powershell
$dest = "C:\ffmpeg"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip" -OutFile "$dest\ffmpeg.zip"
Expand-Archive -Path "$dest\ffmpeg.zip" -DestinationPath $dest -Force
# 展開後、$dest\ffmpeg-n8.1-latest-win64-gpl-shared-8.1\ 配下に bin/include/lib がある想定。
# 注: アセット名は BtbN 側で変わりうる。404 になる場合は
# https://github.com/BtbN/FFmpeg-Builds/releases/tag/latest で n8.1 の shared zip を探す。
$ffmpegRoot = Get-ChildItem $dest -Directory | Select-Object -First 1 -ExpandProperty FullName

[Environment]::SetEnvironmentVariable("FFMPEG_DIR", $ffmpegRoot, "User")
[Environment]::SetEnvironmentVariable("PATH", "$env:PATH;$ffmpegRoot\bin", "User")
```

代替(BtbN が落とせない場合): [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) の
`ffmpeg-release-full-shared.7z`(展開に 7-Zip が要る)。**バージョンが 8.1 系である
ことを確認してから**使い、同様に展開先を `FFMPEG_DIR` に設定し、`bin` を PATH に
追加する。

新しいシェルを開き直し、`ffmpeg -version` と `ffprobe -version` が通ることを確認する。

> **注: これらは GPL ビルド**(x264/x265 等の GPL コンポーネント同梱)。この 2-0 検証は
> スパイク(非配布・ローカル検証のみ)なので問題ないが、**製品として配布するビルドには
> 使わない**。配布ビルドは計画書 §Phase4(LGPL 動的リンク + GPL コンポーネント不同梱)
> の構成を別途用意する。

---

## 3. 検証実行

```powershell
# clone + ブランチ
git clone https://github.com/zinmacky/facet.git C:\work\facet
cd C:\work\facet
git checkout feat/desktop-migration-phase0-1

# テスト動画合成(mac 側の回帰検証と同一条件: 5秒 1920x1080)
ffmpeg -y -f lavfi -i testsrc2=size=1920x1080:rate=30:duration=5 `
  -c:v libx264 -pix_fmt yuv420p input_test.mp4

# スパイクをビルド
cd spikes\libav-reframe
cargo build

# h264_mf で reframe(スパイクの実引数順: input output fit target_w target_h [encoder])
.\target\debug\reframe.exe ..\..\input_test.mp4 out_mf.mp4 blur-pad 1080 1920 h264_mf

# 確認
ffprobe -v error -select_streams v:0 `
  -show_entries stream=width,height,codec_name,duration,nb_frames `
  -of default=noprint_wrappers=1 out_mf.mp4
```

crop-cover も合わせて確認する場合:

```powershell
.\target\debug\reframe.exe ..\..\input_test.mp4 out_mf_crop.mp4 crop-cover 1080 1920 h264_mf
```

---

## 4. go/no-go チェックリスト

計画書 §8 Phase 2 作業 2-0 の go 判定(「`h264_mf` で 1080×1920 の reframe が完走し、
出力が実用品質」)と一致させる。すべて満たせば **go**。

- [ ] `cargo build` が Windows でエラーなく完走する(libav ビルド・リンク回帰なし)。
- [ ] `reframe.exe ... h264_mf` がパニックせず `done -> out_mf.mp4` まで到達する
      (blur-pad / crop-cover 両方)。
- [ ] `ffprobe` で `width=1080 height=1920`、`duration` が入力(5秒)とほぼ一致。
- [ ] 出力を実際に再生し、blur-pad は背景ブラー + 中央合成、crop-cover は中央クロップが
      目視で正しいこと(色破綻・ブロックノイズ・コマ落ちがない)。
- [ ] **HW パスで動いたことの確認**(下記いずれか):
  - タスクマネージャの「パフォーマンス」タブで対象 GPU を選び、`Video Encode`
    エンジンの使用率がエンコード実行中に上昇することを確認する(0% 近辺のままなら
    ソフトウェア MFT に落ちている疑いが強い — §6 参照)。
  - AMD Software(Adrenalin)のパフォーマンスオーバーレイでエンコードエンジン使用率を
    確認する。
  - PowerShell から簡易確認する場合:
    ```powershell
    Get-Counter '\GPU Engine(*)\Utilization Percentage' | `
      Select-Object -ExpandProperty CounterSamples | `
      Where-Object { $_.InstanceName -match 'engtype_VideoEncode' -and $_.CookedValue -gt 0 }
    ```
    (エンコード実行中に別ウィンドウ/バックグラウンドジョブで数回サンプリングする)

上記すべて緑なら **go**: media-core 本体(Windows 対応部分)の実装に進んでよい。

---

## 5. no-go 時の分岐手順

`h264_mf` が完走しない、または完走してもソフトウェア MFT にしか落ちない(HW 使用率が
上がらない)場合、計画書の記載どおり第一候補は `h264_amf`(検証機が AMD のため)。

```powershell
.\target\debug\reframe.exe ..\..\input_test.mp4 out_amf.mp4 blur-pad 1080 1920 h264_amf
```

同じチェックリスト(§4)を `h264_amf` で再実施する。

- `h264_amf` が go: media-core のエンコーダ選択ロジックに Windows 既定として
  `h264_amf` を組み込む方針で 2-0 を緑とし、`h264_mf` は候補から外す(または
  ソフトフォールバック専用として残すかは Phase 2 本体実装時に判断)。
- `h264_amf` も no-go: 計画書 §10(リスクと軽減策)・§5(技術選定と根拠)の
  「HW アクセル前提の見直し」に従い、Windows の HW エンコード方針自体を再検討する
  (この場合 Phase 2 は 2-0 で一旦ストップし、方針決定を待つ)。

---

## 6. 落とし穴集

- **NV12 要求**: `h264_mf`(特に HW MFT 経由)は `yuv420p` を受け付けず `NV12` のみの
  ことがある。本スパイク(`spikes/libav-reframe/src/reframe.rs`)はエンコーダの
  `codec.video().formats()` から対応形式を自動選択し(hwaccel サーフェス形式は除外)、
  フィルタグラフの `format=` とエンコーダの `set_format` を一致させているため、通常は
  意識しなくてよい。ビルドが通っても `open encoder failed` や filtergraph の
  フォーマット不一致エラーが出る場合は、まずこの自動選択の結果(起動時に標準出力へ
  `encoder=... pix_fmt=...` を出力する)を確認する。
- **DLL が見つからない**: `reframe.exe` 実行時に `avcodec-*.dll` 等が見つからず起動
  しない場合、`FFMPEG_DIR\bin` が PATH に入っていない(新しいシェルを開き直したか、
  User 環境変数がプロセスに反映されているか確認)。
- **`LIBCLANG_PATH` 未設定時の bindgen エラー**: `cargo build` が
  `Unable to find libclang` 系のエラーで失敗する場合、`LIBCLANG_PATH` が
  `C:\Program Files\LLVM\bin`(`libclang.dll` を含むディレクトリ)を指しているか、
  新しいシェルで反映されているかを確認する。
- **ソフト MFT に落ちて「動いたように見える」罠**: `h264_mf` は HW MFT が使えない
  環境(ドライバ非対応・GPU 忙殺中など)では**エラーを出さずに**ソフトウェア MFT に
  フォールバックする。`cargo build` が通り `reframe.exe` が完走し `ffprobe` の寸法も
  正しいのに、実は CPU エンコードだった、という誤 go 判定が起きやすい。**必ず §4 の
  GPU `Video Encode` 使用率確認をセットで行う**こと。エンコード中に使用率が動かない
  場合はソフト MFT 経路であり、go 判定の根拠にしない。
- **静的(static)FFmpeg ビルドを使ってしまう**: static ビルドは `lib/*.lib` の構成が
  shared ビルドと異なり、`FFMPEG_DIR` 経由のリンクに失敗するか、意図せず GPL
  コンポーネントを静的に埋め込む形になる。必ず shared ビルドを使う。

---

検証日: (2026-07-11 時点で未実施。手順は文書化のみ。実機での go/no-go 結果は本節に
追記する)

この手順は 2-0 実施時に最新化する(FFmpeg ビルドの配布 URL・バージョン、
Visual Studio / LLVM のインストーラ ID は時間経過で変わりうるため、実施前に
最新版を確認すること)。
