import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { pickFile, probeFile, type ProbeResult } from "./lib/api";
import { formatTime } from "./lib/format";
import type { Clip } from "./types";
import { sourceBaseName } from "./types";
import { ClipList } from "./features/clips/ClipList";
import { ClipEditor } from "./features/clips/ClipEditor";
import { ExportQueue } from "./features/queue/ExportQueue";
import { Card } from "./components/ui/Card";
import { Button } from "./components/ui/Button";

/** 選択済みソース(実パス + probe 結果)。 */
interface Source {
  inputPath: string;
  probe: ProbeResult;
}

/**
 * アプリの状態オーナー。
 * ネイティブダイアログで元動画を選び、複数の Clip を作って編集・書き出しする。
 * 各機能コンポーネントには表示に必要な値と onChange だけを配る。
 */
export function App() {
  const [source, setSource] = useState<Source | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  // ファイル選択 → probe。キャンセル時は何もしない。
  const pickMutation = useMutation({
    mutationFn: async (): Promise<Source | null> => {
      const picked = await pickFile();
      if (picked.canceled || !picked.path) return null;
      const probe = await probeFile(picked.path);
      return { inputPath: picked.path, probe };
    },
    onSuccess: (result) => {
      if (!result) return;
      // 新しいソースを選んだら clips をリセットする。
      setSource(result);
      setClips([]);
      setSelectedClipId(null);
    },
  });

  const addClip = useCallback(() => {
    if (!source) return;
    const base = sourceBaseName(source.inputPath);
    setClips((prev) => {
      const clip: Clip = {
        id: crypto.randomUUID(),
        name: `${base}_${prev.length + 1}`,
        trim: { start: 0, end: source.probe.duration },
        variants: { short: true, insta: false },
        youtube: { title: "", description: "" },
        instagram: { caption: "" },
      };
      setSelectedClipId(clip.id);
      return [...prev, clip];
    });
  }, [source]);

  const removeClip = useCallback(
    (id: string) => {
      setClips((prev) => {
        const next = prev.filter((c) => c.id !== id);
        setSelectedClipId((sel) =>
          sel === id ? (next[0]?.id ?? null) : sel,
        );
        return next;
      });
    },
    [],
  );

  const changeClip = useCallback((clip: Clip) => {
    setClips((prev) => prev.map((c) => (c.id === clip.id ? clip : c)));
  }, []);

  const selectedClip = clips.find((c) => c.id === selectedClipId);

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

        <Button
          size="sm"
          variant="primary"
          disabled={pickMutation.status === "pending"}
          onClick={() => pickMutation.mutate()}
        >
          {pickMutation.status === "pending" ? "読み込み中…" : "元動画を選択"}
        </Button>

        {source && (
          <span className="truncate font-mono text-[11px] text-neutral-400">
            {sourceBaseName(source.inputPath)}
          </span>
        )}

        <div className="flex-1" />

        {source && (
          <span className="font-mono text-[11px] text-neutral-500">
            {source.probe.width}×{source.probe.height} ·{" "}
            {formatTime(source.probe.duration)}
            {source.probe.codec ? ` · ${source.probe.codec}` : ""}
          </span>
        )}
      </header>

      {pickMutation.isError && (
        <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
          読み込み失敗: {(pickMutation.error as Error).message}
        </div>
      )}

      {/* メイン: 左(選択中 Clip 編集) / 右(Clip 一覧 + 書き出し) */}
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_340px]">
        {/* 左カラム(min-w-0: grid 子の min-width:auto を無効化しはみ出しを防ぐ) */}
        <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto p-3">
          {!source ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-neutral-700 text-neutral-600">
              <div className="h-10 w-10 rounded-md border-2 border-dashed border-neutral-700" />
              <p className="text-sm">元動画を選択してください。</p>
            </div>
          ) : selectedClip ? (
            <ClipEditor
              clip={selectedClip}
              probe={source.probe}
              onChange={changeClip}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-neutral-700 text-neutral-600">
              <p className="text-sm">
                右のパネルから切り抜きを追加してください。
              </p>
            </div>
          )}
        </div>

        {/* 右カラム */}
        <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-line p-3">
          <Card title="Clips">
            <ClipList
              clips={clips}
              selectedClipId={selectedClipId}
              onSelect={setSelectedClipId}
              onAdd={addClip}
              onRemove={removeClip}
              onChange={changeClip}
            />
          </Card>
          <Card title="Export">
            <ExportQueue
              clips={clips}
              inputPath={source?.inputPath ?? ""}
              sourceReady={source !== null}
              source={
                source
                  ? { width: source.probe.width, height: source.probe.height }
                  : null
              }
            />
          </Card>
        </aside>
      </div>
    </div>
  );
}
