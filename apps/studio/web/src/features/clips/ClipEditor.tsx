import { useCallback, useRef, useState } from "react";
import type { CropRect } from "@reframe/core";
import type { ProbeResult } from "../../lib/api";
import type { Clip, VariantKind } from "../../types";
import { aspectForVariant } from "../../types";
import { Timeline } from "../timeline/Timeline";
import { CropOverlay } from "../crop-overlay/CropOverlay";
import { Card } from "../../components/ui/Card";

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
  // 注目領域は自由選択が既定。スナップは任意で有効化する。
  const [snapCrop, setSnapCrop] = useState(false);

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
      v.currentTime = seconds;
      setCurrentTime(seconds);
    }
  }, []);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* プレビュー + クロップ枠 */}
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-line bg-black/60">
        <div className="relative inline-block max-h-full max-w-full">
          <video
            ref={videoRef}
            src={probe.url}
            controls
            onTimeUpdate={(e) =>
              setCurrentTime((e.target as HTMLVideoElement).currentTime)
            }
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

      {/* クロップ補助トグル */}
      <div className="flex items-center justify-end px-1">
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={snapCrop}
            onChange={(e) => setSnapCrop(e.target.checked)}
            className="accent-accent"
          />
          注目領域をバリアント比にスナップ
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
