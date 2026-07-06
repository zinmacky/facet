import type { FitMode } from "@reframe/core";
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Clip, OutputTarget } from "../../types";
import { FIT_OPTIONS, OUTPUT_TARGETS, finalSpec, targetById } from "../../types";
import type { ExportEvent, ProbeResult } from "../../lib/api";
import {
  downloadZip,
  fileDownloadUrl,
  fileRawUrl,
  postExport,
  publishInstagram,
  publishYoutube,
  subscribeExport,
} from "../../lib/api";
import {
  WEEKDAY_LABELS,
  generateSchedule,
  localInputToMs,
  msToLocalInput,
} from "../../lib/schedule";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { cn } from "../../components/ui/cn";

/**
 * UPLOAD モーダル(Post / Output の二層モデル)。
 * Post = 「どの切り抜きを何時に投稿するか」。1 Post は複数の出力先(Output)を持ち、
 * すべて同じ publishAt(=同時刻)で投稿される。各 Output はターゲット/フィット/メタを持つ。
 */

interface UploadModalProps {
  open: boolean;
  source: { inputPath: string; probe: ProbeResult } | null;
  clips: Clip[];
  onClose: () => void;
  onBack: () => void;
}

/** 1 投稿の出力先(プラットフォーム別の書き出し・メタ)。 */
interface UploadOutput {
  id: string;
  /** OUTPUT_TARGETS の id。既定 "yt-shorts"。 */
  targetId: string;
  /** 既定 "crop"。 */
  fit: FitMode;
  /** YouTube 用。 */
  title: string;
  /** YouTube 用。 */
  description: string;
  /** Instagram 用。 */
  caption: string;
}

/** 1 投稿(= どの clip を何時に投稿するか)。全 Output を同時刻で投稿する。 */
interface UploadPost {
  id: string;
  clipId: string;
  /** この投稿の予約時刻。全出力に適用。未指定=即時。 */
  publishAt?: number;
  outputs: UploadOutput[];
}

/** 投稿処理の進行状態。 */
type PubStatusKind =
  | "idle"
  | "rendering"
  | "publishing"
  | "success"
  | "error";

interface PubStatus {
  kind: PubStatusKind;
  message?: string;
}

/** 最終レンダリング結果。プレビュー表示・DL・投稿で再利用する。 */
interface RenderState {
  rendering: boolean;
  /** 生成済みファイルの絶対パス。 */
  outputPath?: string;
  /** 生成時の設定シグネチャ(clipId|targetId|fit)。現在値と異なれば要更新。 */
  sig?: string;
  error?: string;
}

/** Output の設定シグネチャ。これが変わったらレンダリングは古い(要更新)。 */
function outputSig(post: UploadPost, output: UploadOutput): string {
  return `${post.clipId}|${output.targetId}|${output.fit}`;
}

const DEFAULT_TARGET_ID = "yt-shorts";
const DEFAULT_FIT: FitMode = "crop";

/** 既定の Output を生成する。 */
function createOutput(): UploadOutput {
  return {
    id: crypto.randomUUID(),
    targetId: DEFAULT_TARGET_ID,
    fit: DEFAULT_FIT,
    title: "",
    description: "",
    caption: "",
  };
}

/** clip から既定の Post(Output 1 つ)を生成する。 */
function createPost(clipId: string): UploadPost {
  return {
    id: crypto.randomUUID(),
    clipId,
    outputs: [createOutput()],
  };
}

/** 共通の入力スタイル(ダークな編集ツール調)。 */
const inputClass =
  "h-8 rounded-md border border-line bg-elevated px-2 text-xs text-neutral-200 " +
  "focus:border-accent focus:outline-none";
const selectClass = cn(inputClass, "cursor-pointer");
const textareaClass =
  "min-h-[56px] w-full rounded-md border border-line bg-elevated px-2 py-1.5 " +
  "text-xs text-neutral-200 focus:border-accent focus:outline-none";

export function UploadModal({ open, source, clips, onClose, onBack }: UploadModalProps) {
  const [posts, setPosts] = useState<UploadPost[]>([]);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  // output.id → 投稿処理の進行状態。
  const [pubStatuses, setPubStatuses] = useState<Map<string, PubStatus>>(new Map());
  // output.id → 最終レンダリング結果(プレビュー/DL/投稿で共有)。
  const [renders, setRenders] = useState<Map<string, RenderState>>(new Map());

  // 一括予約スケジュールの入力状態。
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // 曜日ごとの時刻リスト(曜日ごとに異なる複数時刻を設定できる)。
  const [weekdayTimes, setWeekdayTimes] = useState<Record<number, string[]>>({});
  const [assignNote, setAssignNote] = useState<string | null>(null);

  // 閉じたら内部状態を初期化する(再度開いたときは現在の clips から作り直す)。
  useEffect(() => {
    if (open) return;
    setPosts([]);
    setSelectedPostId(null);
    setPubStatuses(new Map());
    setRenders(new Map());
    setStartDate("");
    setEndDate("");
    setWeekdayTimes({});
    setAssignNote(null);
  }, [open]);

  // open 時に posts を初期化(空のときのみ)。各 clip につき 1 Post(Output 1 つ)。
  useEffect(() => {
    if (!open) return;
    setPosts((prev) => {
      if (prev.length > 0) return prev;
      const created = clips.map((clip) => createPost(clip.id));
      // 初期化直後は先頭 Post を選択する。
      setSelectedPostId(created[0]?.id ?? null);
      return created;
    });
  }, [open, clips]);

  // 選択中 id が posts に無い場合は先頭へ補正する(削除・並び替え時の担保)。
  useEffect(() => {
    if (posts.length === 0) {
      if (selectedPostId !== null) setSelectedPostId(null);
      return;
    }
    if (!posts.some((p) => p.id === selectedPostId)) {
      setSelectedPostId(posts[0]?.id ?? null);
    }
  }, [posts, selectedPostId]);

  // ---- Post 操作 -----------------------------------------------------------

  const patchPost = (postId: string, patch: Partial<UploadPost>) => {
    setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, ...patch } : p)));
  };

  const removePost = (postId: string) => {
    setPosts((prev) => {
      const idx = prev.findIndex((p) => p.id === postId);
      const next = prev.filter((p) => p.id !== postId);
      // 削除対象が選択中なら隣接(なければ null)を選択する。
      if (postId === selectedPostId) {
        const neighbor = next[idx] ?? next[idx - 1] ?? null;
        setSelectedPostId(neighbor?.id ?? null);
      }
      return next;
    });
  };

  const movePost = (index: number, dir: -1 | 1) => {
    setPosts((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const a = next[index];
      const b = next[target];
      if (!a || !b) return prev;
      next[index] = b;
      next[target] = a;
      return next;
    });
  };

  const addPost = () => {
    const firstClip = clips[0];
    if (!firstClip) return;
    const created = createPost(firstClip.id);
    setPosts((prev) => [...prev, created]);
    // 追加した Post を選択する。
    setSelectedPostId(created.id);
  };

  // ---- Output 操作 ---------------------------------------------------------

  const patchOutput = (postId: string, outputId: string, patch: Partial<UploadOutput>) => {
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId
          ? {
              ...p,
              outputs: p.outputs.map((o) => (o.id === outputId ? { ...o, ...patch } : o)),
            }
          : p,
      ),
    );
  };

  const addOutput = (postId: string) => {
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId ? { ...p, outputs: [...p.outputs, createOutput()] } : p,
      ),
    );
  };

  const removeOutput = (postId: string, outputId: string) => {
    setPosts((prev) =>
      prev.map((p) => {
        if (p.id !== postId) return p;
        // 最低 1 つは残す。
        if (p.outputs.length <= 1) return p;
        return { ...p, outputs: p.outputs.filter((o) => o.id !== outputId) };
      }),
    );
    setPubStatuses((prev) => {
      const next = new Map(prev);
      next.delete(outputId);
      return next;
    });
    setRenders((prev) => {
      const next = new Map(prev);
      next.delete(outputId);
      return next;
    });
  };

  // ---- 曜日・時刻リスト操作 ------------------------------------------------

  // 曜日の選択トグル。選択時は既定時刻 20:00 を 1 つ入れる。
  const toggleWeekday = (day: number) =>
    setWeekdayTimes((prev) => {
      const next = { ...prev };
      if (day in next) delete next[day];
      else next[day] = ["20:00"];
      return next;
    });

  const addTimeFor = (day: number) =>
    setWeekdayTimes((prev) => ({ ...prev, [day]: [...(prev[day] ?? []), "20:00"] }));

  const removeTimeFor = (day: number, index: number) =>
    setWeekdayTimes((prev) => {
      const list = prev[day];
      if (!list || list.length <= 1) return prev; // 最低 1 つは残す
      return { ...prev, [day]: list.filter((_, i) => i !== index) };
    });

  const setTimeFor = (day: number, index: number, value: string) =>
    setWeekdayTimes((prev) => {
      const list = prev[day];
      if (!list) return prev;
      return { ...prev, [day]: list.map((t, i) => (i === index ? value : t)) };
    });

  // 生成した予約日時を Post の並び順へ 1 つずつ割り当てる。
  // Post が同時刻グループの単位なので、1 Post = 1 スロット。
  const assignSchedule = () => {
    const slots = generateSchedule({ startDate, endDate, weekdayTimes });
    setPosts((prev) =>
      prev.map((p, i) => {
        const slot = slots[i];
        return slot !== undefined ? { ...p, publishAt: slot } : p;
      }),
    );
    const assigned = Math.min(posts.length, slots.length);
    if (slots.length === 0) {
      setAssignNote("枠が生成されませんでした(期間・曜日・時刻を確認してください)。");
    } else if (slots.length < posts.length) {
      setAssignNote(
        `${assigned} 件へ割当。枠が ${posts.length - slots.length} 件分不足しています。`,
      );
    } else {
      setAssignNote(`${assigned} 件へ割当(${slots.length} スロット)。`);
    }
  };

  // ---- レンダリング --------------------------------------------------------

  /** レンダリングを実行し、done で outputPath を返す。error / SSE エラーで reject。 */
  const renderClip = (
    spec: ReturnType<typeof finalSpec>,
    output: string,
  ): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      postExport({ spec, input: source?.inputPath ?? "", output })
        .then(({ jobId }) => {
          const unsubscribe = subscribeExport(jobId, {
            onEvent: (event: ExportEvent) => {
              if (event.type === "done") {
                unsubscribe();
                resolve(event.outputPath);
              } else if (event.type === "error") {
                unsubscribe();
                reject(new Error(event.message));
              }
            },
            onError: () => {
              unsubscribe();
              reject(new Error("レンダリングの購読でエラーが発生しました。"));
            },
          });
        })
        .catch((err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });

  const setRender = (outputId: string, patch: Partial<RenderState>) => {
    setRenders((prev) => {
      const next = new Map(prev);
      const base = next.get(outputId) ?? { rendering: false };
      next.set(outputId, { ...base, ...patch });
      return next;
    });
  };

  const setPubStatus = (outputId: string, status: PubStatus) => {
    setPubStatuses((prev) => {
      const next = new Map(prev);
      next.set(outputId, status);
      return next;
    });
  };

  /**
   * 現在の設定でレンダリング済みなら再利用し、無い/古い場合のみ再レンダリングする。
   * プレビュー生成・ダウンロード・投稿で共有する。
   */
  const ensureRendered = async (post: UploadPost, output: UploadOutput): Promise<string> => {
    if (!source) throw new Error("元動画が未選択です。");
    const clip = clips.find((c) => c.id === post.clipId);
    if (!clip) throw new Error("対象クリップが見つかりません。");
    const target = targetById(output.targetId);
    if (!target) throw new Error("出力ターゲットが無効です。");

    const sig = outputSig(post, output);
    const cached = renders.get(output.id);
    if (cached?.outputPath && cached.sig === sig) return cached.outputPath;

    setRender(output.id, { rendering: true, error: undefined });
    try {
      const spec = finalSpec(
        clip,
        { width: source.probe.width, height: source.probe.height },
        target,
        output.fit,
      );
      const outputName = `${clip.name}_${output.targetId}.mp4`;
      const outputPath = await renderClip(spec, outputName);
      setRender(output.id, { rendering: false, outputPath, sig, error: undefined });
      return outputPath;
    } catch (err) {
      setRender(output.id, {
        rendering: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  // ---- 投稿処理 ------------------------------------------------------------

  /** 1 Output を投稿する。publishAt は post.publishAt(全出力共通)を使う。 */
  const publishOutput = async (post: UploadPost, output: UploadOutput): Promise<void> => {
    if (!source) return;
    const clip = clips.find((c) => c.id === post.clipId);
    if (!clip) return;
    const target = targetById(output.targetId);
    if (!target) {
      setPubStatus(output.id, { kind: "error", message: "出力ターゲットが無効です。" });
      return;
    }

    try {
      // 1. レンダリング(生成済みなら再利用)。
      setPubStatus(output.id, { kind: "rendering" });
      const outputPath = await ensureRendered(post, output);

      // 2. 投稿。
      setPubStatus(output.id, { kind: "publishing" });
      await publishTo(target, post, output, clip.name, outputPath);

      setPubStatus(output.id, { kind: "success" });
    } catch (err) {
      setPubStatus(output.id, {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  /** プラットフォーム別の投稿。publishAt は post.publishAt。 */
  const publishTo = async (
    target: OutputTarget,
    post: UploadPost,
    output: UploadOutput,
    clipName: string,
    outputPath: string,
  ): Promise<void> => {
    if (target.platform === "youtube") {
      await publishYoutube({
        outputPath,
        title: output.title || clipName,
        description: output.description,
        ...(post.publishAt !== undefined ? { publishAt: post.publishAt } : {}),
        privacyStatus: post.publishAt !== undefined ? "private" : "public",
      });
    } else {
      await publishInstagram({
        outputPath,
        mediaType: "VIDEO",
        caption: output.caption,
        publishAt: post.publishAt ?? Date.now() + 5 * 60_000,
      });
    }
  };

  // 1 Post の全 Output を逐次投稿する。
  const publishPostMutation = useMutation({
    mutationFn: async (post: UploadPost) => {
      for (const output of post.outputs) {
        try {
          await publishOutput(post, output);
        } catch {
          // 個別ステータスへ反映済み。1 件失敗しても後続は続行する。
        }
      }
    },
  });

  // 全 Post の全 Output を逐次投稿する。
  const publishAllMutation = useMutation({
    mutationFn: async () => {
      for (const post of posts) {
        for (const output of post.outputs) {
          try {
            await publishOutput(post, output);
          } catch {
            // 個別ステータスへ反映済み。1 件失敗しても後続は続行する。
          }
        }
      }
    },
  });

  const busy = publishPostMutation.isPending || publishAllMutation.isPending;

  // 全 Output 数(M)と、現在設定と一致する(=最新の)生成済み Output 数(N)。
  const totalOutputs = posts.reduce((sum, p) => sum + p.outputs.length, 0);
  const readyOutputs = posts.reduce((sum, p) => {
    return (
      sum +
      p.outputs.filter((o) => {
        const r = renders.get(o.id);
        return r?.outputPath !== undefined && r.sig === outputSig(p, o);
      }).length
    );
  }, 0);

  // 一括ダウンロード: 押下時に全 Post の全 Output を ensureRendered(再利用)してから ZIP 化する。
  const bulkDownloadMutation = useMutation({
    mutationFn: async () => {
      const paths: string[] = [];
      for (const post of posts) {
        for (const output of post.outputs) {
          try {
            paths.push(await ensureRendered(post, output));
          } catch {
            // 個別の生成失敗は renders.error に反映済み。スキップして続行。
          }
        }
      }
      if (paths.length === 0) {
        throw new Error("ダウンロードできる出力がありません(生成に失敗しました)。");
      }
      await downloadZip(paths, "reframe-upload.zip");
    },
  });

  // プレビュー生成(現在設定でレンダリング)。エラーは renders.error に反映。
  const previewOutput = (post: UploadPost, output: UploadOutput) => {
    void ensureRendered(post, output).catch(() => undefined);
  };

  const footer = (
    <>
      <Button variant="ghost" onClick={onBack} disabled={busy}>
        戻る
      </Button>
      <Button variant="secondary" onClick={onClose} disabled={busy}>
        閉じる
      </Button>
      <Button
        variant="primary"
        onClick={() => publishAllMutation.mutate()}
        disabled={busy || totalOutputs === 0}
      >
        すべて投稿
      </Button>
    </>
  );

  // 中央詳細に表示する選択中の Post。
  const selectedPost = posts.find((p) => p.id === selectedPostId) ?? null;

  return (
    <Modal open={open} title="アップロード" onClose={onClose} footer={footer} widthClass="max-w-7xl">
      <div className="flex flex-col gap-4">
        <BulkSchedule
          startDate={startDate}
          endDate={endDate}
          weekdayTimes={weekdayTimes}
          note={assignNote}
          onStartDate={setStartDate}
          onEndDate={setEndDate}
          onToggleWeekday={toggleWeekday}
          onAddTime={addTimeFor}
          onRemoveTime={removeTimeFor}
          onSetTime={setTimeFor}
          onAssign={assignSchedule}
        />

        <div className="flex min-h-[52vh] gap-3">
          {/* 中央: 選択中 Post の詳細 */}
          <div className="flex-1 min-w-0 overflow-y-auto">
            {selectedPost ? (
              <PostDetail
                key={selectedPost.id}
                post={selectedPost}
                clips={clips}
                renders={renders}
                pubStatuses={pubStatuses}
                busy={busy}
                onPatchPost={(patch) => patchPost(selectedPost.id, patch)}
                onPatchOutput={(outputId, patch) =>
                  patchOutput(selectedPost.id, outputId, patch)
                }
                onAddOutput={() => addOutput(selectedPost.id)}
                onRemoveOutput={(outputId) => removeOutput(selectedPost.id, outputId)}
                onPreviewOutput={(output) => previewOutput(selectedPost, output)}
                onPublishOutput={(output) =>
                  void publishOutput(selectedPost, output).catch(() => undefined)
                }
                onPublishPost={() => publishPostMutation.mutate(selectedPost)}
              />
            ) : (
              <p className="rounded-md border border-dashed border-line px-3 py-10 text-center text-xs text-neutral-500">
                右の一覧から投稿を選択してください。
              </p>
            )}
          </div>

          {/* 右: 投稿(Post)一覧 */}
          <div className="w-72 shrink-0 border-l border-line pl-3 overflow-y-auto">
            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => bulkDownloadMutation.mutate()}
                disabled={totalOutputs === 0 || bulkDownloadMutation.isPending}
              >
                {bulkDownloadMutation.isPending ? "生成中…" : "一括ダウンロード(ZIP)"}
              </Button>
              <span className="text-[11px] text-neutral-500">
                生成済み {readyOutputs}/{totalOutputs}
              </span>
              {bulkDownloadMutation.isError && (
                <span className="text-[11px] text-danger">
                  {(bulkDownloadMutation.error as Error).message}
                </span>
              )}
              <Button variant="secondary" size="sm" onClick={addPost} disabled={clips.length === 0}>
                + 投稿を追加
              </Button>
            </div>

            <div className="mt-3 flex flex-col gap-1.5">
              {posts.length === 0 && (
                <p className="rounded-md border border-dashed border-line px-2 py-4 text-center text-[11px] text-neutral-500">
                  投稿がありません。
                </p>
              )}
              {posts.map((post, index) => (
                <PostRow
                  key={post.id}
                  post={post}
                  index={index}
                  total={posts.length}
                  clips={clips}
                  selected={post.id === selectedPostId}
                  onSelect={() => setSelectedPostId(post.id)}
                  onMove={(dir) => movePost(index, dir)}
                  onRemove={() => removePost(post.id)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---- 一括予約スケジュール ---------------------------------------------------

interface BulkScheduleProps {
  startDate: string;
  endDate: string;
  weekdayTimes: Record<number, string[]>;
  note: string | null;
  onStartDate: (v: string) => void;
  onEndDate: (v: string) => void;
  onToggleWeekday: (day: number) => void;
  onAddTime: (day: number) => void;
  onRemoveTime: (day: number, index: number) => void;
  onSetTime: (day: number, index: number, value: string) => void;
  onAssign: () => void;
}

function BulkSchedule(props: BulkScheduleProps) {
  const [expanded, setExpanded] = useState(false);
  const selectedDays = Object.keys(props.weekdayTimes)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <section className="rounded-lg border border-line bg-elevated/40 p-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 text-left text-xs font-semibold text-neutral-200"
      >
        <span className="text-[10px] text-neutral-500">{expanded ? "▼" : "▶"}</span>
        一括予約スケジュール
      </button>
      {expanded && (
      <div className="mt-2 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            開始日
            <input
              type="date"
              className={inputClass}
              value={props.startDate}
              onChange={(e) => props.onStartDate(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            終了日
            <input
              type="date"
              className={inputClass}
              value={props.endDate}
              onChange={(e) => props.onEndDate(e.target.value)}
            />
          </label>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-neutral-400">曜日</span>
          {WEEKDAY_LABELS.map((label, day) => {
            const active = day in props.weekdayTimes;
            return (
              <button
                key={label}
                type="button"
                onClick={() => props.onToggleWeekday(day)}
                className={cn(
                  "h-7 w-7 rounded-md border text-xs transition-colors",
                  active
                    ? "border-accent bg-accent/20 text-accent"
                    : "border-line bg-elevated text-neutral-400 hover:border-accent/60",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* 曜日ごとの時刻(曜日ごとに異なる複数時刻を設定できる) */}
        {selectedDays.length === 0 ? (
          <p className="text-[11px] text-neutral-600">曜日を選ぶと、その曜日の時刻を設定できます。</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {selectedDays.map((day) => {
              const list = props.weekdayTimes[day] ?? [];
              return (
                <div key={day} className="flex flex-wrap items-center gap-2">
                  <span className="w-5 text-center text-[11px] font-semibold text-accent">
                    {WEEKDAY_LABELS[day] ?? ""}
                  </span>
                  {list.map((time, index) => (
                    <div key={index} className="flex items-center gap-1">
                      <input
                        type="time"
                        className={inputClass}
                        value={time}
                        onChange={(e) => props.onSetTime(day, index, e.target.value)}
                      />
                      {list.length > 1 && (
                        <button
                          type="button"
                          aria-label="時刻を削除"
                          onClick={() => props.onRemoveTime(day, index)}
                          className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-elevated text-neutral-500 hover:border-danger hover:text-danger"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  <Button variant="ghost" size="sm" onClick={() => props.onAddTime(day)}>
                    + 時刻
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={props.onAssign}>
            この順で予約日時を割り当て
          </Button>
          {props.note && <span className="text-[11px] text-neutral-400">{props.note}</span>}
        </div>
      </div>
      )}
    </section>
  );
}

// ---- Post 詳細(中央) ------------------------------------------------------

interface PostDetailProps {
  post: UploadPost;
  clips: Clip[];
  renders: Map<string, RenderState>;
  pubStatuses: Map<string, PubStatus>;
  busy: boolean;
  onPatchPost: (patch: Partial<UploadPost>) => void;
  onPatchOutput: (outputId: string, patch: Partial<UploadOutput>) => void;
  onAddOutput: () => void;
  onRemoveOutput: (outputId: string) => void;
  onPreviewOutput: (output: UploadOutput) => void;
  onPublishOutput: (output: UploadOutput) => void;
  onPublishPost: () => void;
}

function PostDetail(props: PostDetailProps) {
  const { post, clips, busy } = props;
  const datetimeValue = post.publishAt !== undefined ? msToLocalInput(post.publishAt) : "";

  const onDatetimeChange = (value: string) => {
    const ms = localInputToMs(value);
    props.onPatchPost(ms !== null ? { publishAt: ms } : { publishAt: undefined });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 投稿ヘッダ: 対象 clip + 予約日時 + この投稿をすべて投稿 */}
      <div className="rounded-lg border border-line bg-panel p-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
            対象 clip
            <select
              className={selectClass}
              value={post.clipId}
              onChange={(e) => props.onPatchPost({ clipId: e.target.value })}
            >
              {clips.map((clip) => (
                <option key={clip.id} value={clip.id}>
                  {clip.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
            予約日時(未指定=即時)
            <input
              type="datetime-local"
              className={inputClass}
              value={datetimeValue}
              onChange={(e) => onDatetimeChange(e.target.value)}
            />
          </label>
        </div>

        <div className="mt-2 flex justify-end">
          <Button variant="primary" size="sm" onClick={props.onPublishPost} disabled={busy}>
            この投稿をすべて投稿
          </Button>
        </div>
      </div>

      {/* 出力先(Output)一覧 */}
      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-semibold text-neutral-300">出力先</span>
        {post.outputs.map((output) => (
          <OutputCard
            key={output.id}
            post={post}
            output={output}
            canRemove={post.outputs.length > 1}
            render={props.renders.get(output.id)}
            status={props.pubStatuses.get(output.id)}
            busy={busy}
            onPatch={(patch) => props.onPatchOutput(output.id, patch)}
            onRemove={() => props.onRemoveOutput(output.id)}
            onPreview={() => props.onPreviewOutput(output)}
            onPublish={() => props.onPublishOutput(output)}
          />
        ))}
        <Button variant="secondary" size="sm" onClick={props.onAddOutput}>
          + 出力先を追加
        </Button>
      </div>
    </div>
  );
}

// ---- Output カード ----------------------------------------------------------

interface OutputCardProps {
  post: UploadPost;
  output: UploadOutput;
  canRemove: boolean;
  render: RenderState | undefined;
  status: PubStatus | undefined;
  busy: boolean;
  onPatch: (patch: Partial<UploadOutput>) => void;
  onRemove: () => void;
  onPreview: () => void;
  onPublish: () => void;
}

function OutputCard(props: OutputCardProps) {
  const { post, output, render, status, busy } = props;
  const platform = useMemo(() => targetById(output.targetId)?.platform, [output.targetId]);

  // 現在設定と生成済みファイルの整合。fresh=最新、stale=設定変更後で要更新。
  const rendering = render?.rendering ?? false;
  const outputPath = render?.outputPath;
  const sig = outputSig(post, output);
  const fresh = outputPath !== undefined && render?.sig === sig;
  const stale = outputPath !== undefined && render?.sig !== sig;

  return (
    <div className="rounded-lg border border-line bg-panel p-3">
      <div className="flex gap-3">
        {/* 左: 最終プレビュー + ダウンロード */}
        <div className="flex w-72 shrink-0 flex-col gap-2 rounded-md border border-line bg-elevated/40 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-neutral-400">
              最終プレビュー
              {stale && <span className="ml-1 text-amber-400">(要更新)</span>}
            </span>
            {fresh && outputPath && (
              <a
                href={fileDownloadUrl(outputPath)}
                download
                className="text-[11px] text-accent hover:underline"
              >
                DL
              </a>
            )}
          </div>
          {outputPath ? (
            <video
              src={fileRawUrl(outputPath)}
              controls
              className={cn("max-h-64 w-full rounded bg-black", stale && "opacity-60")}
            />
          ) : (
            <p className="py-8 text-center text-[11px] text-neutral-600">
              「生成」で最終アスペクト・フィットを確認できます。
            </p>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={props.onPreview}
            disabled={rendering || busy}
          >
            {rendering ? "生成中…" : outputPath ? "プレビュー更新" : "プレビュー生成"}
          </Button>
          {render?.error && <p className="text-[11px] text-danger">{render.error}</p>}
        </div>

        {/* 右: 出力ターゲット〜メタデータ + 投稿 */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
              出力ターゲット
              <select
                className={selectClass}
                value={output.targetId}
                onChange={(e) => props.onPatch({ targetId: e.target.value })}
              >
                {OUTPUT_TARGETS.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
              フィット
              <select
                className={selectClass}
                value={output.fit}
                onChange={(e) => props.onPatch({ fit: e.target.value as FitMode })}
              >
                {FIT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            {props.canRemove && (
              <button
                type="button"
                aria-label="出力先を削除"
                onClick={props.onRemove}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-line bg-elevated text-neutral-500 hover:border-danger hover:text-danger"
              >
                ✕
              </button>
            )}
          </div>

          {/* メタデータ */}
          {platform === "youtube" ? (
            <>
              <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
                タイトル
                <input
                  type="text"
                  className={cn(inputClass, "w-full")}
                  value={output.title}
                  onChange={(e) => props.onPatch({ title: e.target.value })}
                />
              </label>
              <label className="flex min-h-0 flex-1 flex-col gap-1 text-[11px] text-neutral-400">
                説明
                <textarea
                  className={cn(textareaClass, "min-h-0 flex-1")}
                  value={output.description}
                  onChange={(e) => props.onPatch({ description: e.target.value })}
                />
              </label>
            </>
          ) : (
            <label className="flex min-h-0 flex-1 flex-col gap-1 text-[11px] text-neutral-400">
              キャプション
              <textarea
                className={cn(textareaClass, "min-h-0 flex-1")}
                maxLength={2200}
                value={output.caption}
                onChange={(e) => props.onPatch({ caption: e.target.value })}
              />
            </label>
          )}

          <div className="mt-auto flex items-center justify-between">
            <StatusBadge status={status} />
            <Button variant="primary" size="sm" onClick={props.onPublish} disabled={busy}>
              投稿
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 投稿(Post)一覧の行 ---------------------------------------------------

interface PostRowProps {
  post: UploadPost;
  index: number;
  total: number;
  clips: Clip[];
  selected: boolean;
  onSelect: () => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}

function PostRow(props: PostRowProps) {
  const { post, index, total, clips, selected } = props;
  const clipName = clips.find((c) => c.id === post.clipId)?.name ?? "(不明な clip)";
  const scheduleLabel =
    post.publishAt !== undefined
      ? msToLocalInput(post.publishAt).replace("T", " ")
      : "即時";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onSelect();
        }
      }}
      className={cn(
        "cursor-pointer rounded-md border p-2 transition-colors",
        selected
          ? "border-accent bg-accent/10"
          : "border-line bg-panel hover:border-accent/60",
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-neutral-500">#{index + 1}</span>
            <span className="truncate text-xs text-neutral-200" title={clipName}>
              {clipName}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="truncate text-[11px] text-neutral-400" title={scheduleLabel}>
              {scheduleLabel}
            </span>
            <span className="shrink-0 rounded bg-elevated px-1 text-[10px] text-neutral-400">
              {post.outputs.length} 出力
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="上へ"
            disabled={index === 0}
            onClick={(e) => {
              e.stopPropagation();
              props.onMove(-1);
            }}
            className="flex h-6 w-6 items-center justify-center rounded border border-line bg-elevated text-neutral-400 hover:text-neutral-100 disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="下へ"
            disabled={index === total - 1}
            onClick={(e) => {
              e.stopPropagation();
              props.onMove(1);
            }}
            className="flex h-6 w-6 items-center justify-center rounded border border-line bg-elevated text-neutral-400 hover:text-neutral-100 disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            aria-label="削除"
            onClick={(e) => {
              e.stopPropagation();
              props.onRemove();
            }}
            className="flex h-6 w-6 items-center justify-center rounded border border-line bg-elevated text-neutral-500 hover:border-danger hover:text-danger"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- ステータス表示 ---------------------------------------------------------

function StatusBadge({ status }: { status: PubStatus | undefined }) {
  const kind = status?.kind ?? "idle";
  const label: Record<PubStatusKind, string> = {
    idle: "未投稿",
    rendering: "レンダリング中…",
    publishing: "投稿中…",
    success: "完了",
    error: "エラー",
  };
  const tone: Record<PubStatusKind, string> = {
    idle: "text-neutral-500",
    rendering: "text-accent",
    publishing: "text-accent",
    success: "text-emerald-400",
    error: "text-danger",
  };
  return (
    <span className={cn("text-[11px]", tone[kind])}>
      {label[kind]}
      {kind === "error" && status?.message ? `: ${status.message}` : ""}
    </span>
  );
}
