import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { EditSpec } from "@reframe/core";
import {
  postExport,
  subscribeExport,
  publishYoutube,
  publishInstagram,
  type ExportEvent,
} from "../../lib/api";
import type { Clip, VariantKind } from "../../types";
import { presetForVariant, variantLabel, variantSuffix } from "../../types";
import {
  generateSchedule,
  msToLocalInput,
  localInputToMs,
  WEEKDAY_LABELS,
} from "../../lib/schedule";
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
  youtube: { title: string; description: string };
  instagram: { caption: string };
}

/** 各タスクの書き出し状態。SSE 進捗をここへ集約する。 */
interface TaskState {
  status: "running" | "done" | "error";
  ratio: number;
  fps?: number;
  outputPath?: string;
  error?: string;
}

/** 公開処理の状態。 */
type PubStatus = "idle" | "pending" | "success" | "error";
interface PubState {
  status: PubStatus;
  message?: string;
}

/** /files 経由の配信 URL。dev proxy で server(:5178)へ渡る。 */
function rawUrl(path: string): string {
  return `/files/raw?path=${encodeURIComponent(path)}`;
}
function downloadUrl(path: string): string {
  return `${rawUrl(path)}&download=1`;
}

/**
 * clip × 有効バリアントを RenderTask に展開して一括書き出しし、
 * 並び替え・予約日時の一括割り当て・公開までを担うキュー。
 */
export function ExportQueue({ clips, inputPath, sourceReady, source }: ExportQueueProps) {
  const [tasks, setTasks] = useState<RenderTask[]>([]);
  const [states, setStates] = useState<Map<string, TaskState>>(new Map());
  // taskId → 予約公開時刻(unix ms)。一括割り当て/個別編集で更新。
  const [assignedAt, setAssignedAt] = useState<Map<string, number>>(new Map());
  const [pubStates, setPubStates] = useState<Map<string, PubState>>(new Map());
  const unsubsRef = useRef<Map<string, () => void>>(new Map());

  // 一括スケジュールのフォーム状態。
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [times, setTimes] = useState<string[]>(["20:00"]);
  const [scheduleInfo, setScheduleInfo] = useState<string | null>(null);

  useEffect(
    () => () => {
      for (const unsub of unsubsRef.current.values()) unsub();
      unsubsRef.current.clear();
    },
    [],
  );

  const updateState = useCallback((taskId: string, patch: Partial<TaskState>) => {
    setStates((prev) => {
      const next = new Map(prev);
      const base = next.get(taskId) ?? { status: "running" as const, ratio: 0 };
      next.set(taskId, { ...base, ...patch });
      return next;
    });
  }, []);

  const setPub = useCallback((taskId: string, patch: PubState) => {
    setPubStates((prev) => new Map(prev).set(taskId, patch));
  }, []);

  const handleEvent = useCallback(
    (taskId: string, ev: ExportEvent) => {
      switch (ev.type) {
        case "progress":
          updateState(taskId, { status: "running", ratio: ev.ratio, fps: ev.fps });
          break;
        case "done":
          updateState(taskId, { status: "done", ratio: 1, outputPath: ev.outputPath });
          break;
        case "error":
          updateState(taskId, { status: "error", error: ev.message });
          break;
      }
    },
    [updateState],
  );

  const exportAll = useMutation({
    mutationFn: async () => {
      if (!source) throw new Error("元動画が未選択です");
      const built = buildTasks(clips, source);
      for (const unsub of unsubsRef.current.values()) unsub();
      unsubsRef.current.clear();
      setTasks(built);
      setStates(new Map());
      setAssignedAt(new Map());
      setPubStates(new Map());
      setScheduleInfo(null);

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
            onError: () => updateState(task.id, { status: "error", error: "接続が切断されました" }),
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

  // 並び替え(1 つ上/下へ)。予約は taskId 紐付けなので順序変更に追従する。
  const moveTask = useCallback((index: number, dir: -1 | 1) => {
    setTasks((prev) => {
      const j = index + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const a = next[index];
      const b = next[j];
      if (!a || !b) return prev;
      next[index] = b;
      next[j] = a;
      return next;
    });
  }, []);

  // 一括割り当て: 現在の並び順で、生成した日時を上から昇順に入れる。
  const applySchedule = useCallback(() => {
    const slots = generateSchedule({ startDate, endDate, weekdays, times });
    const m = new Map<string, number>();
    tasks.forEach((t, i) => {
      const slot = slots[i];
      if (slot !== undefined) m.set(t.id, slot);
    });
    setAssignedAt(m);
    setScheduleInfo(
      slots.length === 0
        ? "条件に合う日時がありません(期間・曜日・時刻を確認してください)。"
        : `${Math.min(slots.length, tasks.length)} 件へ割り当て` +
            (slots.length < tasks.length
              ? `(枠不足: ${tasks.length - slots.length} 件が未割り当て)`
              : slots.length > tasks.length
                ? `(余り枠 ${slots.length - tasks.length} 件)`
                : ""),
    );
  }, [startDate, endDate, weekdays, times, tasks]);

  const setAssignedFor = useCallback((taskId: string, ms: number | undefined) => {
    setAssignedAt((prev) => {
      const next = new Map(prev);
      if (ms === undefined) next.delete(taskId);
      else next.set(taskId, ms);
      return next;
    });
  }, []);

  // 公開(1 件)。variant で YouTube / Instagram を振り分ける。予約時刻は assignedAt。
  const publishOne = useCallback(
    async (task: RenderTask) => {
      const st = states.get(task.id);
      if (st?.status !== "done" || !st.outputPath) return;
      const at = assignedAt.get(task.id);
      setPub(task.id, { status: "pending" });
      try {
        if (task.variant === "short") {
          const r = await publishYoutube({
            outputPath: st.outputPath,
            title: task.youtube.title || task.clipName,
            description: task.youtube.description,
            ...(at !== undefined ? { publishAt: at } : {}),
            privacyStatus: at !== undefined ? "private" : "public",
          });
          setPub(task.id, { status: "success", message: `YouTube ID ${r.videoId}` });
        } else {
          const r = await publishInstagram({
            outputPath: st.outputPath,
            mediaType: "VIDEO",
            caption: task.instagram.caption,
            publishAt: at ?? Date.now() + 5 * 60_000,
          });
          setPub(task.id, { status: "success", message: `予約 ${r.status}` });
        }
      } catch (err) {
        setPub(task.id, {
          status: "error",
          message: err instanceof Error ? err.message : "公開に失敗しました",
        });
      }
    },
    [states, assignedAt, setPub],
  );

  // 割り当てた予約で、完了済みの全タスクを順に投稿する。
  const publishAll = useMutation({
    mutationFn: async () => {
      for (const task of tasks) {
        const st = states.get(task.id);
        if (st?.status === "done" && st.outputPath) {
          await publishOne(task);
        }
      }
    },
  });

  const activeClipCount = clips.filter((c) => c.variants.short || c.variants.insta).length;
  const canExport = sourceReady && activeClipCount > 0 && exportAll.status !== "pending";
  const doneCount = tasks.filter((t) => states.get(t.id)?.status === "done").length;

  const toggleWeekday = (d: number) =>
    setWeekdays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));

  return (
    <div className="flex flex-col gap-4 p-3">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Export
          </span>
          <Button size="sm" variant="primary" disabled={!canExport} onClick={() => exportAll.mutate()}>
            {exportAll.status === "pending" ? "起動中…" : "すべて書き出し"}
          </Button>
        </div>

        {exportAll.isError && (
          <p className="text-xs text-danger">{(exportAll.error as Error).message}</p>
        )}

        {tasks.length === 0 && (
          <p className="text-xs text-neutral-600">
            {sourceReady ? "切り抜きを追加して書き出してください。" : "先に元動画を選択してください。"}
          </p>
        )}
      </section>

      {/* 一括予約スケジュール */}
      {tasks.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border border-line bg-surface p-2.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            予約の一括設定
          </span>

          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <label className="flex items-center gap-1">
              開始
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="rounded border border-line bg-panel px-1.5 py-1 text-neutral-200 outline-none focus:border-accent"
              />
            </label>
            <label className="flex items-center gap-1">
              終了
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="rounded border border-line bg-panel px-1.5 py-1 text-neutral-200 outline-none focus:border-accent"
              />
            </label>
          </div>

          {/* 曜日 */}
          <div className="flex items-center gap-1">
            {WEEKDAY_LABELS.map((label, d) => (
              <button
                key={d}
                type="button"
                onClick={() => toggleWeekday(d)}
                className={cn(
                  "h-6 w-6 rounded text-[11px] font-medium",
                  weekdays.includes(d)
                    ? "bg-accent text-white"
                    : "border border-line bg-panel text-neutral-400 hover:border-accent",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 時刻(複数可) */}
          <div className="flex flex-wrap items-center gap-1.5">
            {times.map((t, i) => (
              <div key={i} className="flex items-center gap-0.5">
                <input
                  type="time"
                  value={t}
                  onChange={(e) =>
                    setTimes((prev) => prev.map((x, xi) => (xi === i ? e.target.value : x)))
                  }
                  className="rounded border border-line bg-panel px-1.5 py-1 text-xs text-neutral-200 outline-none focus:border-accent"
                />
                {times.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setTimes((prev) => prev.filter((_, xi) => xi !== i))}
                    className="px-1 text-neutral-500 hover:text-danger"
                    aria-label="時刻を削除"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setTimes((prev) => [...prev, "12:00"])}
              className="rounded border border-line px-1.5 py-1 text-xs text-neutral-400 hover:border-accent"
            >
              + 時刻
            </button>
          </div>

          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="secondary" onClick={applySchedule}>
              この順で予約日時を割り当て
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={doneCount === 0 || publishAll.status === "pending"}
              onClick={() => publishAll.mutate()}
            >
              {publishAll.status === "pending" ? "投稿中…" : "予約で一括投稿"}
            </Button>
          </div>
          {scheduleInfo && <p className="text-[11px] text-neutral-500">{scheduleInfo}</p>}
        </section>
      )}

      {tasks.map((task, index) => (
        <TaskRow
          key={task.id}
          task={task}
          index={index}
          total={tasks.length}
          state={states.get(task.id)}
          assignedMs={assignedAt.get(task.id)}
          pub={pubStates.get(task.id)}
          onMove={moveTask}
          onAssign={setAssignedFor}
          onPublish={publishOne}
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

// ---- タスク行 --------------------------------------------------------------

function TaskRow({
  task,
  index,
  total,
  state,
  assignedMs,
  pub,
  onMove,
  onAssign,
  onPublish,
}: {
  task: RenderTask;
  index: number;
  total: number;
  state?: TaskState;
  assignedMs?: number;
  pub?: PubState;
  onMove: (index: number, dir: -1 | 1) => void;
  onAssign: (taskId: string, ms: number | undefined) => void;
  onPublish: (task: RenderTask) => void;
}) {
  const pct = Math.round((state?.ratio ?? 0) * 100);
  const status = state?.status ?? "running";
  const done = status === "done" && state?.outputPath;
  const platform = task.variant === "short" ? "YouTube" : "Instagram";

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-2.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* 並び替え */}
          <div className="flex flex-col">
            <button
              type="button"
              disabled={index === 0}
              onClick={() => onMove(index, -1)}
              className="text-neutral-500 hover:text-accent disabled:opacity-30"
              aria-label="上へ"
            >
              ▲
            </button>
            <button
              type="button"
              disabled={index === total - 1}
              onClick={() => onMove(index, 1)}
              className="text-neutral-500 hover:text-accent disabled:opacity-30"
              aria-label="下へ"
            >
              ▼
            </button>
          </div>
          <span className="truncate font-mono text-neutral-300">
            {task.clipName}
            <span className="ml-1.5 text-neutral-500">{variantLabel(task.variant)}</span>
          </span>
        </div>
        <span
          className={cn(
            "shrink-0 font-medium",
            status === "error"
              ? "text-danger"
              : status === "done"
                ? "text-ok"
                : "text-neutral-400",
          )}
        >
          {status === "error" ? "失敗" : status === "done" ? "完了" : `${pct}%`}
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

      {done && state?.outputPath && (
        <>
          {/* プレビュー + ダウンロード */}
          <video
            src={rawUrl(state.outputPath)}
            controls
            className="max-h-40 w-full rounded bg-black"
          />
          <div className="flex items-center justify-between">
            <span className="truncate font-mono text-[11px] text-neutral-500">
              {task.output}
            </span>
            <a
              href={downloadUrl(state.outputPath)}
              download
              className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-neutral-300 hover:border-accent hover:text-accent"
            >
              ダウンロード
            </a>
          </div>

          {/* 公開 */}
          <div className="flex flex-col gap-2 rounded-md border border-line bg-elevated p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-300">{platform}</span>
              {pub && pub.status !== "idle" && (
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium",
                    pub.status === "pending"
                      ? "bg-accent/15 text-accent"
                      : pub.status === "success"
                        ? "bg-ok/15 text-ok"
                        : "bg-danger/15 text-danger",
                  )}
                >
                  {pub.status === "pending" ? "処理中" : pub.status === "success" ? pub.message : "失敗"}
                </span>
              )}
            </div>
            <label className="flex items-center gap-2 text-[11px] text-neutral-400">
              予約日時
              <input
                type="datetime-local"
                value={assignedMs !== undefined ? msToLocalInput(assignedMs) : ""}
                onChange={(e) => onAssign(task.id, localInputToMs(e.target.value) ?? undefined)}
                className="rounded border border-line bg-panel px-2 py-1 text-neutral-200 outline-none focus:border-accent"
              />
            </label>
            <p className="text-[10px] text-neutral-600">
              {task.variant === "short"
                ? assignedMs !== undefined
                  ? "予約投稿(private で登録)"
                  : "未指定なら即時公開(public)"
                : "Instagram は予約。未指定なら 5 分後。"}
            </p>
            <Button
              size="sm"
              onClick={() => onPublish(task)}
              disabled={pub?.status === "pending"}
            >
              {pub?.status === "pending" ? "送信中…" : `${platform} へ投稿`}
            </Button>
            {pub?.status === "error" && pub.message && (
              <p className="text-xs text-danger">{pub.message}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
