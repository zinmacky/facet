import type { ReactNode } from "react";
import { useEffect } from "react";
import { cn } from "./cn";

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
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div
        className={cn(
          "relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl",
          widthClass,
        )}
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded p-1 text-neutral-400 hover:bg-elevated hover:text-neutral-100"
          >
            ✕
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
    </div>
  );
}
