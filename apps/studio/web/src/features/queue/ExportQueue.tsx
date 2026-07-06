import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { EditSpec } from "@reframe/core";
import type { JobCreateResponse } from "@reframe/contract";
import {
  postExport,
  subscribeExport,
  publishYoutube,
  publishInstagram,
  type ExportEvent,
} from "../../lib/api";
import type { Clip, VariantKind } from "../../types";
import { presetForVariant, variantLabel, variantSuffix } from "../../types";
import { Button } from "../../components/ui/Button";
import { cn } from "../../components/ui/cn";

interface ExportQueueProps {
  clips: Clip[];
  inputPath: string;
  sourceReady: boolean;
  /** 元動画の実ピクセル寸法(EditSpec.source)。未取得時は null。 */
  source: { width: number; height: number } | null;
}

/** clip × バリアントに展開した 1 書き出し単位。 */
interface RenderTask {
  id: string;
  clipId: string;
  clipName: string;
  variant: VariantKind;
  spec: EditSpec;
  output: string;
  /** 書き出しメタ由来(YouTube タイトル/説明・IG キャプション)。 */
  youtube: { title: string; description: string };
  instagram: { caption: string };
}

/** 各タスクの実行状態。SSE 進捗をここへ集約する。 */
interface TaskState {
  status: "running" | "done" | "error";
  ratio: number;
  fps?: number;
  outputPath?: string;
  error?: string;
}

/**
 * clip × 有効バリアントを RenderTask に展開して一括書き出しし、
 * 完了した task ごとに公開ボタンを出すキュー。
 * SSE 購読は unsubs Map で保持し、アンマウント時に全解除する。
 */
export function ExportQueue({
  clips,
  inputPath,
  sourceReady,
  source,
}: ExportQueueProps) {
  const [tasks, setTasks] = useState<RenderTask[]>([]);
  const [states, setStates] = useState<Map<string, TaskState>>(new Map());
  // taskId → unsubscribe 関数。
  const unsubsRef = useRef<Map<string, () => void>>(new Map());

  // アンマウント時に全購読を閉じる。
  useEffect(
    () => () => {
      for (const unsub of unsubsRef.current.values()) unsub();
      unsubsRef.current.clear();
    },
    [],
  );

  const updateState = useCallback(
    (taskId: string, patch: Partial<TaskState>) => {
      setStates((prev) => {
        const next = new Map(prev);
        const base = next.get(taskId) ?? { status: "running", ratio: 0 };
        next.set(taskId, { ...base, ...patch });
        return next;
      });
    },
    [],
  );

  const handleEvent = useCallback(
    (taskId: string, ev: ExportEvent) => {
      switch (ev.type) {
        case "progress":
          updateState(taskId, { status: "running", ratio: ev.ratio, fps: ev.fps });
          break;
        case "done":
          updateState(taskId, {
            status: "done",
            ratio: 1,
            outputPath: ev.outputPath,
          });
          break;
        case "error":
          updateState(taskId, { status: "error", error: ev.message });
          break;
      }
    },
    [updateState],
  );

  // 全 clip × 有効バリアントを展開して書き出し起動する。
  const exportAll = useMutation({
    mutationFn: async () => {
      if (!source) throw new Error("元動画が未選択です");
      const built = buildTasks(clips, source);
      // 既存購読を閉じてからやり直す。
      for (const unsub of unsubsRef.current.values()) unsub();
      unsubsRef.current.clear();
      setTasks(built);
      setStates(new Map());

      for (const task of built) {
        try {
          const { jobId } = await postExport({
            spec: task.spec,
            input: inputPath,
            output: task.output,
          });
          updateState(task.id, { status: "running", ratio: 0 });
          const unsub = subscribeExport(jobId, {
            onEvent: (ev) => handleEvent(task.id, ev),
            onError: () =>
              updateState(task.id, {
                status: "error",
                error: "接続が切断されました",
              }),
          });
          unsubsRef.current.set(task.id, unsub);
        } catch (err) {
          updateState(task.id, {
            status: "error",
            error: err instanceof Error ? err.message : "起動に失敗しました",
          });
        }
      }
    },
  });

  const activeClipCount = clips.filter(
    (c) => c.variants.short || c.variants.insta,
  ).length;
  const canExport =
    sourceReady && activeClipCount > 0 && exportAll.status !== "pending";

  return (
    <div className="flex flex-col gap-4 p-3">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Export
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={!canExport}
            onClick={() => exportAll.mutate()}
          >
            {exportAll.status === "pending" ? "起動中…" : "すべて書き出し"}
          </Button>
        </div>

        {exportAll.isError && (
          <p className="text-xs text-danger">
            {(exportAll.error as Error).message}
          </p>
        )}

        {tasks.length === 0 && (
          <p className="text-xs text-neutral-600">
            {sourceReady
              ? "切り抜きを追加して書き出してください。"
              : "先に元動画を選択してください。"}
          </p>
        )}
      </section>

      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          state={states.get(task.id)}
        />
      ))}
    </div>
  );
}

/** clips を RenderTask 配列へ展開する(有効バリアントのみ)。 */
function buildTasks(
  clips: Clip[],
  source: { width: number; height: number },
): RenderTask[] {
  const tasks: RenderTask[] = [];
  const kinds: VariantKind[] = ["short", "insta"];
  for (const clip of clips) {
    for (const variant of kinds) {
      if (!clip.variants[variant]) continue;
      const spec: EditSpec = {
        source: { width: source.width, height: source.height },
        trim: clip.trim,
        ...(clip.crop ? { crop: clip.crop } : {}),
        preset: presetForVariant(variant),
      };
      tasks.push({
        id: crypto.randomUUID(),
        clipId: clip.id,
        clipName: clip.name,
        variant,
        spec,
        output: `${clip.name}_${variantSuffix(variant)}.mp4`,
        youtube: clip.youtube,
        instagram: clip.instagram,
      });
    }
  }
  return tasks;
}

// ---- タスク行(進捗 + 公開) -----------------------------------------------

function TaskRow({ task, state }: { task: RenderTask; state?: TaskState }) {
  const pct = Math.round((state?.ratio ?? 0) * 100);
  const status = state?.status ?? "running";

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-2.5">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate font-mono text-neutral-300">
          {task.clipName}
          <span className="ml-1.5 text-neutral-500">
            {variantLabel(task.variant)}
          </span>
        </span>
        <span
          className={cn(
            "font-medium",
            status === "error"
              ? "text-danger"
              : status === "done"
                ? "text-ok"
                : "text-neutral-400",
          )}
        >
          {status === "error"
            ? "失敗"
            : status === "done"
              ? "完了"
              : `${pct}%`}
          {state?.fps ? ` · ${Math.round(state.fps)}fps` : ""}
        </span>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200",
            status === "error" ? "bg-danger" : status === "done" ? "bg-ok" : "bg-accent",
          )}
          style={{ width: `${status === "error" ? 100 : pct}%` }}
        />
      </div>

      {state?.error && <p className="text-xs text-danger">{state.error}</p>}

      {status === "done" && state?.outputPath && (
        <>
          <p className="truncate font-mono text-[11px] text-neutral-500">
            {state.outputPath}
          </p>
          {task.variant === "short" ? (
            <YoutubePublish task={task} outputPath={state.outputPath} />
          ) : (
            <InstagramPublish task={task} outputPath={state.outputPath} />
          )}
        </>
      )}
    </div>
  );
}

// ---- YouTube 公開 ----------------------------------------------------------

function YoutubePublish({
  task,
  outputPath,
}: {
  task: RenderTask;
  outputPath: string;
}) {
  const [scheduled, setScheduled] = useState(false);
  const [publishAt, setPublishAt] = useState<string>("");

  const mutation = useMutation({
    mutationFn: () =>
      publishYoutube({
        outputPath,
        title: task.youtube.title || task.clipName,
        description: task.youtube.description,
        publishAt:
          scheduled && publishAt ? new Date(publishAt).getTime() : undefined,
        privacyStatus: scheduled ? "private" : "public",
      }),
  });

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-elevated p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-300">YouTube</span>
        <StatusBadge
          state={mutation.status}
          okLabel={mutation.data ? `ID ${mutation.data.videoId}` : "OK"}
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-neutral-400">
        <input
          type="checkbox"
          checked={scheduled}
          onChange={(e) => setScheduled(e.target.checked)}
          className="accent-accent"
        />
        予約投稿(private で登録)
      </label>
      {scheduled && (
        <input
          type="datetime-local"
          value={publishAt}
          onChange={(e) => setPublishAt(e.target.value)}
          className="rounded border border-line bg-panel px-2 py-1 text-xs text-neutral-200 outline-none focus:border-accent"
        />
      )}
      <Button
        size="sm"
        onClick={() => mutation.mutate()}
        disabled={mutation.status === "pending"}
      >
        {mutation.status === "pending" ? "送信中…" : "YouTube へ投稿"}
      </Button>
      {mutation.isError && (
        <p className="text-xs text-danger">{(mutation.error as Error).message}</p>
      )}
    </div>
  );
}

// ---- Instagram 公開 --------------------------------------------------------

function InstagramPublish({
  task,
  outputPath,
}: {
  task: RenderTask;
  outputPath: string;
}) {
  const [publishAt, setPublishAt] = useState<string>("");

  const mutation = useMutation<JobCreateResponse, Error>({
    mutationFn: () => {
      // scheduler は publishAt 必須。未指定なら 5 分後を既定にする。
      const at = publishAt
        ? new Date(publishAt).getTime()
        : Date.now() + 5 * 60_000;
      return publishInstagram({
        outputPath,
        mediaType: "VIDEO",
        caption: task.instagram.caption,
        publishAt: at,
      });
    },
  });

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-elevated p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-300">Instagram</span>
        <StatusBadge
          state={mutation.status}
          okLabel={mutation.data ? mutation.data.status : "予約済み"}
        />
      </div>
      <input
        type="datetime-local"
        value={publishAt}
        onChange={(e) => setPublishAt(e.target.value)}
        className="rounded border border-line bg-panel px-2 py-1 text-xs text-neutral-200 outline-none focus:border-accent"
      />
      <Button
        size="sm"
        onClick={() => mutation.mutate()}
        disabled={mutation.status === "pending"}
      >
        {mutation.status === "pending" ? "登録中…" : "scheduler へ予約"}
      </Button>
      {mutation.isError && (
        <p className="text-xs text-danger">{mutation.error.message}</p>
      )}
    </div>
  );
}

// ---- 共通ステータスバッジ --------------------------------------------------

function StatusBadge({
  state,
  okLabel,
}: {
  state: "idle" | "pending" | "success" | "error";
  okLabel: string;
}) {
  if (state === "idle") return null;
  const map = {
    pending: { text: "処理中", cls: "bg-accent/15 text-accent" },
    success: { text: okLabel, cls: "bg-ok/15 text-ok" },
    error: { text: "失敗", cls: "bg-danger/15 text-danger" },
  } as const;
  const s = map[state];
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", s.cls)}>
      {s.text}
    </span>
  );
}
