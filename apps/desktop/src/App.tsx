import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
	convertFileSrc,
	type MediaInfo,
	pickVideoFile,
	probeFile,
} from "./lib/tauri";
import { formatTime } from "./lib/format";
import { getErrorMessage } from "./lib/getErrorMessage";
import type { Clip } from "./types";
import { sourceBaseName } from "./types";
import { ClipList } from "./features/clips/ClipList";
import { ClipEditor, type ClipEditorHandle } from "./features/clips/ClipEditor";
import { ExportScreen } from "./features/export/ExportScreen";
import { UploadScreen } from "./features/upload/UploadScreen";
import { WizardShell } from "./features/wizard/WizardShell";
import { type ExportSummary, StepIndicator } from "./features/wizard/StepIndicator";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { Card } from "./components/ui/Card";
import { Button } from "./components/ui/Button";
import { IconButton } from "./components/ui/IconButton";
import { PlusIcon, SettingsIcon } from "./components/ui/icons";
import { useConfirm } from "./components/ui/confirm";

/** 選択済みソース(実パス + probe 結果)。 */
export interface Source {
	inputPath: string;
	probe: MediaInfo;
	/** `convertFileSrc(inputPath)`。ソース動画をそのまま `<video>` で再生する用(ClipEditor)。 */
	videoSrc: string;
}

type Step = "edit" | "export" | "upload";

/** ソースから新しい Clip を作る(連番付き)。 */
function createClip(source: Source, index: number): Clip {
	return {
		id: crypto.randomUUID(),
		name: `${sourceBaseName(source.inputPath)}_${index}`,
		trim: { start: 0, end: source.probe.duration },
		// 既定は「自由」(=全画面・未クロップ)。選択直後の白枠と一致させる。
		aspect: "free",
	};
}

/**
 * アプリの状態オーナー。
 * 編集/書き出し/アップロードの3画面を横スライドのウィザードとして常時マウントし、
 * `step` で表示中の画面を切り替える(WizardShell が実際のスライド表示を担う)。
 * 元画面ではソース選択と切り抜き(trim + クロップ枠 + アスペクト比)を編集する。
 */
export function App() {
	const [source, setSource] = useState<Source | null>(null);
	const [clips, setClips] = useState<Clip[]>([]);
	const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
	const [step, setStep] = useState<Step>("edit");
	// アップロード画面の投稿処理中フラグ(離脱抑止に使う)。
	const [uploadBusy, setUploadBusy] = useState(false);
	// 書き出し画面の進捗サマリ(StepIndicator のバッジ表示に使う)。
	const [exportSummary, setExportSummary] = useState<ExportSummary>();
	// 増加させるたびに ExportScreen/UploadScreen が全状態を明示的に破棄する
	// (新しい元動画を選択したときのみ増分する — リスク4対応)。
	const [resetToken, setResetToken] = useState(0);
	// 連番カウンタ。削除後の再採番でも名前が衝突しないよう、単調増加させる。
	const clipSeqRef = useRef(1);
	// 設定ダイアログの開閉状態(ヘッダの歯車ボタンから開く)。
	const [settingsOpen, setSettingsOpen] = useState(false);
	const confirm = useConfirm();
	// 元動画プレーヤー(ClipEditor)を命令的に操作するための参照。
	// 編集画面から離れるときに再生を止めるために使う。
	const clipEditorRef = useRef<ClipEditorHandle>(null);

	const pickMutation = useMutation({
		mutationFn: async (): Promise<Source | null> => {
			const picked = await pickVideoFile();
			if (picked.canceled || !picked.path) return null;
			const probe = await probeFile(picked.path);
			return {
				inputPath: picked.path,
				probe,
				videoSrc: convertFileSrc(picked.path),
			};
		},
		onSuccess: (result) => {
			if (!result) return;
			// ファイル選択時に自動で 1 本目の切り抜きを追加して選択状態にする。
			const first = createClip(result, 1);
			clipSeqRef.current = 2; // 次の追加は _2 から。
			setSource(result);
			setClips([first]);
			setSelectedClipId(first.id);
			// 新しい元動画を選んだので、必ず編集画面へ戻り、書き出し/アップロード画面の
			// 古い結果(前の動画の clip に紐づく results/posts/preview)を破棄させる。
			setStep("edit");
			setResetToken((t) => t + 1);
		},
	});

	const addClip = useCallback(() => {
		if (!source) return;
		// 単調増加の連番を使う(削除しても再利用しないので名前が衝突しない)。
		const seq = clipSeqRef.current;
		clipSeqRef.current = seq + 1;
		const clip = createClip(source, seq);
		setClips((prev) => [...prev, clip]);
		setSelectedClipId(clip.id);
	}, [source]);

	const removeClip = useCallback(
		async (id: string) => {
			const target = clips.find((c) => c.id === id);
			const ok = await confirm({
				title: "切り抜きを削除",
				body: `「${target?.name ?? "この切り抜き"}」を削除します。この操作は取り消せません。`,
				confirmLabel: "削除",
				tone: "danger",
			});
			if (!ok) return;
			setClips((prev) => {
				const next = prev.filter((c) => c.id !== id);
				setSelectedClipId((sel) => (sel === id ? (next[0]?.id ?? null) : sel));
				return next;
			});
		},
		[clips, confirm],
	);

	const changeClip = useCallback((clip: Clip) => {
		setClips((prev) => prev.map((c) => (c.id === clip.id ? clip : c)));
	}, []);

	const selectedClip = clips.find((c) => c.id === selectedClipId);

	// "export" へ前進してよいか / "upload" へ前進してよいか。
	const canGoExport = !!source && clips.length > 0;
	const canGoUpload = clips.length > 0;
	// アップロード画面が投稿処理中の間は、そこから離れる遷移をすべて禁止する。
	const stepLocked = step === "upload" && uploadBusy;

	// ウィザードの画面遷移をここに集約する。StepIndicator・各画面の戻る/進む
	// ボタンはすべてこれ経由で遷移する。
	const goToStep = useCallback(
		(next: Step) => {
			if (stepLocked && next !== step) return;
			// 編集画面から離れるときは元動画の再生を止める(書き出し内容はクロップ済みの
			// 音声のみで、この再生音とは無関係だが、バックグラウンドで鳴り続けるのを避ける)。
			if (step === "edit" && next !== "edit") clipEditorRef.current?.pause();
			setStep(next);
		},
		[step, stepLocked],
	);

	// ステップ遷移時、遷移先パネルの見出しへフォーカスを移す(a11y: スクリーンリーダー
	// 利用者が画面切り替えに気付けるようにする)。各パネル側の見出しは
	// `wizard-panel-heading-${step}` の id を持つ(視覚上は sr-only、tabIndex=-1 で
	// スクリプトからのみフォーカス可能)。WizardPanel(WizardShell.tsx)が非アクティブ
	// パネルへ inert を設定する effect は子コンポーネント側のため、同一コミット内で
	// この effect(親)より先に実行される — 実行時点で遷移先パネルは既に inert 解除済み。
	// 初回マウント時(まだ「遷移」していない)はフォーカスを奪わない。
	const mountedRef = useRef(false);
	useEffect(() => {
		if (!mountedRef.current) {
			mountedRef.current = true;
			return;
		}
		document.getElementById(`wizard-panel-heading-${step}`)?.focus();
	}, [step]);

	return (
		<div className="flex h-full flex-col bg-panel">
			{/* トップバー */}
			<header className="grid h-12 shrink-0 grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-line px-4">
				<div className="flex items-center gap-3">
					<div className="flex items-center gap-2">
						<img src="/facet.svg" alt="" className="h-4 w-4" />
						<span className="text-sm font-semibold tracking-tight text-neutral-100">
							Facet <span className="text-neutral-500">desktop</span>
						</span>
					</div>

					<div className="h-5 w-px bg-line" />

					<Button
						size="sm"
						variant="primary"
						disabled={pickMutation.status === "pending"}
						onClick={() => pickMutation.mutate()}
					>
						{pickMutation.status === "pending" ? "読み込み中…" : "元動画を選択"}
					</Button>

					{source && (
						<span className="truncate font-mono text-[11px] text-neutral-400">
							{sourceBaseName(source.inputPath)}
						</span>
					)}
				</div>

				<div className="flex justify-center">
					<StepIndicator
						step={step}
						canGoExport={canGoExport}
						canGoUpload={canGoUpload}
						locked={stepLocked}
						exportSummary={exportSummary}
						onSelect={goToStep}
					/>
				</div>

				<div className="flex items-center justify-end gap-3">
					{source && (
						<span className="font-mono text-[11px] text-neutral-500">
							{source.probe.width}×{source.probe.height} ·{" "}
							{formatTime(source.probe.duration)}
							{source.probe.codec ? ` · ${source.probe.codec}` : ""}
						</span>
					)}
					<IconButton
						aria-label="設定"
						title="設定"
						onClick={() => setSettingsOpen(true)}
					>
						<SettingsIcon />
					</IconButton>
				</div>
			</header>

			{pickMutation.isError && (
				<div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
					読み込み失敗: {getErrorMessage(pickMutation.error)}
				</div>
			)}

			<WizardShell
				step={step}
				panels={{
					edit: (
						<div className="grid h-full min-h-0 grid-cols-[1fr_340px]">
							{/* ステップ遷移時のフォーカス移動先(a11y)。視覚上は非表示。 */}
							<h2
								id="wizard-panel-heading-edit"
								tabIndex={-1}
								className="sr-only"
							>
								編集
							</h2>
							<div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto p-3">
								{!source ? (
									<Placeholder text="元動画を選択してください。" />
								) : selectedClip ? (
									<ClipEditor
										ref={clipEditorRef}
										clip={selectedClip}
										probe={source.probe}
										videoSrc={source.videoSrc}
										onChange={changeClip}
									/>
								) : (
									<Placeholder text="右のパネルから切り抜きを追加してください。" />
								)}
							</div>

							<aside className="flex min-h-0 flex-col gap-3 border-l border-line p-3">
								<Card
									title="Clips"
									className="min-h-0 flex-1"
									actions={
										<IconButton
											tone="accent"
											onClick={addClip}
											disabled={!source}
											aria-label="切り抜きを追加"
											title="切り抜きを追加"
											className="rounded-full"
										>
											<PlusIcon />
										</IconButton>
									}
								>
									<ClipList
										clips={clips}
										selectedClipId={selectedClipId}
										onSelect={setSelectedClipId}
										onRemove={removeClip}
										onChange={changeClip}
									/>
								</Card>

								<Button
									variant="primary"
									disabled={!canGoExport}
									onClick={() => goToStep("export")}
									className="w-full shrink-0"
								>
									すべて書き出し{clips.length > 0 ? `(${clips.length}本)` : ""}
								</Button>
							</aside>
						</div>
					),
					export: (
						<ExportScreen
							active={step === "export"}
							source={source}
							clips={clips}
							resetToken={resetToken}
							onGoToEdit={() => goToStep("edit")}
							onGoToUpload={() => goToStep("upload")}
							onProgressSummary={setExportSummary}
						/>
					),
					upload: (
						<UploadScreen
							active={step === "upload"}
							source={source}
							clips={clips}
							resetToken={resetToken}
							onGoToExport={() => goToStep("export")}
							onBusyChange={setUploadBusy}
						/>
					),
				}}
			/>

			<SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
		</div>
	);
}

function Placeholder({ text }: { text: string }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-neutral-700 text-neutral-400">
			<div className="h-10 w-10 rounded-md border-2 border-dashed border-neutral-600" />
			<p className="text-sm">{text}</p>
		</div>
	);
}
