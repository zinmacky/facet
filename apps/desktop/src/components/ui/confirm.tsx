import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useState,
} from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";

/** 確認ダイアログの内容。 */
export interface ConfirmOptions {
	title: string;
	/** 補足本文(任意)。 */
	body?: ReactNode;
	/** 実行ボタンのラベル。既定「OK」。 */
	confirmLabel?: string;
	/** 実行ボタンの色調。破壊的操作は "danger"。既定 "primary"。 */
	tone?: "danger" | "primary";
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** 確認ダイアログを開いて Promise<boolean> を得る。Provider 配下でのみ利用可。 */
export function useConfirm(): ConfirmFn {
	const fn = useContext(ConfirmContext);
	if (!fn)
		throw new Error("useConfirm は ConfirmProvider の配下で使ってください。");
	return fn;
}

interface PendingState {
	options: ConfirmOptions;
	resolve: (value: boolean) => void;
}

/**
 * 確認ダイアログの単一インスタンスを提供する。
 * useConfirm() で呼び出し、キャンセル/実行の結果を Promise で返す。
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
	const [pending, setPending] = useState<PendingState | null>(null);

	const confirm = useCallback<ConfirmFn>(
		(options) =>
			new Promise<boolean>((resolve) => {
				setPending({ options, resolve });
			}),
		[],
	);

	const settle = useCallback(
		(value: boolean) => {
			pending?.resolve(value);
			setPending(null);
		},
		[pending],
	);

	return (
		<ConfirmContext.Provider value={confirm}>
			{children}
			<Modal
				open={pending !== null}
				title={pending?.options.title ?? ""}
				onClose={() => settle(false)}
				widthClass="max-w-sm"
				footer={
					<>
						<Button variant="ghost" onClick={() => settle(false)}>
							キャンセル
						</Button>
						<Button
							variant={
								pending?.options.tone === "danger" ? "danger" : "primary"
							}
							onClick={() => settle(true)}
						>
							{pending?.options.confirmLabel ?? "OK"}
						</Button>
					</>
				}
			>
				{pending?.options.body && (
					<p className="text-sm leading-relaxed text-neutral-300">
						{pending.options.body}
					</p>
				)}
			</Modal>
		</ConfirmContext.Provider>
	);
}
