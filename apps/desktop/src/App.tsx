import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation } from "@tanstack/react-query";
import { pickFile, probeFile, type ProbeResult } from "./lib/api";
import { formatTime } from "./lib/format";
import type { Clip } from "./types";
import { sourceBaseName } from "./types";
import { ClipList } from "./features/clips/ClipList";
import { ClipEditor } from "./features/clips/ClipEditor";
import { ExportModal } from "./features/export/ExportModal";
import { UploadModal } from "./features/upload/UploadModal";
import { Card } from "./components/ui/Card";
import { Button } from "./components/ui/Button";
import { IconButton } from "./components/ui/IconButton";
import { PlusIcon } from "./components/ui/icons";
import { useConfirm } from "./components/ui/confirm";

// Tauri のネイティブシェル外(通常のブラウザでの vite dev/preview)では
// window.__TAURI_INTERNALS__ が存在せず invoke が使えないため、呼び出し前にガードする
function isTauriRuntime(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 選択済みソース(実パス + probe 結果)。 */
export interface Source {
	inputPath: string;
	probe: ProbeResult;
}

type ModalKind = "none" | "export" | "upload";

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
 * 元画面ではソース選択と切り抜き(trim + クロップ枠 + アスペクト比)を編集する。
 * 「すべて書き出し」で EXPORT モーダル、そこから UPLOAD モーダルへ段階的に進む。
 */
export function App() {
	const [source, setSource] = useState<Source | null>(null);
	const [clips, setClips] = useState<Clip[]>([]);
	const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
	const [modal, setModal] = useState<ModalKind>("none");
	// 連番カウンタ。削除後の再採番でも名前が衝突しないよう、単調増加させる。
	const clipSeqRef = useRef(1);
	const confirm = useConfirm();

	// Tauri invoke 疎通確認(Phase 1 の受け入れ基準)。開発用の小さな表示としてフッタに残す。
	const [pingResult, setPingResult] = useState("(未実行)");
	useEffect(() => {
		if (!isTauriRuntime()) {
			setPingResult("Tauri 外での実行のため invoke をスキップしました");
			return;
		}
		invoke<string>("ping")
			.then((result) => setPingResult(result))
			.catch((error) => setPingResult(`invoke 失敗: ${String(error)}`));
	}, []);

	const pickMutation = useMutation({
		mutationFn: async (): Promise<Source | null> => {
			const picked = await pickFile();
			if (picked.canceled || !picked.path) return null;
			const probe = await probeFile(picked.path);
			return { inputPath: picked.path, probe };
		},
		onSuccess: (result) => {
			if (!result) return;
			// ファイル選択時に自動で 1 本目の切り抜きを追加して選択状態にする。
			const first = createClip(result, 1);
			clipSeqRef.current = 2; // 次の追加は _2 から。
			setSource(result);
			setClips([first]);
			setSelectedClipId(first.id);
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

	return (
		<div className="flex h-full flex-col bg-panel">
			{/* トップバー */}
			<header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
				<div className="flex items-center gap-2">
					<div className="h-4 w-4 rounded-sm bg-accent" />
					<span className="text-sm font-semibold tracking-tight text-neutral-100">
						Facet <span className="text-neutral-500">desktop</span>
					</span>
				</div>

				<div className="mx-2 h-5 w-px bg-line" />

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

				<div className="flex-1" />

				{source && (
					<span className="font-mono text-[11px] text-neutral-500">
						{source.probe.width}×{source.probe.height} ·{" "}
						{formatTime(source.probe.duration)}
						{source.probe.codec ? ` · ${source.probe.codec}` : ""}
					</span>
				)}
			</header>

			{pickMutation.isError && (
				<div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
					読み込み失敗: {(pickMutation.error as Error).message}
				</div>
			)}

			{/* メイン: 左(選択中 Clip 編集) / 右(Clip 一覧 + 書き出し起点) */}
			<div className="grid min-h-0 flex-1 grid-cols-[1fr_340px]">
				<div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto p-3">
					{!source ? (
						<Placeholder text="元動画を選択してください。" />
					) : selectedClip ? (
						<ClipEditor
							clip={selectedClip}
							probe={source.probe}
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
						disabled={!source || clips.length === 0}
						onClick={() => setModal("export")}
						className="w-full shrink-0"
					>
						すべて書き出し{clips.length > 0 ? `(${clips.length}本)` : ""}
					</Button>
				</aside>
			</div>

			<ExportModal
				open={modal === "export"}
				source={source}
				clips={clips}
				onClose={() => setModal("none")}
				onProceedToUpload={() => setModal("upload")}
			/>
			<UploadModal
				open={modal === "upload"}
				source={source}
				clips={clips}
				onClose={() => setModal("none")}
				onBack={() => setModal("export")}
			/>

			{/* 開発用フッタ: Tauri invoke 疎通確認(Phase 1 の受け入れ基準)。 */}
			<footer className="flex h-6 shrink-0 items-center border-t border-line px-4 font-mono text-[10px] text-neutral-600">
				invoke(ping): {pingResult}
			</footer>
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
