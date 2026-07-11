import { useCallback, useEffect, useRef, useState } from "react";
import type { CropRect, Trim } from "@facet/core";
import type { MediaInfo } from "../../lib/tauri";
import type { Clip } from "../../types";
import { ASPECT_TEMPLATES, aspectRatio } from "../../types";
import { formatTime } from "../../lib/format";
import { Timeline } from "../timeline/Timeline";
import { CropOverlay } from "../crop-overlay/CropOverlay";
import { Card } from "../../components/ui/Card";
import { IconButton } from "../../components/ui/IconButton";
import { PauseIcon, PlayIcon, SpinnerIcon } from "../../components/ui/icons";
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
	probe: MediaInfo;
	/** `convertFileSrc(inputPath)` 済みのソース動画 URL。 */
	videoSrc: string;
	onChange: (clip: Clip) => void;
}

/**
 * 選択中の Clip を編集する。
 * プレビューに CropOverlay を重ね、アスペクト比テンプレートでクロップ枠の形を選び、
 * Timeline で見せる時間範囲(trim)を決める。メタデータや最終アスペクトは UPLOAD 側。
 */
export function ClipEditor({ clip, probe, videoSrc, onChange }: ClipEditorProps) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [currentTime, setCurrentTime] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [videoLoading, setVideoLoading] = useState(true);
	// 動画の読み込み失敗メッセージ。asset プロトコル未許可・破損ファイル等で
	// <video> の load が失敗しても spinner が回り続けるだけで気付けないことがあった
	// ため、明示的にエラーを表示する。
	const [videoError, setVideoError] = useState<string | null>(null);
	const stopAtRef = useRef<number | null>(null);

	// videoSrc(= 選択し直した元動画)が変わったら、前回の読み込みエラー表示をリセットする。
	// biome-ignore lint/correctness/useExhaustiveDependencies: videoSrc は本文で参照しないが再実行のトリガとして意図的に指定
	useEffect(() => {
		setVideoError(null);
		setVideoLoading(true);
	}, [videoSrc]);

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
						src={videoSrc}
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
						onLoadStart={() => setVideoLoading(true)}
						onLoadedData={() => setVideoLoading(false)}
						onWaiting={() => setVideoLoading(true)}
						onPlaying={() => setVideoLoading(false)}
						onCanPlay={() => setVideoLoading(false)}
						onError={(e) => {
							setVideoLoading(false);
							const code = e.currentTarget.error?.code;
							setVideoError(
								`動画の読み込みに失敗しました${code ? `(エラーコード ${code})` : ""}。ファイル形式や読み取り権限を確認してください。`,
							);
						}}
						className="block max-h-[52vh] max-w-full rounded"
					/>
					<CropOverlay
						crop={crop}
						onChange={handleCropChange}
						aspect={ratio ?? undefined}
						snap={snap}
					/>
					{videoError && (
						<div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/70 px-4 text-center text-xs text-danger">
							{videoError}
						</div>
					)}
					{!videoError && videoLoading && (
						<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
							<SpinnerIcon size={28} className="text-neutral-300" />
						</div>
					)}
				</div>
			</div>

			{/* プレビュー操作 + クロップ比テンプレート */}
			<div className="flex items-center justify-between gap-3 px-1">
				<div className="flex items-center gap-3">
					<IconButton
						tone="accent"
						onClick={togglePlay}
						aria-label={playing ? "一時停止" : "再生"}
					>
						{playing ? <PauseIcon /> : <PlayIcon />}
					</IconButton>
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
									"rounded px-2 py-1 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
									clip.aspect === t.value
										? "bg-accent text-white"
										: "border border-line bg-panel text-neutral-300 hover:border-accent",
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
