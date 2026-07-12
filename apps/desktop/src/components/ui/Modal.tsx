import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";
import { CloseIcon } from "./icons";

/**
 * 開いているモーダルのスタック。Esc は最前面(スタック末尾)のモーダルだけが処理する。
 * 確認ダイアログを別モーダルの上に重ねたとき、Esc で下のモーダルまで閉じるのを防ぐ。
 */
const modalStack: symbol[] = [];

/** フォーカストラップ対象とみなす要素の CSS セレクタ(無効化されたものは除く)。 */
const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** container 内のフォーカス可能な要素を DOM 順で返す。 */
function getFocusable(container: HTMLElement | null): HTMLElement[] {
	if (!container) return [];
	return Array.from(
		container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
	);
}

interface ModalProps {
	open: boolean;
	title: ReactNode;
	onClose: () => void;
	children: ReactNode;
	/** 下部の操作行(ボタンなど)。 */
	footer?: ReactNode;
	/** パネル幅。既定 max-w-3xl。 */
	widthClass?: string;
	/**
	 * 本文をスクロールさせるか。既定 true。
	 * false のとき本文は overflow-hidden になり、子側でブロックごとにスクロールを制御する。
	 */
	scrollBody?: boolean;
	/**
	 * Esc / オーバーレイクリック / ✕ で閉じられるか。既定 true。
	 * 処理中(投稿・レンダリング等)は false にして誤操作での中断を防ぐ。
	 */
	dismissable?: boolean;
}

/**
 * 中央配置のモーダルダイアログ。
 * オーバーレイクリック / Esc で閉じる。ヘッダ・スクロール本文・任意フッタ。
 */
export function Modal({
	open,
	title,
	onClose,
	children,
	footer,
	widthClass = "max-w-3xl",
	scrollBody = true,
	dismissable = true,
}: ModalProps) {
	// モーダルのパネル要素(フォーカストラップの境界)。
	const panelRef = useRef<HTMLDivElement>(null);
	// 開く直前にフォーカスされていた要素。閉じたときにここへフォーカスを戻す。
	const triggerRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!open) return;
		// 開いている間だけスタックへ登録(dismissable でなくても重なり順の管理には積む)。
		const id = Symbol("modal");
		modalStack.push(id);
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || !dismissable) return;
			// 最前面のモーダルのみ Esc を処理する。
			if (modalStack[modalStack.length - 1] !== id) return;
			onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => {
			const i = modalStack.indexOf(id);
			if (i !== -1) modalStack.splice(i, 1);
			window.removeEventListener("keydown", onKey);
		};
	}, [open, dismissable, onClose]);

	// フォーカストラップ: 開いたら最初のフォーカス可能要素へフォーカスし、Tab/Shift+Tab は
	// パネル内でループさせる(パネル外へフォーカスが漏れない)。閉じたら開く直前に
	// フォーカスされていたトリガー要素へフォーカスを戻す。
	// このモーダル自身の panelRef 配下でのみ keydown を拾うため、確認ダイアログのように
	// 別モーダルの上に重ねて開いた場合でも、それぞれ独立して自分のパネル内だけをトラップする
	// (イベントはフォーカス中の要素からその祖先へしかバブルしないため、重ならない)。
	useEffect(() => {
		if (!open) return;
		triggerRef.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;

		const panel = panelRef.current;
		const first = getFocusable(panel)[0] ?? panel;
		first?.focus();

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Tab") return;
			const focusables = getFocusable(panelRef.current);
			if (focusables.length === 0) {
				e.preventDefault();
				return;
			}
			const firstEl = focusables[0];
			const lastEl = focusables[focusables.length - 1];
			const active = document.activeElement;
			if (e.shiftKey) {
				if (active === firstEl || !panelRef.current?.contains(active)) {
					e.preventDefault();
					lastEl?.focus();
				}
			} else if (active === lastEl || !panelRef.current?.contains(active)) {
				e.preventDefault();
				firstEl?.focus();
			}
		};
		panel?.addEventListener("keydown", onKeyDown);

		return () => {
			panel?.removeEventListener("keydown", onKeyDown);
			triggerRef.current?.focus();
		};
	}, [open]);

	if (!open) return null;
	// document.body へ portal する。WizardShell が各画面を transform 付きの
	// スライドトラック(+ 外側 overflow-hidden)内にマウントするため、素の
	// position: fixed のままだとその transform 祖先が containing block になり、
	// viewport 基準の配置が崩れて overflow-hidden にクリップされ不可視になる
	// (CSS 仕様: transform を持つ要素は fixed 位置指定の containing block になる)。
	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center p-4"
			role="dialog"
			aria-modal="true"
		>
			<button
				type="button"
				aria-label="閉じる"
				disabled={!dismissable}
				className="absolute inset-0 bg-black/70 disabled:cursor-default"
				onClick={onClose}
			/>
			<div
				ref={panelRef}
				tabIndex={-1}
				className={cn(
					"relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl focus:outline-none",
					widthClass,
				)}
			>
				<header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
					<h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
					<button
						type="button"
						onClick={onClose}
						disabled={!dismissable}
						aria-label="閉じる"
						className="rounded p-1.5 text-neutral-400 hover:bg-elevated hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-30"
					>
						<CloseIcon size={14} />
					</button>
				</header>
				<div
					className={cn(
						"min-h-0 flex-1 p-4",
						scrollBody ? "overflow-y-auto" : "flex flex-col overflow-hidden",
					)}
				>
					{children}
				</div>
				{footer && (
					<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
						{footer}
					</footer>
				)}
			</div>
		</div>,
		document.body,
	);
}
