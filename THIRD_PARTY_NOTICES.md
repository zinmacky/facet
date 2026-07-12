# サードパーティ通知(Third-Party Notices)

Facet デスクトップ版(`apps/desktop`)の配布物(NSIS インストーラ)には、Facet 本体の
コードに加えて以下のサードパーティ製ソフトウェアが同梱されます。本ドキュメントは
それぞれの出典・ライセンス・入手方法を記録するものです。

配布物のライセンス適合は `apps/desktop/crates/license-gate`(Phase 4 Wave B)による
実行時の機械検証で担保しています。検証方法は本文書末尾を参照してください。

---

## 1. FFmpeg(LGPL v3、動的リンク)

Facet デスクトップ版は FFmpeg の共有ライブラリ(`avutil` / `avcodec` / `avformat` /
`avfilter` / `avdevice` / `swscale` / `swresample` の各 DLL)を **LGPL v3 構成**で
動的リンクし、インストーラに同梱します。GPL 専用コンポーネント
(`libx264` / `libx264rgb` / `libx265` / `libxvid` 等)は**一切同梱しません**
(Windows 標準の HW エンコーダである `h264_amf` / `h264_mf` を使用します)。

- **プロジェクト**: FFmpeg(<https://ffmpeg.org/> / ソースリポジトリ
  <https://github.com/FFmpeg/FFmpeg>)
- **ライセンス**: GNU Lesser General Public License version 3(LGPL v3)。
  全文は本リポジトリの [`LICENSES/COPYING.LGPLv3`](./LICENSES/COPYING.LGPLv3) を参照。
- **ビルド提供元**: BtbN の自動ビルド配布(<https://github.com/BtbN/FFmpeg-Builds>)。
  `--enable-gpl` を含まない `lgpl-shared` 構成のビルドのみを使用する。
- **同梱物の入手元**: `scripts/fetch-ffmpeg-lgpl.ps1`(Phase 4 Wave A)が以下の
  固定タグ・アセットから取得し、`apps/desktop/src-tauri/ffmpeg-dist/` に DLL のみを
  ステージングする。
  - **タグ(pin)**: `autobuild-2026-07-11-13-13`
  - **アセット**: `ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1.zip`
  - **リリースページ**:
    <https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-07-11-13-13>
  - **FFmpeg 本体のソース**: 上記ビルドのコミット
    `94138f6973`(FFmpeg n8.1.2 系)。ソースは
    <https://github.com/FFmpeg/FFmpeg/commit/94138f6973> から取得可能。BtbN の
    ビルドスクリプト・パッチ一式は <https://github.com/BtbN/FFmpeg-Builds> に
    ある(コンパイル済みバイナリを再ビルドするための情報)。
  - **ビルド設定(configure フラグ)の要点**: `--enable-version3`
    (LGPL v3 化に必須)、`--enable-shared --disable-static`、`--enable-amf`
    `--enable-schannel` 等の Windows HW/OS 統合系フラグ。`--enable-gpl` /
    `--enable-nonfree` / `--enable-libx264` / `--enable-libx265` /
    `--enable-libxvid` は**含まれない**(license-gate が実行時に確認する)。

  > **注意(統合時に確認すること)**: 上記のタグ・アセットは Wave B(本ドキュメント)
  > 作成時点で BtbN のリリース一覧から著者が独自に選定したものであり、Phase 4
  > Wave A(`feat/phase4-lgpl-ffmpeg` ブランチ、`scripts/fetch-ffmpeg-lgpl.ps1`)が
  > 別の日付タグを pin している可能性がある。Wave A とマージ・統合する際は
  > `scripts/fetch-ffmpeg-lgpl.ps1` が実際に取得するタグと本ドキュメントの記載が
  > 一致しているかを確認し、ズレていればこの節を実際の pin 先に合わせて修正すること。

- **改変**: Facet はソースコードを改変せず、BtbN が公開するビルド済みバイナリを
  そのまま使用する。

---

## 2. 主要な Rust クレート(実行ファイルに静的リンク)

`apps/desktop`(Tauri v2 シェル・`crates/media-core`・`crates/contract-rs`・
`crates/license-gate`)がビルド時に静的リンクする Rust クレートのライセンスは
`apps/desktop/deny.toml` の allow リストで機械的に強制している
(`cargo deny check`、CI で実行)。ここでは配布物に含まれる主要なクレートのみを
記載する。全依存関係は `apps/desktop/Cargo.lock` を参照。

| クレート | ライセンス | 用途 |
|---|---|---|
| [tauri](https://github.com/tauri-apps/tauri) / tauri-plugin-dialog / tauri-plugin-opener | MIT OR Apache-2.0 | デスクトップアプリシェル |
| [wry](https://github.com/tauri-apps/wry) / [tao](https://github.com/tauri-apps/tao) | MIT OR Apache-2.0 | WebView / ウィンドウ管理(tauri の内部依存) |
| [ffmpeg-next](https://github.com/zmwangx/rust-ffmpeg) / [ffmpeg-sys-next](https://github.com/zmwangx/rust-ffmpeg-sys) | WTFPL | FFmpeg(§1)への Rust バインディング(バインディングコード自体のライセンス。リンクする FFmpeg 本体は §1 の LGPL v3) |
| [windows-sys](https://github.com/microsoft/windows-rs) / windows | MIT OR Apache-2.0 | Windows API 呼び出し(license-gate の DLL パス解決、tauri の内部依存) |
| [serde](https://serde.rs/) / serde_json | MIT OR Apache-2.0 | シリアライズ(ジョブ契約・設定) |
| [sha2](https://github.com/RustCrypto/hashes) | MIT OR Apache-2.0 | プレビューキャッシュキーのハッシュ計算 |
| [thiserror](https://github.com/dtolnay/thiserror) | MIT OR Apache-2.0 | エラー型定義 |
| [uuid](https://github.com/uuid-rs/uuid) | MIT OR Apache-2.0 | ジョブ ID 発行 |

## 3. 主要なフロントエンド依存(`apps/desktop` の web 部分)

| パッケージ | ライセンス | 用途 |
|---|---|---|
| [React](https://react.dev/) / react-dom | MIT | UI |
| [@tauri-apps/api](https://tauri.app/) / plugin-dialog / plugin-opener | MIT OR Apache-2.0 | Tauri JS バインディング |
| [@tanstack/react-query](https://tanstack.com/query) | MIT | サーバ状態管理 |
| [Vite](https://vitejs.dev/) | MIT | ビルドツール(ビルド時のみ、配布物には含まれない) |
| [Tailwind CSS](https://tailwindcss.com/) | MIT | スタイリング(ビルド時に CSS へコンパイルされる) |

---

## 検証方法(機械検証ゲート)

配布ビルドが実際に LGPL 構成の FFmpeg のみをリンクしていること(GPL 専用
コンポーネントの混入がないこと)は、`apps/desktop/crates/license-gate` が
実行時に以下を検証する:

1. `avutil_license()` が `"LGPL"` で始まる。
2. `avcodec_configuration()` に `--enable-gpl` 等の禁止フラグが含まれない。
3. `libx264` / `libx264rgb` / `libx265` / `libxvid` が未登録。
4. `h264_amf` / `h264_mf`(LGPL 構成でも収録される Windows HW エンコーダ)が登録済み。
5. 検査に使った DLL の実パスをログ出力する。

`scripts/run-license-gate.ps1` で実行する。1つでも不合格なら非ゼロ終了する
(リリース CI ではこのゲートの失敗でビルド全体を停止する、Phase 4 Wave D)。
