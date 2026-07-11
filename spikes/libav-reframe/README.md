# libav-reframe(検証スパイク)

`docs/desktop-migration-plan.md` の Phase 2 作業 2-0(先行ゲート・Windows 検証)用の
最小 reframe スパイクです。**製品コードではありません**(`apps/desktop` の Cargo
workspace には含まれず、`spikes/` は明示的に workspace 外です)。

decode → filtergraph(blur-pad / crop-cover)→ HW エンコーダ → mp4(+faststart)を
in-process で貫通させ、指定したエンコーダ(既定 `h264_videotoolbox`、Windows 検証では
`h264_mf` / `h264_amf`)で reframe が成立するかを確認します。

## 使い方

```sh
cargo build
./target/debug/reframe <input> <output> <blur-pad|crop-cover> <target_w> <target_h> [encoder]
```

例(mac, 既定エンコーダ):

```sh
./target/debug/reframe input.mp4 out.mp4 blur-pad 1080 1920
```

例(Windows, HW 検証):

```powershell
.\target\debug\reframe.exe input.mp4 out.mp4 blur-pad 1080 1920 h264_mf
```

エンコーダが対応するピクセルフォーマットを自動判定し(hwaccel サーフェス形式は除外)、
フィルタグラフの `format=` とエンコーダの `set_format` を一致させます。詳細は
`docs/phase2-0-windows-setup.md` を参照してください。
