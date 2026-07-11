import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Trim } from "@facet/core";
import { clamp, formatTime } from "../../lib/format";

/** ハンドルのキーボード操作 1 回あたりの移動量(秒)。Shift 併用で粗く動かす。 */
const KEY_STEP_FINE = 0.1;
const KEY_STEP_COARSE = 1;

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
	/** ハンドルのドラッグ完了時。確定したトリムを渡す(プレビュー再生に使う)。 */
	onHandleRelease?: (handle: Handle, trim: Trim) => void;
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
	onHandleRelease,
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

			// ドラッグ中に確定した最新トリムを保持し、release 時に親へ渡す。
			let lastTrim: Trim = { start, end };
			const move = (ev: PointerEvent) => {
				const secs = pxToSeconds(ev.clientX);
				lastTrim =
					handle === "start"
						? { start: clamp(secs, 0, end - 0.05), end }
						: { start, end: clamp(secs, start + 0.05, duration) };
				onChange(lastTrim);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				onHandleRelease?.(handle, lastTrim);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[disabled, duration, end, start, onChange, onHandleRelease, pxToSeconds],
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

			<div className="flex flex-col gap-1.5">
				{/* 再生バー: シーク + トリム範囲の可視化 + 再生ヘッド。
				    トリムハンドルは重ならないよう下のレーンへ分離している。 */}
				<div
					ref={trackRef}
					className="relative h-8 w-full rounded-md bg-elevated"
					onPointerDown={(e) => {
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
				</div>

				{/* トリムハンドルレーン: 再生ヘッドと同一線上に重なると紛らわしいため
				    再生バーの下に分離する。クリック当たり判定も再生バーとは独立する。 */}
				<div className="relative h-6 w-full">
					{/* start ハンドル */}
					<Handle
						label="開始点"
						pct={startPct}
						seconds={start}
						min={0}
						max={end - 0.05}
						onPointerDown={beginDrag("start")}
						onKeyCommit={(v) => onChange({ start: v, end })}
						disabled={disabled}
					/>
					{/* end ハンドル */}
					<Handle
						label="終了点"
						pct={endPct}
						seconds={end}
						min={start + 0.05}
						max={duration}
						onPointerDown={beginDrag("end")}
						onKeyCommit={(v) => onChange({ start, end: v })}
						disabled={disabled}
					/>
				</div>
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
	label,
	pct,
	seconds,
	min,
	max,
	onPointerDown,
	onKeyCommit,
	disabled,
}: {
	label: string;
	pct: number;
	seconds: number;
	min: number;
	max: number;
	onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
	/** キーボード操作で確定した秒。 */
	onKeyCommit: (seconds: number) => void;
	disabled: boolean;
}) {
	return (
		<div
			role="slider"
			aria-label={label}
			aria-valuenow={Number(seconds.toFixed(2))}
			aria-valuemin={Number(min.toFixed(2))}
			aria-valuemax={Number(max.toFixed(2))}
			aria-valuetext={formatTime(seconds)}
			tabIndex={disabled ? -1 : 0}
			className={
				"absolute top-1/2 z-10 h-5 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-accent bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 " +
				(disabled
					? "cursor-not-allowed opacity-40"
					: "cursor-ew-resize hover:bg-accent-hover")
			}
			style={{ left: `${pct}%` }}
			onPointerDown={(e) => {
				e.stopPropagation();
				onPointerDown(e);
			}}
			onKeyDown={(e) => {
				if (disabled) return;
				const step = e.shiftKey ? KEY_STEP_COARSE : KEY_STEP_FINE;
				let next: number;
				switch (e.key) {
					case "ArrowLeft":
					case "ArrowDown":
						next = seconds - step;
						break;
					case "ArrowRight":
					case "ArrowUp":
						next = seconds + step;
						break;
					case "Home":
						next = min;
						break;
					case "End":
						next = max;
						break;
					default:
						return;
				}
				e.preventDefault();
				onKeyCommit(clamp(next, min, max));
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
	// 打鍵ごとに clamp すると途中値を打てないため、ローカルに保持し blur/Enter で確定する。
	const canonical = () => String(Number(value.toFixed(2)));
	const [text, setText] = useState(canonical);
	const [editing, setEditing] = useState(false);

	// 外部から値が変わったら(編集中でなければ)表示へ反映する。
	// biome-ignore lint/correctness/useExhaustiveDependencies: canonical は value から導出され value 変化のみで再評価すればよい
	useEffect(() => {
		if (!editing) setText(canonical());
	}, [value, editing]);

	const commit = () => {
		const v = Number(text);
		if (text.trim() !== "" && Number.isFinite(v)) onCommit(clamp(v, min, max));
		setText(canonical());
		setEditing(false);
	};

	return (
		<label className="flex items-center gap-1.5">
			<span className="text-neutral-400">{label}</span>
			<input
				type="number"
				step={0.1}
				min={min}
				max={max}
				value={text}
				disabled={disabled}
				onFocus={() => setEditing(true)}
				onChange={(e) => setText(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
						e.currentTarget.blur();
					} else if (e.key === "Escape") {
						setText(canonical());
						setEditing(false);
						e.currentTarget.blur();
					}
				}}
				className="w-20 rounded border border-line bg-panel px-2 py-1 font-mono tabular-nums text-neutral-200 outline-none focus:border-accent disabled:opacity-40"
			/>
			<span className="text-neutral-500">s</span>
		</label>
	);
}
