import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { EditSpec } from "@reframe/core";
import type { JobCreateResponse, MediaType } from "@reframe/contract";
import {
  postExport,
  subscribeExport,
  publishYoutube,
  publishInstagram,
  type ExportEvent,
} from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { cn } from "../../components/ui/cn";

interface QueueProps {
  /** 書き出し対象の EditSpec。source 寸法が未取得なら書き出し不可。 */
  spec: EditSpec | null;
  /** 元動画の絶対パス(probe に渡したパス)。 */
  inputPath: string;
  /** ソース準備済みか(probe 済み)。 */
  ready: boolean;
}

/** 書き出しジョブのローカル状態。SSE 進捗をここに集約する。 */
interface ExportJob {
  jobId: string;
  status: "running" | "done" | "error";
  ratio: number;
  fps?: number;
  outputPath?: string;
  error?: string;
}

/**
 * 書き出し + 公開キュー。
 * - 書き出しは POST /export → EventSource で進捗購読。
 * - 公開は書き出し済み outputPath を対象に YouTube / Instagram の mutation を張る。
 * SSE の購読ライフサイクルはこのコンポーネントが管理する。
 */
export function Queue({ spec, inputPath, ready }: QueueProps) {
  const [job, setJob] = useState<ExportJob | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  // アンマウント時に購読を確実に閉じる。
  useEffect(() => () => unsubRef.current?.(), []);

  const handleExportEvent = useCallback((jobId: string, ev: ExportEvent) => {
    setJob((prev) => {
      const base: ExportJob = prev ?? { jobId, status: "running", ratio: 0 };
      switch (ev.type) {
        case "progress":
          return { ...base, status: "running", ratio: ev.ratio, fps: ev.fps };
        case "done":
          return { ...base, status: "done", ratio: 1, outputPath: ev.outputPath };
        case "error":
          return { ...base, status: "error", error: ev.message };
      }
    });
  }, []);

  const startExport = useMutation({
    mutationFn: async () => {
      if (!spec) throw new Error("EditSpec が未設定です");
      // 出力名はソース寸法とプリセットから素朴に決める(server 側で衝突回避想定)。
      const output = `export-${spec.preset.name.replace(":", "x")}-${Date.now()}.mp4`;
      return postExport({ spec, input: inputPath, output });
    },
    onSuccess: ({ jobId }) => {
      unsubRef.current?.();
      setJob({ jobId, status: "running", ratio: 0 });
      unsubRef.current = subscribeExport(jobId, {
        onEvent: (ev) => handleExportEvent(jobId, ev),
        onError: () =>
          setJob((prev) =>
            prev ? { ...prev, status: "error", error: "接続が切断されました" } : prev,
          ),
      });
    },
  });

  const canExport = ready && spec !== null && startExport.status !== "pending";
  const exportedPath = job?.status === "done" ? job.outputPath : undefined;

  return (
    <div className="flex flex-col gap-4 p-3">
      {/* 書き出し */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Export
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={!canExport}
            onClick={() => startExport.mutate()}
          >
            {startExport.status === "pending" ? "起動中…" : "書き出し"}
          </Button>
        </div>

        {startExport.isError && (
          <p className="text-xs text-danger">
            {(startExport.error as Error).message}
          </p>
        )}

        {job && <ExportProgress job={job} />}
        {!job && (
          <p className="text-xs text-neutral-600">
            {ready ? "書き出し待機中。" : "先にファイルを読み込んでください。"}
          </p>
        )}
      </section>

      <div className="h-px bg-line" />

      {/* 公開 */}
      <section className="flex flex-col gap-3">
        <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          Publish
        </span>
        {exportedPath ? (
          <>
            <YoutubePublish outputPath={exportedPath} />
            <InstagramPublish
              outputPath={exportedPath}
              defaultMediaType={spec?.preset.name === "9:16" ? "REELS" : "VIDEO"}
            />
          </>
        ) : (
          <p className="text-xs text-neutral-600">
            書き出しが完了すると公開できます。
          </p>
        )}
      </section>
    </div>
  );
}

// ---- 書き出し進捗 ----------------------------------------------------------

function ExportProgress({ job }: { job: ExportJob }) {
  const pct = Math.round(job.ratio * 100);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-elevated p-2.5">
      <div className="flex items-center justify-between text-xs">
        <span
          className={cn(
            "font-medium",
            job.status === "error"
              ? "text-danger"
              : job.status === "done"
                ? "text-ok"
                : "text-neutral-300",
          )}
        >
          {job.status === "error"
            ? "失敗"
            : job.status === "done"
              ? "完了"
              : "書き出し中"}
        </span>
        <span className="font-mono tabular-nums text-neutral-400">
          {job.status === "error" ? "" : `${pct}%`}
          {job.fps ? ` · ${Math.round(job.fps)}fps` : ""}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200",
            job.status === "error" ? "bg-danger" : "bg-accent",
          )}
          style={{ width: `${job.status === "error" ? 100 : pct}%` }}
        />
      </div>
      {job.error && <p className="text-xs text-danger">{job.error}</p>}
      {job.outputPath && (
        <p className="truncate font-mono text-[11px] text-neutral-500">
          {job.outputPath}
        </p>
      )}
    </div>
  );
}

// ---- YouTube ---------------------------------------------------------------

function YoutubePublish({ outputPath }: { outputPath: string }) {
  const [title, setTitle] = useState("");
  const [scheduled, setScheduled] = useState(false);
  const [publishAt, setPublishAt] = useState<string>("");

  const mutation = useMutation({
    mutationFn: () =>
      publishYoutube({
        outputPath,
        title: title.trim() || "reframe export",
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
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="タイトル"
        className="rounded border border-line bg-panel px-2 py-1 text-xs text-neutral-200 outline-none focus:border-accent"
      />
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

// ---- Instagram -------------------------------------------------------------

function InstagramPublish({
  outputPath,
  defaultMediaType,
}: {
  outputPath: string;
  defaultMediaType: MediaType;
}) {
  const [caption, setCaption] = useState("");
  const [mediaType, setMediaType] = useState<MediaType>(defaultMediaType);
  const [publishAt, setPublishAt] = useState<string>("");

  const mutation = useMutation<JobCreateResponse, Error>({
    mutationFn: () => {
      // scheduler は publishAt を必須とする。未指定なら 5 分後を既定にする。
      const at = publishAt
        ? new Date(publishAt).getTime()
        : Date.now() + 5 * 60_000;
      return publishInstagram({
        outputPath,
        mediaType,
        caption,
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
      <textarea
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        placeholder="キャプション"
        rows={2}
        maxLength={2200}
        className="resize-none rounded border border-line bg-panel px-2 py-1 text-xs text-neutral-200 outline-none focus:border-accent"
      />
      <div className="flex items-center gap-2">
        <select
          value={mediaType}
          onChange={(e) => setMediaType(e.target.value as MediaType)}
          className="rounded border border-line bg-panel px-2 py-1 text-xs text-neutral-200 outline-none focus:border-accent"
        >
          <option value="REELS">REELS (9:16)</option>
          <option value="VIDEO">VIDEO (1:1 / 4:5)</option>
        </select>
        <input
          type="datetime-local"
          value={publishAt}
          onChange={(e) => setPublishAt(e.target.value)}
          className="flex-1 rounded border border-line bg-panel px-2 py-1 text-xs text-neutral-200 outline-none focus:border-accent"
        />
      </div>
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
