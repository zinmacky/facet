import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** ヘッダに出すタイトル。省略時はヘッダを描かない。 */
  title?: ReactNode;
  /** タイトル右に置く操作要素。 */
  actions?: ReactNode;
}

/** パネルの基本コンテナ。境界と背景だけを持つ薄いラッパ。 */
export function Card({ title, actions, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-line bg-surface",
        className,
      )}
      {...rest}
    >
      {title !== undefined && (
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            {title}
          </h2>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
