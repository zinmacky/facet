import { useState } from "react";
import {
	useSettings,
	type EncoderPreference,
	type ThemePreference,
} from "../../lib/settings";
import { pickExportDirectory } from "../../lib/tauri";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { cn } from "../../components/ui/cn";

interface SettingsDialogProps {
	open: boolean;
	onClose: () => void;
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
	{ value: "system", label: "システム" },
	{ value: "light", label: "ライト" },
	{ value: "dark", label: "ダーク" },
];

const ENCODER_OPTIONS: { value: EncoderPreference; label: string }[] = [
	{ value: "auto", label: "自動(推奨)" },
	{ value: "h264_amf", label: "h264_amf(AMD HW)" },
	{ value: "h264_mf", label: "h264_mf(Media Foundation)" },
];

const MAX_CONCURRENT_ENCODES_OPTIONS = [1, 2, 3, 4] as const;

/**
 * アプリ設定ダイアログ。ヘッダの歯車ボタン(App.tsx)から開く。
 * 「外観(テーマ)」「書き出し(既定の書き出し先・完了後にフォルダを開く・
 * 完了時に通知する)」「エンコード(エンコーダ選択・同時エンコード数)」の
 * 3 セクションを持つ。すべて `useSettings().updateSettings` で即時反映・永続化される
 * (保存ボタンは無い — 設定変更に「適用」を挟まない方針)。
 */
export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
	const { settings, updateSettings } = useSettings();
	// フォルダ選択ダイアログ表示中(連打防止・ボタン文言切り替え用)。
	const [pickingDir, setPickingDir] = useState(false);

	const handlePickDir = async () => {
		setPickingDir(true);
		try {
			const dir = await pickExportDirectory("既定の書き出し先フォルダを選択");
			if (!dir) return;
			updateSettings({ defaultExportDir: dir });
		} finally {
			setPickingDir(false);
		}
	};

	return (
		<Modal open={open} title="設定" onClose={onClose} widthClass="max-w-md">
			<div className="flex flex-col gap-6">
				<section className="flex flex-col gap-2">
					<h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
						外観
					</h3>
					{/* 3択のセグメント風ボタン群(ClipEditor のアスペクト比選択と同じ aria-pressed パターン)。 */}
					<div className="flex items-center gap-1">
						{THEME_OPTIONS.map((opt) => {
							const checked = settings.theme === opt.value;
							return (
								<button
									key={opt.value}
									type="button"
									aria-pressed={checked}
									onClick={() => updateSettings({ theme: opt.value })}
									className={cn(
										"rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
										"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
										checked
											? "bg-accent text-white"
											: "border border-line bg-elevated text-neutral-300 hover:border-accent",
									)}
								>
									{opt.label}
								</button>
							);
						})}
					</div>
				</section>

				<section className="flex flex-col gap-3">
					<h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
						書き出し
					</h3>

					<div className="flex flex-col gap-1.5">
						<span className="text-[11px] text-neutral-400">
							既定の書き出し先フォルダ
						</span>
						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 truncate rounded-md border border-line bg-elevated px-2 py-1.5 font-mono text-[11px] text-neutral-300">
								{settings.defaultExportDir ?? "毎回選択する(既定)"}
							</span>
							<Button
								size="sm"
								variant="secondary"
								disabled={pickingDir}
								onClick={() => void handlePickDir()}
							>
								{pickingDir ? "選択中…" : "フォルダを選択"}
							</Button>
							{settings.defaultExportDir && (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => updateSettings({ defaultExportDir: null })}
								>
									クリア
								</Button>
							)}
						</div>
					</div>

					<label className="flex items-center gap-2 text-xs text-neutral-300">
						<input
							type="checkbox"
							checked={settings.openFolderAfterExport}
							onChange={(e) =>
								updateSettings({ openFolderAfterExport: e.target.checked })
							}
							className="h-3.5 w-3.5 rounded border-line bg-elevated accent-accent"
						/>
						書き出し完了後にフォルダを開く
					</label>

					<label className="flex items-center gap-2 text-xs text-neutral-300">
						<input
							type="checkbox"
							checked={settings.notifyOnExportComplete}
							onChange={(e) =>
								updateSettings({ notifyOnExportComplete: e.target.checked })
							}
							className="h-3.5 w-3.5 rounded border-line bg-elevated accent-accent"
						/>
						書き出し完了時に通知する
					</label>
				</section>

				<section className="flex flex-col gap-3">
					<h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
						エンコード
					</h3>

					<div className="flex flex-col gap-1.5">
						<span className="text-[11px] text-neutral-400">エンコーダ</span>
						{/* セグメント風ボタン群(外観のテーマ選択と同じ aria-pressed パターン)。 */}
						<div className="flex items-center gap-1">
							{ENCODER_OPTIONS.map((opt) => {
								const checked = settings.encoder === opt.value;
								return (
									<button
										key={opt.value}
										type="button"
										aria-pressed={checked}
										onClick={() => updateSettings({ encoder: opt.value })}
										className={cn(
											"rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
											"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
											checked
												? "bg-accent text-white"
												: "border border-line bg-elevated text-neutral-300 hover:border-accent",
										)}
									>
										{opt.label}
									</button>
								);
							})}
						</div>
					</div>

					<div className="flex flex-col gap-1.5">
						<span className="text-[11px] text-neutral-400">同時エンコード数</span>
						<div className="flex items-center gap-1">
							{MAX_CONCURRENT_ENCODES_OPTIONS.map((n) => {
								const checked = settings.maxConcurrentEncodes === n;
								return (
									<button
										key={n}
										type="button"
										aria-pressed={checked}
										onClick={() => updateSettings({ maxConcurrentEncodes: n })}
										className={cn(
											"rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
											"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
											checked
												? "bg-accent text-white"
												: "border border-line bg-elevated text-neutral-300 hover:border-accent",
										)}
									>
										{n}
									</button>
								);
							})}
						</div>
						<span className="text-[11px] text-neutral-400">
							既定 2。上げてもスループットが頭打ちになる場合があります。
						</span>
					</div>
				</section>
			</div>
		</Modal>
	);
}
