# tests/fixtures

`probe.rs` の `probe_blocking_reads_real_file` テスト用の小さな検証用 mp4。

以前は開発機固有の scratchpad パス(`C:\Users\...\scratchpad\input_test_5s.mp4`)に
フォールバックしていたが、リポジトリに入っていないため他の開発機/CI では常に
skip されていた。本ディレクトリの `input_test.mp4` はリポジトリにコミットされた
fixture で、`CARGO_MANIFEST_DIR`(= `apps/desktop/src-tauri`)相対で参照する。

## input_test.mp4

- 2 秒、320x240、25fps、libx264 (yuv420p) + AAC モノラル 64kbps の合成映像。
- サイズ約 40KB。
- 生成コマンド(`FFMPEG_DIR`/`PATH` に ffmpeg/ffprobe が通った状態で実行):

```sh
ffmpeg -y \
  -f lavfi -i "testsrc=size=320x240:rate=25:duration=2" \
  -f lavfi -i "sine=frequency=1000:duration=2" \
  -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p \
  -c:a aac -b:a 64k \
  -shortest -movflags +faststart \
  apps/desktop/src-tauri/tests/fixtures/input_test.mp4
```

`FACET_DESKTOP_TEST_FIXTURE_MP4` 環境変数でこの fixture の代わりに任意の mp4 パスを
指定できる(より大きい・実映像に近いファイルで手動検証したい場合等)。
