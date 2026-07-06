import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CropRect } from "@facet/core";
import { clamp } from "../../lib/format";

/** crop を目標比(正規化空間の w/h)へ合わせる。中心を保ちつつ境界内に収める。 */
function snapRectToRatio(c: CropRect, targetNormRatio: number): CropRect {
	const cx = c.x + c.width / 2;
	const cy = c.y + c.height / 2;
	let w = c.width;
	let h = w / targetNormRatio;
	if (h > 1) {
		h = 1;
		w = h * targetNormRatio;
	}
	if (w > 1) {
		w = 1;
		h = w / targetNormRatio;
	}
	w = clamp(w, 0.05, 1);
	h = clamp(h, 0.05, 1);
	const x = clamp(cx - w / 2, 0, 1 - w);
	const y = clamp(cy - h / 2, 0, 1 - h);
	return { x, y, width: w, height: h };
}

interface CropOverlayProps {
	/** 現在のクロップ矩形(0..1 正規化)。 */
	crop: CropRect;
	onChange: (crop: CropRect) => void;
	/**
	 * スナップ対象のアスペクト比(width/height)。指定時はリサイズ結果を
	 * この比率へ合わせる。プリセット選択と連動させる。
	 */
	aspect?: number;
	/** スナップの有効/無効。 */
	snap?: boolean;
}

/** 四隅ハンドルの識別子。 */
type Corner = "nw" | "ne" | "sw" | "se";

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

/**
 * <video> の上に絶対配置で重ねるクロップ枠。
 * - 矩形は 0..1 正規化。親コンテナ(video ラッパ)いっぱいに広がる前提。
 * - 移動(枠内ドラッグ)とリサイズ(四隅)を pointer capture で処理。
 * - aspect+snap 指定時はリサイズ後に比率を強制する。
 * 表示のみを担い、値は親に返す。
 */
export function CropOverlay({
	crop,
	onChange,
	aspect,
	snap,
}: CropOverlayProps) {
	const containerRef = useRef<HTMLDivElement>(null);

	// クライアント座標差分を正規化差分へ変換する。
	const toNorm = useCallback((dxPx: number, dyPx: number) => {
		const el = containerRef.current;
		if (!el) return { dx: 0, dy: 0 };
		const rect = el.getBoundingClientRect();
		return { dx: dxPx / rect.width, dy: dyPx / rect.height };
	}, []);

	const containerAspectRatio = useCallback(() => {
		const el = containerRef.current;
		if (!el) return 1;
		const rect = el.getBoundingClientRect();
		return rect.width / rect.height;
	}, []);

	// 最新の crop / onChange を ref で保持(スナップ effect の再実行を snap/aspect 変化のみに限定するため)。
	const cropRef = useRef(crop);
	cropRef.current = crop;
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	// スナップ ON(または対象比変更)時に、現在の枠を即座に比率へ合わせる。
	// さらに、動画メタデータ読込などでコンテナ寸法が確定/変化したときにも再スナップする。
	// (初回 effect 実行時点では <video> 未ロードでコンテナ比が正しくない場合があるため。)
	useEffect(() => {
		if (!snap || !aspect || aspect <= 0) return;
		const el = containerRef.current;
		if (!el) return;

		const applySnap = () => {
			const target = aspect / containerAspectRatio();
			if (!Number.isFinite(target) || target <= 0) return;
			const c = cropRef.current;
			const snapped = snapRectToRatio(c, target);
			const changed =
				Math.abs(snapped.x - c.x) > 0.001 ||
				Math.abs(snapped.y - c.y) > 0.001 ||
				Math.abs(snapped.width - c.width) > 0.001 ||
				Math.abs(snapped.height - c.height) > 0.001;
			if (changed) onChangeRef.current(snapped);
		};

		applySnap();
		// コンテナのリサイズ(=動画ロードで実寸が入る等)で再スナップ。同一比なら冪等で no-op。
		const ro = new ResizeObserver(() => applySnap());
		ro.observe(el);
		return () => ro.disconnect();
	}, [snap, aspect, containerAspectRatio]);

	// 枠全体の移動。矩形サイズは保ったまま位置だけを [0,1] 内に収める。
	const beginMove = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			e.stopPropagation();
			e.currentTarget.setPointerCapture(e.pointerId);
			const startX = e.clientX;
			const startY = e.clientY;
			const orig = crop;

			const move = (ev: PointerEvent) => {
				const { dx, dy } = toNorm(ev.clientX - startX, ev.clientY - startY);
				onChange({
					...orig,
					x: clamp(orig.x + dx, 0, 1 - orig.width),
					y: clamp(orig.y + dy, 0, 1 - orig.height),
				});
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[crop, onChange, toNorm],
	);

	// 四隅リサイズ。固定点(反対の角)を基準にサイズを更新し、必要なら比率をスナップ。
	const beginResize = useCallback(
		(corner: Corner) => (e: ReactPointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			e.stopPropagation();
			e.currentTarget.setPointerCapture(e.pointerId);
			const orig = crop;
			// 固定される反対側の角(正規化)。
			const anchorX =
				corner === "nw" || corner === "sw" ? orig.x + orig.width : orig.x;
			const anchorY =
				corner === "nw" || corner === "ne" ? orig.y + orig.height : orig.y;

			const move = (ev: PointerEvent) => {
				const el = containerRef.current;
				if (!el) return;
				const rect = el.getBoundingClientRect();
				const px = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
				const py = clamp((ev.clientY - rect.top) / rect.height, 0, 1);

				let x = Math.min(px, anchorX);
				let y = Math.min(py, anchorY);
				let w = Math.abs(px - anchorX);
				let h = Math.abs(py - anchorY);

				// 比率スナップ: コンテナのアスペクトを考慮して正規化空間の比へ変換する。
				// 目標: (w * containerW) / (h * containerH) === aspect
				//   → w/h === aspect / containerAspect
				if (snap && aspect && aspect > 0) {
					const targetNormRatio = aspect / containerAspectRatio();
					// 幅基準で高さを決め、固定角側から伸ばす。
					h = w / targetNormRatio;
					// はみ出す場合は高さ基準に切り替える。
					if (h > 1) {
						h = 1;
						w = h * targetNormRatio;
					}
					// アンカーからの向きに応じて原点を再計算。
					x = corner === "nw" || corner === "sw" ? anchorX - w : anchorX;
					y = corner === "nw" || corner === "ne" ? anchorY - h : anchorY;
				}

				// 最小サイズと境界を保証。
				const minW = 0.05;
				const minH = 0.05;
				w = clamp(w, minW, 1);
				h = clamp(h, minH, 1);
				x = clamp(x, 0, 1 - w);
				y = clamp(y, 0, 1 - h);

				onChange({ x, y, width: w, height: h });
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[crop, onChange, snap, aspect, containerAspectRatio],
	);

	return (
		<div ref={containerRef} className="pointer-events-none absolute inset-0">
			{/* 外側の暗幕(4 分割で crop 矩形をくり抜く) */}
			<Scrim crop={crop} />

			{/* crop 矩形本体 */}
			<div
				className="pointer-events-auto absolute cursor-move ring-1 ring-white/80"
				style={{
					left: `${crop.x * 100}%`,
					top: `${crop.y * 100}%`,
					width: `${crop.width * 100}%`,
					height: `${crop.height * 100}%`,
				}}
				onPointerDown={beginMove}
			>
				{/* 三分割ガイド */}
				<div className="pointer-events-none absolute inset-0">
					<div className="absolute left-1/3 top-0 h-full w-px bg-white/25" />
					<div className="absolute left-2/3 top-0 h-full w-px bg-white/25" />
					<div className="absolute top-1/3 left-0 h-px w-full bg-white/25" />
					<div className="absolute top-2/3 left-0 h-px w-full bg-white/25" />
				</div>

				{/* 四隅ハンドル */}
				{CORNERS.map((c) => (
					<div
						key={c}
						onPointerDown={beginResize(c)}
						className={
							"absolute h-3 w-3 rounded-sm border border-neutral-900 bg-white " +
							cornerClass(c)
						}
					/>
				))}
			</div>
		</div>
	);
}

/** crop 外側を暗くする 4 枚の帯。 */
function Scrim({ crop }: { crop: CropRect }) {
	const box = "pointer-events-none absolute bg-black/50";
	return (
		<>
			<div
				className={box}
				style={{ left: 0, right: 0, top: 0, height: `${crop.y * 100}%` }}
			/>
			<div
				className={box}
				style={{
					left: 0,
					right: 0,
					top: `${(crop.y + crop.height) * 100}%`,
					bottom: 0,
				}}
			/>
			<div
				className={box}
				style={{
					left: 0,
					width: `${crop.x * 100}%`,
					top: `${crop.y * 100}%`,
					height: `${crop.height * 100}%`,
				}}
			/>
			<div
				className={box}
				style={{
					right: 0,
					width: `${(1 - crop.x - crop.width) * 100}%`,
					top: `${crop.y * 100}%`,
					height: `${crop.height * 100}%`,
				}}
			/>
		</>
	);
}

function cornerClass(c: Corner): string {
	switch (c) {
		case "nw":
			return "-left-1.5 -top-1.5 cursor-nwse-resize";
		case "ne":
			return "-right-1.5 -top-1.5 cursor-nesw-resize";
		case "sw":
			return "-left-1.5 -bottom-1.5 cursor-nesw-resize";
		case "se":
			return "-right-1.5 -bottom-1.5 cursor-nwse-resize";
	}
}
