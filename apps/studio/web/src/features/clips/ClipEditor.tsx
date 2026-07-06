import { useCallback, useRef, useState } from "react";
import type { CropRect, Trim } from "@facet/core";
import type { ProbeResult } from "../../lib/api";
import type { Clip } from "../../types";
import { ASPECT_TEMPLATES, aspectRatio } from "../../types";
import { formatTime } from "../../lib/format";
import { Timeline } from "../timeline/Timeline";
import { CropOverlay } from "../crop-overlay/CropOverlay";
import { Card } from "../../components/ui/Card";
import { cn } from "../../components/ui/cn";

/** 終了バーのプレビューで、終了点の手前から再生する秒数。 */
const PREVIEW_LEAD_SECONDS = 5;

/** クロップ未指定時に表示する全体矩形。 */
const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/** 全体矩形かどうか(=undefined へ正規化してよいか)。 */
function isFullCrop(c: CropRect): boolean {
	return c.x <= 0 && c.y <= 0 && c.width >= 1 && c.height >= 1;
}

interface ClipEditorProps {
	clip: Clip;
	probe: ProbeResult;
	onChange: (clip: Clip) => void;
}

/**
 * 選択中の Clip を編集する。
 * プレビューに CropOverlay を重ね、アスペクト比テンプレートでクロップ枠の形を選び、
 * Timeline で見せる時間範囲(trim)を決める。メタデータや最終アスペクトは UPLOAD 側。
 */
export function ClipEditor({ clip, probe, onChange }: ClipEditorProps) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [currentTime, setCurrentTime] = useState(0);
	const [playing, setPlaying] = useState(false);
	const stopAtRef = useRef<number | null>(null);

	const crop = clip.crop ?? FULL_CROP;
	const ratio = aspectRatio(clip.aspect);
	const snap = clip.aspect !== "free";

	const handleCropChange = useCallback(
		(next: CropRect) => {
			onChange({ ...clip, crop: isFullCrop(next) ? undefined : next });
		},
		[clip, onChange],
	);

	const onSeek = useCallback((seconds: number) => {
		const v = videoRef.current;
		if (v) {
			stopAtRef.current = null;
			v.currentTime = seconds;
			setCurrentTime(seconds);
		}
	}, []);

	const previewSegment = useCallback((fromSec: number, stopSec: number) => {
		const v = videoRef.current;
		if (!v) return;
		stopAtRef.current = stopSec;
		v.currentTime = fromSec;
		setCurrentTime(fromSec);
		void v.play();
	}, []);

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
			stopAtRef.current = null;
			void v.play();
		} else {
			v.pause();
		}
	}, []);

	return (
		<div className="flex min-h-0 flex-col gap-3">
			{/* プレビュー + クロップ枠 */}
			<div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-line bg-black/60 p-2">
				<div className="relative inline-block max-h-full max-w-full">
					{/* biome-ignore lint/a11y/useMediaCaption: ユーザー生成動画のプレビューで字幕データが存在しない */}
					<video
						ref={videoRef}
						src={probe.url}
						onTimeUpdate={(e) => {
							const v = e.currentTarget;
							setCurrentTime(v.currentTime);
							if (
								stopAtRef.current !== null &&
								v.currentTime >= stopAtRef.current
							) {
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
						aspect={ratio ?? undefined}
						snap={snap}
					/>
				</div>
			</div>

			{/* プレビュー操作 + クロップ比テンプレート */}
			<div className="flex items-center justify-between gap-3 px-1">
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={togglePlay}
						aria-label={playing ? "一時停止" : "再生"}
						className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-elevated text-neutral-200 hover:border-accent hover:text-accent"
					>
						{playing ? (
							<svg
								width="12"
								height="12"
								viewBox="0 0 12 12"
								fill="currentColor"
								aria-hidden="true"
							>
								<rect x="2" y="1.5" width="3" height="9" rx="0.5" />
								<rect x="7" y="1.5" width="3" height="9" rx="0.5" />
							</svg>
						) : (
							<svg
								width="12"
								height="12"
								viewBox="0 0 12 12"
								fill="currentColor"
								aria-hidden="true"
							>
								<path d="M3 1.8v8.4a.5.5 0 0 0 .77.42l6.5-4.2a.5.5 0 0 0 0-.84l-6.5-4.2A.5.5 0 0 0 3 1.8Z" />
							</svg>
						)}
					</button>
					<span className="font-mono text-xs tabular-nums text-neutral-400">
						{formatTime(currentTime)} / {formatTime(probe.duration)}
					</span>
				</div>

				{/* クロップ比テンプレート */}
				<div className="flex items-center gap-1.5">
					<span className="text-[11px] text-neutral-500">クロップ比</span>
					<div className="flex items-center gap-1">
						{ASPECT_TEMPLATES.map((t) => (
							<button
								key={t.value}
								type="button"
								onClick={() => onChange({ ...clip, aspect: t.value })}
								className={cn(
									"rounded px-2 py-1 text-[11px] font-medium",
									clip.aspect === t.value
										? "bg-accent text-white"
										: "border border-line bg-panel text-neutral-400 hover:border-accent",
								)}
							>
								{t.label}
							</button>
						))}
					</div>
				</div>
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
		</div>
	);
}
