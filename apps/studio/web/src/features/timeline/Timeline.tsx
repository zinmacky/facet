import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Trim } from "@reframe/core";
import { clamp, formatTime } from "../../lib/format";

interface TimelineProps {
  /** ソース総尺(秒)。0 のときは無効表示。 */
  duration: number;
  /** 現在のトリム。未設定時は全体扱い。 */
  trim: Trim | undefined;
  /** 現在の再生位置(秒)。 */
  currentTime: number;
  onChange: (trim: Trim) => void;
  /** トラッククリックでシークしたいとき。 */
  onSeek?: (seconds: number) => void;
}

type Handle = "start" | "end";

/**
 * イン/アウト点ピッカー。
 * - 表示と純粋な値変換のみを担い、EditSpec は親が保持する(状態と表示の分離)。
 * - ハンドルは pointer capture でドラッグ、数値入力でも同じ onChange を呼ぶ。
 */
export function Timeline({
  duration,
  trim,
  currentTime,
  onChange,
  onSeek,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const start = trim?.start ?? 0;
  const end = trim?.end ?? duration;
  const disabled = duration <= 0;

  // トラック内の clientX を秒へ変換する。
  const pxToSeconds = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el || duration <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return ratio * duration;
    },
    [duration],
  );

  // ハンドルのドラッグ。start は end を、end は start をそれぞれ越えない。
  const beginDrag = useCallback(
    (handle: Handle) => (e: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);

      const move = (ev: PointerEvent) => {
        const secs = pxToSeconds(ev.clientX);
        if (handle === "start") {
          onChange({ start: clamp(secs, 0, end - 0.05), end });
        } else {
          onChange({ start, end: clamp(secs, start + 0.05, duration) });
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [disabled, duration, end, start, onChange, pxToSeconds],
  );

  const startPct = duration > 0 ? (start / duration) * 100 : 0;
  const endPct = duration > 0 ? (end / duration) * 100 : 100;
  const playheadPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span className="font-mono tabular-nums text-neutral-300">
          {formatTime(currentTime)}
        </span>
        <span className="font-mono tabular-nums">
          in {formatTime(start)} → out {formatTime(end)}{" "}
          <span className="text-neutral-500">({formatTime(end - start)})</span>
        </span>
        <span className="font-mono tabular-nums text-neutral-500">
          {formatTime(duration)}
        </span>
      </div>

      <div
        ref={trackRef}
        className="relative h-10 w-full rounded-md bg-elevated"
        onPointerDown={(e) => {
          // ハンドル以外を押したらシーク(ハンドルは stopPropagation する)。
          if (!disabled) onSeek?.(pxToSeconds(e.clientX));
        }}
      >
        {/* 選択レンジ */}
        <div
          className="absolute inset-y-0 rounded-md bg-accent/20 ring-1 ring-inset ring-accent/50"
          style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
        />

        {/* トリム外の暗幕 */}
        <div
          className="absolute inset-y-0 left-0 rounded-l-md bg-black/40"
          style={{ width: `${startPct}%` }}
        />
        <div
          className="absolute inset-y-0 right-0 rounded-r-md bg-black/40"
          style={{ width: `${100 - endPct}%` }}
        />

        {/* 再生ヘッド */}
        <div
          className="pointer-events-none absolute inset-y-0 w-px bg-white/80"
          style={{ left: `${clamp(playheadPct, 0, 100)}%` }}
        />

        {/* start ハンドル */}
        <Handle pct={startPct} onPointerDown={beginDrag("start")} disabled={disabled} />
        {/* end ハンドル */}
        <Handle pct={endPct} onPointerDown={beginDrag("end")} disabled={disabled} />
      </div>

      {/* 数値入力(秒) */}
      <div className="flex items-center gap-4 text-xs">
        <SecondsInput
          label="In"
          value={start}
          min={0}
          max={end - 0.05}
          disabled={disabled}
          onCommit={(v) => onChange({ start: v, end })}
        />
        <SecondsInput
          label="Out"
          value={end}
          min={start + 0.05}
          max={duration}
          disabled={disabled}
          onCommit={(v) => onChange({ start, end: v })}
        />
      </div>
    </div>
  );
}

function Handle({
  pct,
  onPointerDown,
  disabled,
}: {
  pct: number;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  disabled: boolean;
}) {
  return (
    <div
      role="slider"
      aria-valuenow={pct}
      className={
        "absolute top-1/2 z-10 h-8 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-accent bg-accent " +
        (disabled ? "cursor-not-allowed opacity-40" : "cursor-ew-resize hover:bg-accent-hover")
      }
      style={{ left: `${pct}%` }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown(e);
      }}
    />
  );
}

function SecondsInput({
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (seconds: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-neutral-500">{label}</span>
      <input
        type="number"
        step={0.1}
        min={min}
        max={max}
        value={Number(value.toFixed(2))}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onCommit(clamp(v, min, max));
        }}
        className="w-20 rounded border border-line bg-panel px-2 py-1 font-mono tabular-nums text-neutral-200 outline-none focus:border-accent disabled:opacity-40"
      />
      <span className="text-neutral-600">s</span>
    </label>
  );
}
