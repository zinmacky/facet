import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Clip } from "../../types";
import { masterSpec } from "../../types";
import type { ExportEvent, ProbeResult } from "../../lib/api";
import {
  downloadZip,
  fileDownloadUrl,
  fileRawUrl,
  postExport,
  subscribeExport,
} from "../../lib/api";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { cn } from "../../components/ui/cn";

interface ExportModalProps {
  open: boolean;
  source: { inputPath: string; probe: ProbeResult } | null;
  clips: Clip[];
  onClose: () => void;
  onProceedToUpload: () => void;
}

/** clip 単位の書き出し進捗・結果。 */
interface TaskState {
  status: "running" | "done" | "error";
  ratio: number;
  fps?: number;
  outputPath?: string;
  error?: string;
}

/**
 * EXPORT モーダル: 各 clip のマスター(クロップ内容そのもの)を書き出す。
 * open が true でソースがあるとき、まだ done でない clip をレンダリング開始する。
 * 再オープンでは既存の done 結果を保持して再レンダしない。
 */
export function ExportModal({ open, source, clips, onClose, onProceedToUpload }: ExportModalProps) {
  const [results, setResults] = useState<Map<string, TaskState>>(new Map());

  // 結果を effect から参照するためのミラー(再購読トリガにしないため ref で持つ)。
  const resultsRef = useRef<Map<string, TaskState>>(results);
  resultsRef.current = results;

  // clipId ごとの購読解除関数。
  const unsubsRef = useRef<Map<string, () => void>>(new Map());

  // clips の入れ替え時は古い結果・購読を破棄する。
  useEffect(() => {
    for (const unsub of unsubsRef.current.values()) unsub();
    unsubsRef.current.clear();
    resultsRef.current = new Map();
    setResults(new Map());
  }, [clips]);

  // レンダリング開始。open かつ source があり、done 結果を持たない clip のみ対象。
  useEffect(() => {
    if (!open || !source) return;
    const probe = source.probe;
    const input = source.inputPath;

    for (const clip of clips) {
      const existing = resultsRef.current.get(clip.id);
      if (existing && existing.status === "done") continue;
      if (unsubsRef.current.has(clip.id)) continue; // 実行中は二重起動しない

      // running としてマーク(仮の unsubscribe を先に登録し二重起動を防ぐ)。
      unsubsRef.current.set(clip.id, () => {});
      setResults((prev) => {
        const next = new Map(prev);
        next.set(clip.id, { status: "running", ratio: 0 });
        return next;
      });

      const spec = masterSpec(clip, { width: probe.width, height: probe.height });
      const output = `${clip.name}.mp4`;

      const update = (patch: Partial<TaskState>) => {
        setResults((prev) => {
          const next = new Map(prev);
          const cur = next.get(clip.id) ?? { status: "running", ratio: 0 };
          next.set(clip.id, { ...cur, ...patch });
          return next;
        });
      };

      const onEvent = (event: ExportEvent) => {
        if (event.type === "progress") {
          update({ status: "running", ratio: event.ratio, ...(event.fps !== undefined ? { fps: event.fps } : {}) });
        } else if (event.type === "done") {
          update({ status: "done", ratio: 1, outputPath: event.outputPath });
        } else {
          update({ status: "error", error: event.message });
        }
      };

      void postExport({ spec, input, output })
        .then(({ jobId }) => {
          const unsub = subscribeExport(jobId, {
            onEvent,
            onError: () => update({ status: "error", error: "進捗の購読に失敗しました。" }),
          });
          unsubsRef.current.set(clip.id, unsub);
        })
        .catch((err: unknown) => {
          unsubsRef.current.delete(clip.id);
          update({ status: "error", error: err instanceof Error ? err.message : String(err) });
        });
    }
  }, [open, source, clips]);

  // アンマウント時に全購読を解除。
  useEffect(() => {
    const unsubs = unsubsRef.current;
    return () => {
      for (const unsub of unsubs.values()) unsub();
      unsubs.clear();
    };
  }, []);

  const donePaths = useMemo(() => {
    const paths: string[] = [];
    for (const clip of clips) {
      const task = results.get(clip.id);
      if (task?.status === "done" && task.outputPath) paths.push(task.outputPath);
    }
    return paths;
  }, [clips, results]);

  const zipMutation = useMutation({
    mutationFn: () => downloadZip(donePaths, "reframe-export.zip"),
  });

  return (
    <Modal open={open} title="書き出し(クロップ内容)" onClose={onClose} widthClass="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            閉じる
          </Button>
          <Button variant="primary" disabled={clips.length === 0} onClick={onProceedToUpload}>
            アップロードへ進む
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={donePaths.length === 0 || zipMutation.status === "pending"}
            onClick={() => zipMutation.mutate()}
          >
            {zipMutation.status === "pending" ? "圧縮中…" : "一括ダウンロード(ZIP)"}
          </Button>
          {zipMutation.isError && (
            <span className="text-xs text-danger">
              ZIP 失敗: {(zipMutation.error as Error).message}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {clips.map((clip) => (
            <ExportCard key={clip.id} clip={clip} task={results.get(clip.id)} />
          ))}
          {clips.length === 0 && (
            <p className="text-sm text-neutral-500">書き出す切り抜きがありません。</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** clip 1 本ぶんの書き出しカード。 */
function ExportCard({ clip, task }: { clip: Clip; task: TaskState | undefined }) {
  const status = task?.status ?? "running";
  const ratio = task?.ratio ?? 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-elevated p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs text-neutral-200">{clip.name}.mp4</span>
        <span
          className={cn(
            "shrink-0 text-[11px]",
            status === "done" && "text-accent",
            status === "error" && "text-danger",
            status === "running" && "text-neutral-500",
          )}
        >
          {status === "done" ? "完了" : status === "error" ? "エラー" : `${Math.round(ratio * 100)}%`}
          {status === "running" && task?.fps !== undefined ? ` · ${Math.round(task.fps)}fps` : ""}
        </span>
      </div>

      {/* 進捗バー */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel">
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            status === "error" ? "bg-danger" : "bg-accent",
          )}
          style={{ width: `${Math.round((status === "done" ? 1 : ratio) * 100)}%` }}
        />
      </div>

      {status === "done" && task?.outputPath && (
        <>
          <video
            controls
            src={fileRawUrl(task.outputPath)}
            className="max-h-48 w-full rounded bg-black"
          />
          <a
            href={fileDownloadUrl(task.outputPath)}
            download
            className="inline-flex h-7 items-center justify-center rounded-md bg-elevated px-2.5 text-xs font-medium text-neutral-200 hover:bg-line"
          >
            ダウンロード
          </a>
        </>
      )}

      {status === "error" && (
        <p className="text-xs text-danger">{task?.error ?? "書き出しに失敗しました。"}</p>
      )}
    </div>
  );
}
