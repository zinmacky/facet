import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CropRect, EditSpec, Preset, Trim } from "@reframe/core";
import { PRESETS } from "@reframe/core";
import { probeFile, type ProbeResult } from "./lib/api";
import { formatTime } from "./lib/format";
import { Timeline } from "./features/timeline/Timeline";
import { CropOverlay } from "./features/crop-overlay/CropOverlay";
import { PresetPanel } from "./features/preset-panel/PresetPanel";
import { Queue } from "./features/queue/Queue";
import { Card } from "./components/ui/Card";
import { Button } from "./components/ui/Button";

/** クロップ全体を使う初期矩形。 */
const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * アプリの状態オーナー。
 * EditSpec(source 寸法・trim・crop・preset)をローカル state で保持し、
 * 各機能コンポーネントには表示に必要な値と onChange だけを配る。
 */
export function App() {
  const [path, setPath] = useState("");
  const [inputPath, setInputPath] = useState("");
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  // EditSpec の構成要素を個別に持つ(source は probe 由来)。
  const [trim, setTrim] = useState<Trim | undefined>(undefined);
  const [crop, setCrop] = useState<CropRect>(FULL_CROP);
  const [preset, setPreset] = useState<Preset>(PRESETS["9:16"]);
  const [snapCrop, setSnapCrop] = useState(true);

  // <video> 再生位置。
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);

  const probeMutation = useMutation({
    mutationFn: (p: string) => probeFile(p),
    onSuccess: (result, variables) => {
      setProbe(result);
      // 書き出し・公開でソース参照するため、probe に渡した実パスを保持する。
      setInputPath(variables);
      setTrim({ start: 0, end: result.duration });
      setCrop(FULL_CROP);
      setCurrentTime(0);
    },
  });

  // EditSpec を派生。source が無ければ null(書き出し不可)。
  const spec: EditSpec | null = useMemo(() => {
    if (!probe) return null;
    const s: EditSpec = {
      source: { width: probe.width, height: probe.height },
      preset,
    };
    if (trim) s.trim = trim;
    // 全体クロップは省略(core は無指定を全体として扱う)。
    if (crop.width < 1 || crop.height < 1 || crop.x > 0 || crop.y > 0) {
      s.crop = crop;
    }
    return s;
  }, [probe, preset, trim, crop]);

  const presetAspect = preset.width / preset.height;

  const onSeek = useCallback((seconds: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = seconds;
      setCurrentTime(seconds);
    }
  }, []);

  return (
    <div className="flex h-full flex-col bg-panel">
      {/* トップバー */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded-sm bg-accent" />
          <span className="text-sm font-semibold tracking-tight text-neutral-100">
            reframe <span className="text-neutral-500">studio</span>
          </span>
        </div>

        <div className="mx-2 h-5 w-px bg-line" />

        {/* ファイルパス入力 → probe */}
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) probeMutation.mutate(path.trim());
          }}
        >
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="ローカル動画のパス(例: /Users/me/clips/a.mp4)"
            className="h-8 flex-1 rounded-md border border-line bg-surface px-3 font-mono text-xs text-neutral-200 outline-none focus:border-accent"
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={!path.trim() || probeMutation.status === "pending"}
          >
            {probeMutation.status === "pending" ? "解析中…" : "読み込み"}
          </Button>
        </form>

        {probe && (
          <span className="font-mono text-[11px] text-neutral-500">
            {probe.width}×{probe.height} · {formatTime(probe.duration)}
            {probe.codec ? ` · ${probe.codec}` : ""}
          </span>
        )}
      </header>

      {probeMutation.isError && (
        <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
          probe 失敗: {(probeMutation.error as Error).message}
        </div>
      )}

      {/* メイン: 左(プレビュー+タイムライン) / 右(プリセット+キュー) */}
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px]">
        {/* 左カラム */}
        <div className="flex min-h-0 flex-col gap-3 p-3">
          {/* プレビュー */}
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-line bg-black/60">
            {probe ? (
              <div className="relative inline-block max-h-full max-w-full">
                <video
                  ref={videoRef}
                  src={probe.url}
                  controls
                  onTimeUpdate={(e) =>
                    setCurrentTime((e.target as HTMLVideoElement).currentTime)
                  }
                  className="block max-h-[60vh] max-w-full rounded"
                />
                <CropOverlay
                  crop={crop}
                  onChange={setCrop}
                  aspect={presetAspect}
                  snap={snapCrop}
                />
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-neutral-600">
                <div className="h-10 w-10 rounded-md border-2 border-dashed border-neutral-700" />
                <p className="text-xs">動画のパスを入力して読み込みます。</p>
              </div>
            )}
          </div>

          {/* クロップ操作の補助トグル */}
          <div className="flex items-center justify-end px-1">
            <label className="flex items-center gap-2 text-xs text-neutral-400">
              <input
                type="checkbox"
                checked={snapCrop}
                onChange={(e) => setSnapCrop(e.target.checked)}
                className="accent-accent"
              />
              クロップをプリセット比にスナップ
            </label>
          </div>

          {/* タイムライン */}
          <Card title="Timeline" className="shrink-0">
            <Timeline
              duration={probe?.duration ?? 0}
              trim={trim}
              currentTime={currentTime}
              onChange={setTrim}
              onSeek={onSeek}
            />
          </Card>
        </div>

        {/* 右カラム */}
        <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-line p-3">
          <Card title="Preset">
            <PresetPanel value={preset} onChange={setPreset} />
          </Card>
          <Card title="Queue">
            <Queue spec={spec} inputPath={inputPath} ready={probe !== null} />
          </Card>
        </aside>
      </div>
    </div>
  );
}
