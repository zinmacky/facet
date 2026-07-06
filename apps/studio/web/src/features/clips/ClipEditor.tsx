import { useCallback, useRef, useState } from "react";
import type { CropRect, Trim } from "@reframe/core";
import type { ProbeResult } from "../../lib/api";
import type { Clip, VariantKind } from "../../types";
import { aspectForVariant } from "../../types";
import { formatTime } from "../../lib/format";
import { Timeline } from "../timeline/Timeline";
import { CropOverlay } from "../crop-overlay/CropOverlay";
import { Card } from "../../components/ui/Card";

/** 終了バーのプレビューで、終了点の手前から再生する秒数。 */
const PREVIEW_LEAD_SECONDS = 5;

interface ClipEditorProps {
  clip: Clip;
  probe: ProbeResult;
  onChange: (clip: Clip) => void;
}

/** クロップ未指定時に表示する全体矩形。 */
const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/** 全体矩形かどうか(=undefined へ正規化してよいか)。 */
function isFullCrop(c: CropRect): boolean {
  return c.x <= 0 && c.y <= 0 && c.width >= 1 && c.height >= 1;
}

/** 有効なバリアントのうち先頭を返す(crop のスナップ比に使う)。 */
function firstActiveVariant(clip: Clip): VariantKind {
  return clip.variants.short ? "short" : "insta";
}

/**
 * 選択中の Clip を編集する。
 * プレビュー(video)に CropOverlay を重ね、Timeline で trim を、
 * 下段フォームで有効バリアントに応じた公開メタデータを編集する。
 */
export function ClipEditor({ clip, probe, onChange }: ClipEditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  // 注目領域は自由選択が既定。スナップは任意で有効化する。
  const [snapCrop, setSnapCrop] = useState(false);
  // 区間プレビュー中の自動停止位置(秒)。手動再生中は null。
  const stopAtRef = useRef<number | null>(null);

  const crop = clip.crop ?? FULL_CROP;
  const aspect = aspectForVariant(firstActiveVariant(clip));

  // crop 変更。全体矩形は undefined に正規化して保存する。
  const handleCropChange = useCallback(
    (next: CropRect) => {
      onChange({ ...clip, crop: isFullCrop(next) ? undefined : next });
    },
    [clip, onChange],
  );

  const onSeek = useCallback((seconds: number) => {
    const v = videoRef.current;
    if (v) {
      // トラッククリックでのシークは区間プレビューを解除する。
      stopAtRef.current = null;
      v.currentTime = seconds;
      setCurrentTime(seconds);
    }
  }, []);

  // 指定位置から再生し、stopAt に達したら自動停止する(区間プレビュー)。
  const previewSegment = useCallback((fromSec: number, stopSec: number) => {
    const v = videoRef.current;
    if (!v) return;
    stopAtRef.current = stopSec;
    v.currentTime = fromSec;
    setCurrentTime(fromSec);
    void v.play();
  }, []);

  // ハンドルのドラッグ完了 → プレビュー再生。
  // 開始バー: その位置から。終了バー: 5秒前(開始未満なら開始位置)から。いずれも終了点で停止。
  const handleHandleRelease = useCallback(
    (handle: "start" | "end", trim: Trim) => {
      const from =
        handle === "start"
          ? trim.start
          : Math.max(trim.start, trim.end - PREVIEW_LEAD_SECONDS);
      previewSegment(from, trim.end);
    },
    [previewSegment],
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      stopAtRef.current = null; // 手動再生は自動停止しない。
      void v.play();
    } else {
      v.pause();
    }
  }, []);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* プレビュー + クロップ枠(min-w-0 + overflow-hidden で枠内に確実に収める) */}
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-line bg-black/60 p-2">
        <div className="relative inline-block max-h-full max-w-full">
          {/* ネイティブ controls は使わない(シークは Timeline、再生は下のボタン)。
              クロップ枠が全面を覆うため、動画上の操作系は載せない。 */}
          <video
            ref={videoRef}
            src={probe.url}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              setCurrentTime(v.currentTime);
              if (stopAtRef.current !== null && v.currentTime >= stopAtRef.current) {
                v.pause();
                stopAtRef.current = null;
              }
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            className="block max-h-[52vh] max-w-full rounded"
          />
          <CropOverlay
            crop={crop}
            onChange={handleCropChange}
            aspect={aspect}
            snap={snapCrop}
          />
        </div>
      </div>

      {/* プレビュー操作: 再生/一時停止 + 時刻 と クロップ補助トグル */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "一時停止" : "再生"}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-elevated text-neutral-200 hover:border-accent hover:text-accent"
          >
            {playing ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
                <rect x="2" y="1.5" width="3" height="9" rx="0.5" />
                <rect x="7" y="1.5" width="3" height="9" rx="0.5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
                <path d="M3 1.8v8.4a.5.5 0 0 0 .77.42l6.5-4.2a.5.5 0 0 0 0-.84l-6.5-4.2A.5.5 0 0 0 3 1.8Z" />
              </svg>
            )}
          </button>
          <span className="font-mono text-xs tabular-nums text-neutral-400">
            {formatTime(currentTime)} / {formatTime(probe.duration)}
          </span>
        </div>
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={snapCrop}
            onChange={(e) => setSnapCrop(e.target.checked)}
            className="accent-accent"
          />
          切り抜き枠を仕上がりの形(9:16など)に合わせる
        </label>
      </div>

      {/* タイムライン */}
      <Card title="Timeline" className="shrink-0">
        <Timeline
          duration={probe.duration}
          trim={clip.trim}
          currentTime={currentTime}
          onChange={(trim) => onChange({ ...clip, trim })}
          onSeek={onSeek}
          onHandleRelease={handleHandleRelease}
        />
      </Card>

      {/* 公開メタデータ */}
      <Card title="公開メタデータ" className="shrink-0">
        <div className="flex flex-col gap-4 p-3">
          {clip.variants.short && (
            <section className="flex flex-col gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                YouTube(ショート 9:16)
              </span>
              <input
                value={clip.youtube.title}
                onChange={(e) =>
                  onChange({
                    ...clip,
                    youtube: { ...clip.youtube, title: e.target.value },
                  })
                }
                placeholder="タイトル"
                className="rounded border border-line bg-panel px-2 py-1 text-xs text-neutral-200 outline-none focus:border-accent"
              />
              <textarea
                value={clip.youtube.description}
                onChange={(e) =>
                  onChange({
                    ...clip,
                    youtube: { ...clip.youtube, description: e.target.value },
                  })
                }
                placeholder="説明文"
                rows={3}
                className="resize-none rounded border border-line bg-panel px-2 py-1 text-xs text-neutral-200 outline-none focus:border-accent"
              />
            </section>
          )}

          {clip.variants.insta && (
            <section className="flex flex-col gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                Instagram(insta 1:1)
              </span>
              <textarea
                value={clip.instagram.caption}
                onChange={(e) =>
                  onChange({
                    ...clip,
                    instagram: { caption: e.target.value },
                  })
                }
                placeholder="キャプション"
                rows={3}
                maxLength={2200}
                className="resize-none rounded border border-line bg-panel px-2 py-1 text-xs text-neutral-200 outline-none focus:border-accent"
              />
              <span className="self-end font-mono text-[10px] text-neutral-600">
                {clip.instagram.caption.length}/2200
              </span>
            </section>
          )}
        </div>
      </Card>
    </div>
  );
}
