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
 * UPLOAD モーダル。
 * 各動画(clip)を最終プラットフォーム向けに設定(アスペクト/フィット/メタ/予約)し、
 * レンダリング → 投稿を逐次実行する。
 */

interface UploadModalProps {
  open: boolean;
  source: { inputPath: string; probe: ProbeResult } | null;
  clips: Clip[];
  onClose: () => void;
  onBack: () => void;
}

/** 1 投稿単位の設定。 */
interface UploadItem {
  id: string;
  clipId: string;
  targetId: string;
  fit: FitMode;
  title: string;
  description: string;
  caption: string;
  publishAt?: number;
}

/** 投稿処理の進行状態。 */
type UploadStatusKind =
  | "idle"
  | "rendering"
  | "publishing"
  | "success"
  | "error";

interface UploadStatus {
  kind: UploadStatusKind;
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

/** アイテムの設定シグネチャ。これが変わったらレンダリングは古い(要更新)。 */
function itemSig(item: UploadItem): string {
  return `${item.clipId}|${item.targetId}|${item.fit}`;
}

const DEFAULT_TARGET_ID = "yt-shorts";
const DEFAULT_FIT: FitMode = "crop";

/** 共通の入力スタイル(ダークな編集ツール調)。 */
const inputClass =
  "h-8 rounded-md border border-line bg-elevated px-2 text-xs text-neutral-200 " +
  "focus:border-accent focus:outline-none";
const selectClass = cn(inputClass, "cursor-pointer");
const textareaClass =
  "min-h-[56px] w-full rounded-md border border-line bg-elevated px-2 py-1.5 " +
  "text-xs text-neutral-200 focus:border-accent focus:outline-none";

export function UploadModal({ open, source, clips, onClose, onBack }: UploadModalProps) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [statuses, setStatuses] = useState<Map<string, UploadStatus>>(new Map());
  // itemId → 最終レンダリング結果(プレビュー/DL/投稿で共有)。
  const [renders, setRenders] = useState<Map<string, RenderState>>(new Map());

  // 一括予約スケジュールの入力状態。
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [times, setTimes] = useState<string[]>(["20:00"]);
  const [assignNote, setAssignNote] = useState<string | null>(null);

  // 閉じたら内部状態を初期化する(再度開いたときは現在の clips から作り直す)。
  useEffect(() => {
    if (open) return;
    setItems([]);
    setStatuses(new Map());
    setRenders(new Map());
    setStartDate("");
    setEndDate("");
    setWeekdays([]);
    setTimes(["20:00"]);
    setAssignNote(null);
  }, [open]);

  // open 時に items を初期化(空のときのみ)。各 clip につき 1 つ。
  useEffect(() => {
    if (!open) return;
    setItems((prev) => {
      if (prev.length > 0) return prev;
      return clips.map((clip) => ({
        id: crypto.randomUUID(),
        clipId: clip.id,
        targetId: DEFAULT_TARGET_ID,
        fit: DEFAULT_FIT,
        title: "",
        description: "",
        caption: "",
      }));
    });
  }, [open, clips]);

  const setStatus = (itemId: string, status: UploadStatus) => {
    setStatuses((prev) => {
      const next = new Map(prev);
      next.set(itemId, status);
      return next;
    });
  };

  const patchItem = (itemId: string, patch: Partial<UploadItem>) => {
    setItems((prev) =>
      prev.map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
    );
  };

  const removeItem = (itemId: string) => {
    setItems((prev) => prev.filter((it) => it.id !== itemId));
    setStatuses((prev) => {
      const next = new Map(prev);
      next.delete(itemId);
      return next;
    });
  };

  const moveItem = (index: number, dir: -1 | 1) => {
    setItems((prev) => {
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

  const addItem = () => {
    const firstClip = clips[0];
    if (!firstClip) return;
    setItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        clipId: firstClip.id,
        targetId: DEFAULT_TARGET_ID,
        fit: DEFAULT_FIT,
        title: "",
        description: "",
        caption: "",
      },
    ]);
  };

  // ---- 時刻リスト操作 ------------------------------------------------------

  const addTime = () => setTimes((prev) => [...prev, "20:00"]);
  const removeTime = (index: number) =>
    setTimes((prev) => prev.filter((_, i) => i !== index));
  const setTime = (index: number, value: string) =>
    setTimes((prev) => prev.map((t, i) => (i === index ? value : t)));

  const toggleWeekday = (day: number) =>
    setWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );

  // 生成した予約日時を items の並び順(上から昇順)へ割り当てる。
  const assignSchedule = () => {
    const slots = generateSchedule({ startDate, endDate, weekdays, times });
    setItems((prev) =>
      prev.map((it, i) => {
        const slot = slots[i];
        return slot !== undefined ? { ...it, publishAt: slot } : it;
      }),
    );
    const assigned = Math.min(slots.length, items.length);
    if (slots.length === 0) {
      setAssignNote("枠が生成されませんでした(期間・曜日・時刻を確認してください)。");
    } else if (slots.length < items.length) {
      setAssignNote(
        `${assigned} 件へ割当。枠が ${items.length - slots.length} 件不足しています。`,
      );
    } else if (slots.length > items.length) {
      setAssignNote(
        `${assigned} 件へ割当。枠が ${slots.length - items.length} 件余っています。`,
      );
    } else {
      setAssignNote(`${assigned} 件へ割当(枠ちょうど)。`);
    }
  };

  // ---- 投稿処理 ------------------------------------------------------------

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

  const setRender = (itemId: string, patch: Partial<RenderState>) => {
    setRenders((prev) => {
      const next = new Map(prev);
      const base = next.get(itemId) ?? { rendering: false };
      next.set(itemId, { ...base, ...patch });
      return next;
    });
  };

  /**
   * 現在の設定でレンダリング済みなら再利用し、無い/古い場合のみ再レンダリングする。
   * プレビュー生成・ダウンロード・投稿で共有する。
   */
  const ensureRendered = async (item: UploadItem): Promise<string> => {
    if (!source) throw new Error("元動画が未選択です。");
    const clip = clips.find((c) => c.id === item.clipId);
    if (!clip) throw new Error("対象クリップが見つかりません。");
    const target = targetById(item.targetId);
    if (!target) throw new Error("出力ターゲットが無効です。");

    const sig = itemSig(item);
    const cached = renders.get(item.id);
    if (cached?.outputPath && cached.sig === sig) return cached.outputPath;

    setRender(item.id, { rendering: true, error: undefined });
    try {
      const spec = finalSpec(
        clip,
        { width: source.probe.width, height: source.probe.height },
        target,
        item.fit,
      );
      const output = `${clip.name}_${item.targetId}.mp4`;
      const outputPath = await renderClip(spec, output);
      setRender(item.id, { rendering: false, outputPath, sig, error: undefined });
      return outputPath;
    } catch (err) {
      setRender(item.id, {
        rendering: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const publishOne = async (item: UploadItem): Promise<void> => {
    if (!source) return;
    const clip = clips.find((c) => c.id === item.clipId);
    if (!clip) return;
    const target = targetById(item.targetId);
    if (!target) {
      setStatus(item.id, { kind: "error", message: "出力ターゲットが無効です。" });
      return;
    }

    try {
      // 1. レンダリング(生成済みなら再利用)。
      setStatus(item.id, { kind: "rendering" });
      const outputPath = await ensureRendered(item);

      // 2. 投稿。
      setStatus(item.id, { kind: "publishing" });
      await publishTo(target, item, clip.name, outputPath);

      setStatus(item.id, { kind: "success" });
    } catch (err) {
      setStatus(item.id, {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  /** プラットフォーム別の投稿。 */
  const publishTo = async (
    target: OutputTarget,
    item: UploadItem,
    clipName: string,
    outputPath: string,
  ): Promise<void> => {
    if (target.platform === "youtube") {
      await publishYoutube({
        outputPath,
        title: item.title || clipName,
        description: item.description,
        ...(item.publishAt !== undefined ? { publishAt: item.publishAt } : {}),
        privacyStatus: item.publishAt !== undefined ? "private" : "public",
      });
    } else {
      await publishInstagram({
        outputPath,
        mediaType: "VIDEO",
        caption: item.caption,
        publishAt: item.publishAt ?? Date.now() + 5 * 60_000,
      });
    }
  };

  // 単一投稿。
  const publishOneMutation = useMutation({
    mutationFn: (item: UploadItem) => publishOne(item),
  });

  // すべて投稿(逐次 await)。
  const publishAllMutation = useMutation({
    mutationFn: async () => {
      for (const item of items) {
        try {
          await publishOne(item);
        } catch {
          // 個別ステータスへ反映済み。1 件失敗しても後続は続行する。
        }
      }
    },
  });

  const busy = publishOneMutation.isPending || publishAllMutation.isPending;

  // 現在設定と一致する(=最新の)生成済みファイル一覧。一括DL 対象。
  const readyPaths = items
    .map((it) => {
      const r = renders.get(it.id);
      return r?.outputPath && r.sig === itemSig(it) ? r.outputPath : null;
    })
    .filter((p): p is string => p !== null);

  const bulkDownloadMutation = useMutation({
    mutationFn: () => downloadZip(readyPaths, "reframe-upload.zip"),
  });

  // プレビュー生成(現在設定でレンダリング)。エラーは renders.error に反映。
  const previewOne = (item: UploadItem) => {
    void ensureRendered(item).catch(() => undefined);
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
        disabled={busy || items.length === 0}
      >
        すべて投稿
      </Button>
    </>
  );

  return (
    <Modal open={open} title="アップロード" onClose={onClose} footer={footer} widthClass="max-w-4xl">
      <div className="flex flex-col gap-4">
        <BulkSchedule
          startDate={startDate}
          endDate={endDate}
          weekdays={weekdays}
          times={times}
          note={assignNote}
          onStartDate={setStartDate}
          onEndDate={setEndDate}
          onToggleWeekday={toggleWeekday}
          onAddTime={addTime}
          onRemoveTime={removeTime}
          onSetTime={setTime}
          onAssign={assignSchedule}
        />

        {items.length > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-neutral-500">
              プレビュー生成済み: {readyPaths.length}/{items.length}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => bulkDownloadMutation.mutate()}
              disabled={readyPaths.length === 0 || bulkDownloadMutation.isPending}
            >
              {bulkDownloadMutation.isPending ? "生成中…" : "一括ダウンロード(ZIP)"}
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {items.length === 0 && (
            <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-neutral-500">
              投稿する出力がありません。「+ 出力を追加」で追加してください。
            </p>
          )}
          {items.map((item, index) => (
            <UploadItemCard
              key={item.id}
              item={item}
              index={index}
              total={items.length}
              clips={clips}
              status={statuses.get(item.id)}
              render={renders.get(item.id)}
              busy={busy}
              onPatch={(patch) => patchItem(item.id, patch)}
              onMove={(dir) => moveItem(index, dir)}
              onRemove={() => removeItem(item.id)}
              onPreview={() => previewOne(item)}
              onPublish={() => publishOneMutation.mutate(item)}
            />
          ))}
        </div>

        <div>
          <Button variant="secondary" size="sm" onClick={addItem} disabled={clips.length === 0}>
            + 出力を追加
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---- 一括予約スケジュール ---------------------------------------------------

interface BulkScheduleProps {
  startDate: string;
  endDate: string;
  weekdays: number[];
  times: string[];
  note: string | null;
  onStartDate: (v: string) => void;
  onEndDate: (v: string) => void;
  onToggleWeekday: (day: number) => void;
  onAddTime: () => void;
  onRemoveTime: (index: number) => void;
  onSetTime: (index: number, value: string) => void;
  onAssign: () => void;
}

function BulkSchedule(props: BulkScheduleProps) {
  return (
    <section className="rounded-lg border border-line bg-elevated/40 p-3">
      <h3 className="mb-2 text-xs font-semibold text-neutral-200">一括予約スケジュール</h3>
      <div className="flex flex-col gap-3">
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
            const active = props.weekdays.includes(day);
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

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] text-neutral-400">時刻</span>
          <div className="flex flex-wrap items-center gap-2">
            {props.times.map((time, index) => (
              <div key={index} className="flex items-center gap-1">
                <input
                  type="time"
                  className={inputClass}
                  value={time}
                  onChange={(e) => props.onSetTime(index, e.target.value)}
                />
                <button
                  type="button"
                  aria-label="時刻を削除"
                  onClick={() => props.onRemoveTime(index)}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-elevated text-neutral-500 hover:border-danger hover:text-danger"
                >
                  ✕
                </button>
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={props.onAddTime}>
              + 時刻を追加
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={props.onAssign}>
            この順で予約日時を割り当て
          </Button>
          {props.note && <span className="text-[11px] text-neutral-400">{props.note}</span>}
        </div>
      </div>
    </section>
  );
}

// ---- UploadItem カード ------------------------------------------------------

interface UploadItemCardProps {
  item: UploadItem;
  index: number;
  total: number;
  clips: Clip[];
  status: UploadStatus | undefined;
  render: RenderState | undefined;
  busy: boolean;
  onPatch: (patch: Partial<UploadItem>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onPreview: () => void;
  onPublish: () => void;
}

function UploadItemCard(props: UploadItemCardProps) {
  const { item, index, total, clips, status, render, busy } = props;
  const platform = useMemo(() => targetById(item.targetId)?.platform, [item.targetId]);
  const datetimeValue = item.publishAt !== undefined ? msToLocalInput(item.publishAt) : "";

  // 現在設定と生成済みファイルの整合。fresh=最新、stale=設定変更後で要更新。
  const rendering = render?.rendering ?? false;
  const outputPath = render?.outputPath;
  const fresh = outputPath !== undefined && render?.sig === itemSig(item);
  const stale = outputPath !== undefined && render?.sig !== itemSig(item);

  const onDatetimeChange = (value: string) => {
    const ms = localInputToMs(value);
    props.onPatch({ ...(ms !== null ? { publishAt: ms } : { publishAt: undefined }) });
  };

  return (
    <div className="rounded-lg border border-line bg-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium text-neutral-500">#{index + 1}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="上へ"
            disabled={index === 0}
            onClick={() => props.onMove(-1)}
            className="flex h-6 w-6 items-center justify-center rounded border border-line bg-elevated text-neutral-400 hover:text-neutral-100 disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="下へ"
            disabled={index === total - 1}
            onClick={() => props.onMove(1)}
            className="flex h-6 w-6 items-center justify-center rounded border border-line bg-elevated text-neutral-400 hover:text-neutral-100 disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            aria-label="削除"
            onClick={props.onRemove}
            className="flex h-6 w-6 items-center justify-center rounded border border-line bg-elevated text-neutral-500 hover:border-danger hover:text-danger"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
          対象 clip
          <select
            className={selectClass}
            value={item.clipId}
            onChange={(e) => props.onPatch({ clipId: e.target.value })}
          >
            {clips.map((clip) => (
              <option key={clip.id} value={clip.id}>
                {clip.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
          出力ターゲット
          <select
            className={selectClass}
            value={item.targetId}
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
            value={item.fit}
            onChange={(e) => props.onPatch({ fit: e.target.value as FitMode })}
          >
            {FIT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-2 flex flex-col gap-2">
        {platform === "youtube" ? (
          <>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
              タイトル
              <input
                type="text"
                className={cn(inputClass, "w-full")}
                value={item.title}
                onChange={(e) => props.onPatch({ title: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
              説明
              <textarea
                className={textareaClass}
                value={item.description}
                onChange={(e) => props.onPatch({ description: e.target.value })}
              />
            </label>
          </>
        ) : (
          <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
            キャプション
            <textarea
              className={textareaClass}
              maxLength={2200}
              value={item.caption}
              onChange={(e) => props.onPatch({ caption: e.target.value })}
            />
          </label>
        )}

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

      {/* 最終プレビュー + ダウンロード */}
      <div className="mt-3 flex flex-col gap-2 rounded-md border border-line bg-elevated/40 p-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-neutral-400">
            最終プレビュー
            {stale && <span className="ml-1.5 text-amber-400">(設定変更あり・要更新)</span>}
          </span>
          <div className="flex items-center gap-2">
            {fresh && outputPath && (
              <a
                href={fileDownloadUrl(outputPath)}
                download
                className="text-[11px] text-accent hover:underline"
              >
                ダウンロード
              </a>
            )}
            <Button variant="ghost" size="sm" onClick={props.onPreview} disabled={rendering || busy}>
              {rendering ? "生成中…" : outputPath ? "プレビュー更新" : "プレビュー生成"}
            </Button>
          </div>
        </div>
        {outputPath ? (
          <video
            src={fileRawUrl(outputPath)}
            controls
            className={cn(
              "max-h-48 w-full rounded bg-black",
              stale && "opacity-60",
            )}
          />
        ) : (
          <p className="py-2 text-center text-[11px] text-neutral-600">
            「プレビュー生成」で最終アスペクト・フィットを確認できます。
          </p>
        )}
        {render?.error && <p className="text-[11px] text-danger">{render.error}</p>}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <StatusBadge status={status} />
        <Button
          variant="primary"
          size="sm"
          onClick={props.onPublish}
          disabled={busy}
        >
          投稿
        </Button>
      </div>
    </div>
  );
}

// ---- ステータス表示 ---------------------------------------------------------

function StatusBadge({ status }: { status: UploadStatus | undefined }) {
  const kind = status?.kind ?? "idle";
  const label: Record<UploadStatusKind, string> = {
    idle: "未投稿",
    rendering: "レンダリング中…",
    publishing: "投稿中…",
    success: "完了",
    error: "エラー",
  };
  const tone: Record<UploadStatusKind, string> = {
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
