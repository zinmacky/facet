import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import type { CropRect, Trim } from "@facet/core";
import type { MediaInfo } from "../../lib/tauri";
import type { Clip } from "../../types";
import { ASPECT_TEMPLATES, aspectRatio } from "../../types";
import { formatTime } from "../../lib/format";
import { Timeline } from "../timeline/Timeline";
import { CropOverlay } from "../crop-overlay/CropOverlay";
import { Card } from "../../components/ui/Card";
import { IconButton } from "../../components/ui/IconButton";
import { Slider } from "../../components/ui/Slider";
import {
	PauseIcon,
	PlayIcon,
	SpeakerIcon,
	SpeakerMuteIcon,
	SpinnerIcon,
} from "../../components/ui/icons";
import { cn } from "../../components/ui/cn";

/** 終了バーのプレビューで、終了点の手前から再生する秒数。 */
const PREVIEW_LEAD_SECONDS = 5;

/** クロップ未指定時に表示する全体矩形。 */
const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * 元動画プレーヤーの再生音量(UI 上のプレビュー音量のみ)。
 * クロップ/書き出しされる動画の音声には一切影響しない。セッションを跨いで
 * localStorage へ保持する。
 */
const VOLUME_STORAGE_KEY = "facet.desktop.sourceVolume";
const MUTED_STORAGE_KEY = "facet.desktop.sourceMuted";

/** localStorage から再生音量(0〜1)を読み出す。値が無い/不正なら既定の 1 を返す。 */
function loadStoredVolume(): number {
	if (typeof window === "undefined") return 1;
	const raw = window.localStorage.getItem(VOLUME_STORAGE_KEY);
	const parsed = raw !== null ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
}

/** localStorage からミュート状態を読み出す。 */
function loadStoredMuted(): boolean {
	if (typeof window === "undefined") return false;
	return window.localStorage.getItem(MUTED_STORAGE_KEY) === "1";
}

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

/** 親から命令的に呼べる操作。EXPORT 起動時に再生を止める、など。 */
export interface ClipEditorHandle {
	/** 元動画の再生を停止する(再生中でなければ何もしない)。 */
	pause: () => void;
}

/**
 * 選択中の Clip を編集する。
 * プレビューに CropOverlay を重ね、アスペクト比テンプレートでクロップ枠の形を選び、
 * Timeline で見せる時間範囲(trim)を決める。メタデータや最終アスペクトは UPLOAD 側。
 */
export const ClipEditor = forwardRef<ClipEditorHandle, ClipEditorProps>(
	function ClipEditor({ clip, probe, videoSrc, onChange }, ref) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [currentTime, setCurrentTime] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [videoLoading, setVideoLoading] = useState(true);
	// 動画の読み込み失敗メッセージ。asset プロトコル未許可・破損ファイル等で
	// <video> の load が失敗しても spinner が回り続けるだけで気付けないことがあった
	// ため、明示的にエラーを表示する。
	const [videoError, setVideoError] = useState<string | null>(null);
	const stopAtRef = useRef<number | null>(null);
	// 再生音量(UI プレビュー専用。書き出し音声には影響しない)。
	const [volume, setVolume] = useState(loadStoredVolume);
	const [muted, setMuted] = useState(loadStoredMuted);

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

	// 音量を <video> 要素へ反映(UI プレビュー専用。書き出し音声には影響しない)。
	useEffect(() => {
		const v = videoRef.current;
		if (v) v.volume = volume;
	}, [volume]);

	useEffect(() => {
		const v = videoRef.current;
		if (v) v.muted = muted;
	}, [muted]);

	const handleVolumeChange = useCallback((next: number) => {
		setVolume(next);
		// スライダー操作時はミュートを解除する(一般的なプレーヤーの挙動に合わせる)。
		setMuted(false);
		window.localStorage.setItem(VOLUME_STORAGE_KEY, String(next));
		window.localStorage.setItem(MUTED_STORAGE_KEY, "0");
	}, []);

	const toggleMuted = useCallback(() => {
		setMuted((prev) => {
			const next = !prev;
			window.localStorage.setItem(MUTED_STORAGE_KEY, next ? "1" : "0");
			return next;
		});
	}, []);

	// 親(App)から「エクスポート開始時に再生を止める」ために呼べるようにする。
	useImperativeHandle(
		ref,
		() => ({
			pause: () => {
				videoRef.current?.pause();
			},
		}),
		[],
	);

	const isSilent = muted || volume === 0;

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

					{/* 再生音量(UI プレビュー専用。書き出し音声には影響しない) */}
					<div className="flex items-center gap-1.5">
						<IconButton
							onClick={toggleMuted}
							aria-label={isSilent ? "ミュート解除" : "ミュート"}
							title={isSilent ? "ミュート解除" : "ミュート"}
						>
							{isSilent ? <SpeakerMuteIcon /> : <SpeakerIcon />}
						</IconButton>
						<Slider
							value={isSilent ? 0 : volume}
							min={0}
							max={1}
							step={0.01}
							onValueChange={handleVolumeChange}
							className="w-20"
							aria-label="再生音量"
						/>
					</div>
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
	},
);
