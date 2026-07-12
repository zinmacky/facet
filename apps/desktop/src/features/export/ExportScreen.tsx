import { useEffect, useMemo, useRef, useState } from "react";
import { join } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { useMutation } from "@tanstack/react-query";
import type { Clip } from "../../types";
import { masterSpec } from "../../types";
import type { MediaInfo } from "../../lib/tauri";
import { pickExportDirectory, sanitizeFileName } from "../../lib/tauri";
import { usePreview } from "../../lib/usePreview";
import { useReframeQueue } from "../../lib/useReframeQueue";
import { usePauseVideosOnHide } from "../../lib/usePauseVideosOnHide";
import { getErrorMessage } from "../../lib/getErrorMessage";
import { clipPreviewSig } from "../../lib/clipSig";
import { uniqueBaseNames } from "../../lib/uniqueBaseName";
import { Button } from "../../components/ui/Button";
import type { ExportSummary } from "../wizard/StepIndicator";
import { ExportListItem } from "./ExportListItem";
import { ExportPreviewListItem } from "./ExportPreviewListItem";
import { ExportPreviewDetail } from "./ExportPreviewDetail";
import { ExportDetail } from "./ExportDetail";

interface ExportScreenProps {
	/** true のとき現在表示中の画面(ウィザードのアクティブステップ)。 */
	active: boolean;
	source: { inputPath: string; probe: MediaInfo } | null;
	clips: Clip[];
	/**
	 * 増加するたびに全状態を明示的に破棄する(新しい元動画を選択したときのみ App
	 * から増分される)。通常の clip 編集(トリム/クロップ/アスペクト変更)では
	 * 増分されない — その場合は clip 単位の細粒度無効化(下記 sig 比較)で足りる。
	 */
	resetToken: number;
	onGoToEdit: () => void;
	onGoToUpload: () => void;
	/** results から導出した進捗サマリを App(StepIndicator バッジ)へ押し上げる。 */
	onProgressSummary?: (summary: ExportSummary) => void;
}

/**
 * 書き出し画面: 各 clip のマスター(クロップ内容そのもの)を書き出す。
 * ウィザードの一部として常時マウントされる(active=false のときも DOM に存在し、
 * ジョブ購読は継続する)。active でソースがあり、まだ done でない clip を
 * レンダリング開始する。clip の trim/crop/aspect が変わった場合はその clip の
 * 結果のみを個別に無効化し、他 clip の結果はそのまま保持する。
 */
export function ExportScreen({
	active,
	source,
	clips,
	resetToken,
	onGoToEdit,
	onGoToUpload,
	onProgressSummary,
}: ExportScreenProps) {
	// clip 単位の書き出し進捗・結果。「reframe_start 起動 + progress/done/error を Map と
	// 購読解除関数に反映」する部分は UploadScreen の一括書き出しと共通のため
	// `useReframeQueue` に集約している(queue.tasksRef が旧 resultsRef 相当の同期ミラー)。
	const queue = useReframeQueue();

	// 明示的に「書き出しを開始」するまでレンダリングを始めない(切替直後に
	// 全 clip のレンダリングを走らせて CPU を占有しないため)。
	const [started, setStarted] = useState(false);
	// 書き出し先フォルダの選択中(ダイアログ表示中)フラグ。
	const [pickingDir, setPickingDir] = useState(false);

	// マスター/詳細レイアウトの選択中 clip。
	const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

	// ユーザーが選んだ書き出し先フォルダ(絶対パス)。「書き出しを開始」時に選ばせる。
	const outputDirRef = useRef<string | null>(null);

	// クロップ内容プレビュー(preview_start、低ビットレート・app キャッシュ、DL/保存 UI 無し)。
	// UploadScreen の「最終プレビュー」と同じ実装を共有する。
	const preview = usePreview();

	// 非アクティブになった瞬間に配下の <video> を pause する。
	const rootRef = usePauseVideosOnHide(active);

	// 新しい元動画選択(App からの resetToken 増加)時のみ、全状態を明示的に破棄する。
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetToken の変化そのものがトリガ(mount 時の初回実行は無害)
	useEffect(() => {
		queue.reset();
		preview.reset();
		setStarted(false);
		setSelectedClipId(null);
		outputDirRef.current = null;
	}, [resetToken]);

	// clip 単位の細粒度無効化(最重要): 配列参照が変わるたびに全消去していた旧実装をやめ、
	// 「削除された clip」「trim/crop/aspect が変わった(sig が変わった) clip」の結果のみを
	// 個別に破棄する。他 clip の結果・購読・プレビューはそのまま保持する。
	// biome-ignore lint/correctness/useExhaustiveDependencies: queue.tasksRef は ref(useReframeQueue 内の useRef)で読み取りは非反応的 — 旧実装の resultsRef.current と同じ理由で依存に含めない
	useEffect(() => {
		for (const [id, task] of queue.tasksRef.current) {
			const clip = clips.find((c) => c.id === id);
			const stale = clip === undefined || task.sig !== clipPreviewSig(clip);
			if (!stale) continue;
			// queue.remove は tasksRef を同期更新するため、このコミット内で後続実行される
			// 「起動」effect(下記、同じく [clips] 依存)が無効化直後の最新状態を見られる
			// (P1-7: 無効化と起動が同一コミット内で順に走っても再起動を取りこぼさない)。
			queue.remove(id);
			preview.remove(id);
		}
		// 選択中 clip が削除されていたら、selectedClipId 側は別 effect(下記)で
		// 先頭 clip に補正される。
		// queue.remove は useCallback([]) で安定した参照のため、依存配列に加えても
		// 元の [clips, preview.remove] と同じタイミングでのみ発火する。
	}, [clips, preview.remove, queue.remove]);

	/** 選択中 clip のクロップ内容プレビューを生成(または更新)する。 */
	const handlePreviewClip = (clip: Clip) => {
		if (!source) return;
		const spec = masterSpec(clip, {
			width: source.probe.width,
			height: source.probe.height,
		});
		preview.trigger(clip.id, source.inputPath, spec, clipPreviewSig(clip));
	};

	/** 書き出し先フォルダを選ばせてからレンダリングを開始する。キャンセル時は何もしない。 */
	const handleStart = async () => {
		setPickingDir(true);
		try {
			const dir = await pickExportDirectory();
			if (!dir) return;
			outputDirRef.current = dir;
			setStarted(true);
		} finally {
			setPickingDir(false);
		}
	};

	// レンダリング開始。開始操作後・source・出力先があり、done 結果を持たない clip のみ対象。
	// 画面が非アクティブ(離脱済み)でも起動判定は続ける — 常時マウントのウィザードでは
	// 「編集画面へ戻っている間に書き出しが進む」が期待挙動のため。
	useEffect(() => {
		const dir = outputDirRef.current;
		if (!started || !source || !dir) return;
		const probe = source.probe;
		const input = source.inputPath;

		// ファイル名の重複を避ける(同名 clip が複数ある場合など。UploadScreen の
		// 一括書き出しと同じ採番ロジックを共有する)。現在の clips 全体から都度
		// 計算する純粋関数のため、この effect が複数回走っても同じ clip 集合であれば
		// 同じ名前を返す(安定)。
		const uniqueNames = uniqueBaseNames(clips, (c) => sanitizeFileName(c.name));

		for (const clip of clips) {
			const existing = queue.tasksRef.current.get(clip.id);
			if (existing && existing.status === "done") continue;

			const sig = clipPreviewSig(clip);
			// 同期的に「実行中」として予約する(二重起動しない。既に予約/実行中なら何もしない)。
			if (!queue.reserve(clip.id, { sig })) continue;

			const spec = masterSpec(clip, {
				width: probe.width,
				height: probe.height,
			});

			void (async () => {
				try {
					const base = uniqueNames.get(clip) ?? sanitizeFileName(clip.name);
					const outputPath = await join(dir, `${base}.mp4`);
					await queue.run(clip.id, input, outputPath, spec);
				} catch (err) {
					// join() 失敗、または queue.run() の起動/実行失敗(状態には反映済み)。
					queue.fail(clip.id, err);
				}
			})();
		}
	}, [started, source, clips, queue.tasksRef, queue.reserve, queue.run, queue.fail]);

	const donePaths = useMemo(() => {
		const paths: string[] = [];
		for (const clip of clips) {
			const task = queue.tasks.get(clip.id);
			if (task?.status === "done" && task.outputPath)
				paths.push(task.outputPath);
		}
		return paths;
	}, [clips, queue.tasks]);

	// 進捗サマリを App(StepIndicator バッジ)へ押し上げる。
	const progressSummary = useMemo<ExportSummary>(() => {
		let done = 0;
		let running = 0;
		for (const clip of clips) {
			const task = queue.tasks.get(clip.id);
			if (task?.status === "done") done += 1;
			else if (task?.status === "running") running += 1;
		}
		return { total: clips.length, done, running };
	}, [clips, queue.tasks]);

	useEffect(() => {
		onProgressSummary?.(progressSummary);
	}, [progressSummary, onProgressSummary]);

	// 書き出し先フォルダを OS 既定のファイルマネージャで開く。
	// studio 版は書き出し結果を HTTP 経由の ZIP ダウンロードで渡すが、desktop には
	// studio-server が存在しないため同じ経路は使えない(既知ギャップ)。書き出し済み
	// ファイルは既に `dir` 直下へ実体として存在するので、ZIP 化せずフォルダを開くだけで足りる。
	const openFolderMutation = useMutation({
		mutationFn: async () => {
			const dir = outputDirRef.current;
			if (!dir) throw new Error("書き出し先フォルダが未選択です。");
			await openPath(dir);
		},
	});

	// 選択中 clip が clips から消えたとき(または未選択のとき)は先頭 clip を選択する。
	useEffect(() => {
		setSelectedClipId((prev) => {
			if (prev !== null && clips.some((clip) => clip.id === prev)) return prev;
			return clips[0]?.id ?? null;
		});
	}, [clips]);

	const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null;

	return (
		<section ref={rootRef} className="flex h-full min-h-0 flex-col">
			{/* ステップ遷移時のフォーカス移動先(a11y、App.tsx goToStep 参照)。視覚上は非表示。 */}
			<h2 id="wizard-panel-heading-export" tabIndex={-1} className="sr-only">
				書き出し
			</h2>
			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				{!started ? (
					<div className="flex h-full min-h-0 gap-4">
						{/* 中央: 選択中 clip のクロップ内容プレビュー */}
						<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2">
							{selectedClip ? (
								<ExportPreviewDetail
									clip={selectedClip}
									state={preview.states.get(selectedClip.id)}
									onGenerate={() => handlePreviewClip(selectedClip)}
									onCancel={() => preview.cancel(selectedClip.id)}
								/>
							) : (
								<p className="text-sm text-neutral-400">
									プレビューする切り抜きがありません。
								</p>
							)}
						</div>

						{/* 右: clip 一覧(プレビュー状態) */}
						<div className="flex min-h-0 w-60 shrink-0 flex-col gap-1 overflow-y-auto border-l border-line pl-4">
							{clips.map((clip) => (
								<ExportPreviewListItem
									key={clip.id}
									clip={clip}
									state={preview.states.get(clip.id)}
									selected={clip.id === selectedClipId}
									onSelect={() => setSelectedClipId(clip.id)}
								/>
							))}
						</div>
					</div>
				) : (
					<div className="flex h-full min-h-0 gap-4">
						{/* 中央: 選択中 clip の詳細 */}
						<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2">
							{selectedClip ? (
								<ExportDetail
									clip={selectedClip}
									task={queue.tasks.get(selectedClip.id)}
								/>
							) : (
								<p className="text-sm text-neutral-400">
									書き出す切り抜きがありません。
								</p>
							)}
						</div>

						{/* 右: 一括DL + clip 一覧 */}
						<div className="flex min-h-0 w-60 shrink-0 flex-col gap-3 border-l border-line pl-4">
							<div className="flex flex-col gap-1.5">
								<Button
									size="sm"
									variant="secondary"
									disabled={openFolderMutation.status === "pending"}
									onClick={() => openFolderMutation.mutate()}
								>
									{openFolderMutation.status === "pending"
										? "開いています…"
										: "出力先フォルダを開く"}
								</Button>
								<span className="text-[11px] text-neutral-400">
									完了 {donePaths.length} / {clips.length} 件
								</span>
								{openFolderMutation.isError && (
									<span className="text-xs text-danger">
										フォルダを開けませんでした:{" "}
										{getErrorMessage(openFolderMutation.error)}
									</span>
								)}
							</div>

							<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
								{clips.map((clip) => (
									<ExportListItem
										key={clip.id}
										clip={clip}
										task={queue.tasks.get(clip.id)}
										selected={clip.id === selectedClipId}
										onSelect={() => setSelectedClipId(clip.id)}
									/>
								))}
							</div>
						</div>
					</div>
				)}
			</div>

			<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
				<Button variant="ghost" onClick={onGoToEdit} className="mr-auto">
					編集に戻る
				</Button>
				{!started && (
					<p className="max-w-xs truncate text-xs text-neutral-400">
						{clips.length} 本を書き出します(順次レンダリング)。
					</p>
				)}
				{!started && (
					<Button
						variant="primary"
						disabled={clips.length === 0 || pickingDir}
						onClick={() => void handleStart()}
					>
						{pickingDir
							? "書き出し先フォルダを選択中…"
							: `書き出しを開始(${clips.length}本)`}
					</Button>
				)}
				<Button
					variant="primary"
					disabled={clips.length === 0}
					onClick={onGoToUpload}
				>
					アップロードへ進む
				</Button>
			</footer>
		</section>
	);
}

