import type { EditSpec, FitMode } from "@facet/core";
import { useEffect, useMemo, useState } from "react";
import { join } from "@tauri-apps/api/path";
import { useMutation } from "@tanstack/react-query";
import type { Source } from "../../App";
import type { Clip, OutputTarget } from "../../types";
import { finalSpec, targetById } from "../../types";
import { cancelJob, pickExportDirectory, sanitizeFileName } from "../../lib/tauri";
import { generateSchedule } from "../../lib/schedule";
import { usePreview } from "../../lib/usePreview";
import { useReframeQueue } from "../../lib/useReframeQueue";
import { usePauseVideosOnHide } from "../../lib/usePauseVideosOnHide";
import { uniqueBaseNames } from "../../lib/uniqueBaseName";
import { getErrorMessage } from "../../lib/getErrorMessage";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/confirm";
import { PostDetail } from "./PostDetail";
import { PostRow } from "./PostRow";
import { BulkPresetsModal } from "./BulkPresetsModal";
import { ScheduleSettingsModal } from "./ScheduleSettingsModal";
import {
	DEFAULT_FIT,
	DEFAULT_TARGET_ID,
	PUBLISH_SUPPORTED,
	type UploadOutput,
	type UploadPost,
	type PubStatus,
	createOutput,
	createPost,
	outputSig,
} from "./uploadTypes";

/**
 * アップロード画面(Post / Output の二層モデル)。
 * Post = 「どの切り抜きを何時に投稿するか」。1 Post は複数の出力先(Output)を持ち、
 * すべて同じ publishAt(=同時刻)で投稿される。各 Output はターゲット/フィット/メタを持つ。
 * ウィザードの一部として常時マウントされる(active=false のときも DOM に存在する)。
 *
 * Post/Output のデータモデル・共有定数は ./uploadTypes に、中央詳細・右一覧行・
 * モーダル等の表示コンポーネントは同ディレクトリの各ファイルに分割している。
 * 本体(このファイル)は状態管理と画面合成のみを担う。
 */

interface UploadScreenProps {
	/** true のとき現在表示中の画面(ウィザードのアクティブステップ)。 */
	active: boolean;
	/** App.tsx の Source から videoSrc(元動画プレビュー用 URL)を除いたもの。アップロードでは使わない。 */
	source: Omit<Source, "videoSrc"> | null;
	clips: Clip[];
	/**
	 * 増加するたびに全状態(posts/pubStatuses/preview/一括設定/スケジュール等)を
	 * 明示的に破棄する(新しい元動画を選択したときのみ App から増分される)。
	 */
	resetToken: number;
	onGoToExport: () => void;
	/** publishAllMutation/publishPostMutation の実行中フラグを App へ押し上げる(離脱抑止用)。 */
	onBusyChange?: (busy: boolean) => void;
}

export function UploadScreen({
	active,
	source,
	clips,
	resetToken,
	onGoToExport,
	onBusyChange,
}: UploadScreenProps) {
	const [posts, setPosts] = useState<UploadPost[]>([]);
	const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
	// output.id → 投稿処理の進行状態。
	const [pubStatuses, setPubStatuses] = useState<Map<string, PubStatus>>(
		new Map(),
	);
	// output.id → 最終レンダリング結果(プレビュー/DL/投稿で共有)。preview_start ベースの
	// 共通フック(ExportScreen の「クロップ内容プレビュー」と同じ実装)。
	const preview = usePreview();
	// output.id → 「フォルダへ一括書き出し」の進行状態(プレビュー品質の preview とは別軸)。
	// 「reframe_start 起動 + progress/done/error を Map と購読解除関数に反映」する部分は
	// ExportScreen の書き出しと共通のため `useReframeQueue` に集約している。
	const bulkExportQueue = useReframeQueue();
	const confirm = useConfirm();

	// 一括予約スケジュールの入力状態。
	const [startDate, setStartDate] = useState("");
	const [endDate, setEndDate] = useState("");
	// 曜日ごとの時刻リスト(曜日ごとに異なる複数時刻を設定できる)。
	const [weekdayTimes, setWeekdayTimes] = useState<Record<number, string[]>>(
		{},
	);
	const [assignNote, setAssignNote] = useState<string | null>(null);
	// 出力先(ターゲット×フィット)の一括テンプレート。全投稿へまとめて適用する。
	const [outputPresets, setOutputPresets] = useState<
		{ targetId: string; fit: FitMode }[]
	>([{ targetId: DEFAULT_TARGET_ID, fit: DEFAULT_FIT }]);
	const [presetNote, setPresetNote] = useState<string | null>(null);
	// 「一括設定」モーダル(出力先の組み合わせ一括適用)の開閉状態。
	const [bulkSettingsOpen, setBulkSettingsOpen] = useState(false);
	// 「予約スケジュール」モーダル(予約日時の一括割当)の開閉状態。
	const [scheduleSettingsOpen, setScheduleSettingsOpen] = useState(false);

	// 非アクティブになった瞬間に配下の <video> を pause する。
	const rootRef = usePauseVideosOnHide(active);

	// 新しい元動画選択(App からの resetToken 増加)時のみ、全状態を明示的に破棄する
	// (最重要: 旧実装の「!open で破棄」を削除し、この明示トリガのみへ置き換えた。
	// 通常の画面往復(戻る/進む)では posts・プレビュー・スケジュール設定は保持される)。
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetToken の変化そのものがトリガ(mount 時の初回実行は無害)
	useEffect(() => {
		setPosts([]);
		setSelectedPostId(null);
		setPubStatuses(new Map());
		preview.reset();
		setStartDate("");
		setEndDate("");
		setWeekdayTimes({});
		setAssignNote(null);
		setOutputPresets([{ targetId: DEFAULT_TARGET_ID, fit: DEFAULT_FIT }]);
		setPresetNote(null);
		setBulkSettingsOpen(false);
		setScheduleSettingsOpen(false);
		// 実行中の一括書き出しジョブを止めてから状態をクリアする。
		bulkExportQueue.reset();
	}, [resetToken]);

	// clips が揃っていて posts が空のときのみ初期化する(active/open には依存しない)。
	// 画面を離れて戻ってきても既存の posts はそのまま保持する。
	useEffect(() => {
		if (clips.length === 0) return;
		setPosts((prev) => {
			if (prev.length > 0) return prev;
			const created = clips.map((clip) => createPost(clip.id));
			// 初期化直後は先頭 Post を選択する。
			setSelectedPostId(created[0]?.id ?? null);
			return created;
		});
	}, [clips]);

	// 孤児 post の無効化: clips から消えた clipId を参照する post を除去する
	// (ExportScreen.tsx の clip 単位の細粒度無効化 effect が手本)。ClipEditor 側で
	// clip を削除しても、UploadScreen 側は resetToken が増分されないため posts に
	// 参照切れの post が残り続けていた(存在しない clip を指す post が「対象 clip
	// 不明」のまま操作可能に見えてしまう P1 バグ)。除去する post の Output に紐づく
	// プレビュー・投稿ステータスも合わせて破棄する。
	useEffect(() => {
		const validClipIds = new Set(clips.map((c) => c.id));
		const orphanOutputIds = posts
			.filter((p) => !validClipIds.has(p.clipId))
			.flatMap((p) => p.outputs.map((o) => o.id));
		if (orphanOutputIds.length === 0) return;

		setPosts((prev) => prev.filter((p) => validClipIds.has(p.clipId)));
		for (const outputId of orphanOutputIds) preview.remove(outputId);
		setPubStatuses((prev) => {
			const next = new Map(prev);
			for (const outputId of orphanOutputIds) next.delete(outputId);
			return next;
		});
		// 選択中 post が除去されていたら、selectedPostId 側は下の effect で補正される。
	}, [clips, posts, preview.remove]);

	// 選択中 id が posts に無い場合は先頭へ補正する(削除・並び替え時の担保)。
	useEffect(() => {
		if (posts.length === 0) {
			if (selectedPostId !== null) setSelectedPostId(null);
			return;
		}
		if (!posts.some((p) => p.id === selectedPostId)) {
			setSelectedPostId(posts[0]?.id ?? null);
		}
	}, [posts, selectedPostId]);

	// ---- Post 操作 -----------------------------------------------------------

	const patchPost = (postId: string, patch: Partial<UploadPost>) => {
		setPosts((prev) =>
			prev.map((p) => (p.id === postId ? { ...p, ...patch } : p)),
		);
	};

	const removePost = async (postId: string) => {
		const post = posts.find((p) => p.id === postId);
		const clipName = clips.find((c) => c.id === post?.clipId)?.name;
		const ok = await confirm({
			title: "投稿を削除",
			body: `この投稿(${clipName ?? "対象 clip 不明"})を削除します。この操作は取り消せません。`,
			confirmLabel: "削除",
			tone: "danger",
		});
		if (!ok) return;
		setPosts((prev) => {
			const idx = prev.findIndex((p) => p.id === postId);
			const next = prev.filter((p) => p.id !== postId);
			// 削除対象が選択中なら隣接(なければ null)を選択する。
			if (postId === selectedPostId) {
				const neighbor = next[idx] ?? next[idx - 1] ?? null;
				setSelectedPostId(neighbor?.id ?? null);
			}
			return next;
		});
	};

	const movePost = (index: number, dir: -1 | 1) => {
		setPosts((prev) => {
			const target = index + dir;
			if (target < 0 || target >= prev.length) return prev;
			const next = [...prev];
			const a = next[index];
			const b = next[target];
			if (!a || !b) return prev;
			next[index] = b;
			next[target] = a;
			return next;
		});
	};

	const addPost = () => {
		const firstClip = clips[0];
		if (!firstClip) return;
		const created = createPost(firstClip.id);
		setPosts((prev) => [...prev, created]);
		// 追加した Post を選択する。
		setSelectedPostId(created.id);
	};

	// ---- Output 操作 ---------------------------------------------------------

	const patchOutput = (
		postId: string,
		outputId: string,
		patch: Partial<UploadOutput>,
	) => {
		setPosts((prev) =>
			prev.map((p) =>
				p.id === postId
					? {
							...p,
							outputs: p.outputs.map((o) =>
								o.id === outputId ? { ...o, ...patch } : o,
							),
						}
					: p,
			),
		);
	};

	const addOutput = (postId: string) => {
		setPosts((prev) =>
			prev.map((p) =>
				p.id === postId ? { ...p, outputs: [...p.outputs, createOutput()] } : p,
			),
		);
	};

	const removeOutput = async (postId: string, outputId: string) => {
		const post = posts.find((p) => p.id === postId);
		if (post && post.outputs.length <= 1) return; // 最低 1 つは残す。
		const ok = await confirm({
			title: "出力先を削除",
			body: "この出力先(ターゲット・メタデータ)を削除します。この操作は取り消せません。",
			confirmLabel: "削除",
			tone: "danger",
		});
		if (!ok) return;
		setPosts((prev) =>
			prev.map((p) => {
				if (p.id !== postId) return p;
				// 最低 1 つは残す。
				if (p.outputs.length <= 1) return p;
				return { ...p, outputs: p.outputs.filter((o) => o.id !== outputId) };
			}),
		);
		setPubStatuses((prev) => {
			const next = new Map(prev);
			next.delete(outputId);
			return next;
		});
		preview.remove(outputId);
	};

	// ---- 曜日・時刻リスト操作 ------------------------------------------------

	// 曜日の選択トグル。選択時は既定時刻 20:00 を 1 つ入れる。
	const toggleWeekday = (day: number) =>
		setWeekdayTimes((prev) => {
			const next = { ...prev };
			if (day in next) delete next[day];
			else next[day] = ["20:00"];
			return next;
		});

	const addTimeFor = (day: number) =>
		setWeekdayTimes((prev) => ({
			...prev,
			[day]: [...(prev[day] ?? []), "20:00"],
		}));

	const removeTimeFor = (day: number, index: number) =>
		setWeekdayTimes((prev) => {
			const list = prev[day];
			if (!list || list.length <= 1) return prev; // 最低 1 つは残す
			return { ...prev, [day]: list.filter((_, i) => i !== index) };
		});

	const setTimeFor = (day: number, index: number, value: string) =>
		setWeekdayTimes((prev) => {
			const list = prev[day];
			if (!list) return prev;
			return { ...prev, [day]: list.map((t, i) => (i === index ? value : t)) };
		});

	// 生成した予約日時を Post の並び順へ 1 つずつ割り当てる。
	// Post が同時刻グループの単位なので、1 Post = 1 スロット。
	const assignSchedule = () => {
		const slots = generateSchedule({ startDate, endDate, weekdayTimes });
		setPosts((prev) =>
			prev.map((p, i) => {
				const slot = slots[i];
				return slot !== undefined ? { ...p, publishAt: slot } : p;
			}),
		);
		const assigned = Math.min(posts.length, slots.length);
		if (slots.length === 0) {
			setAssignNote(
				"枠が生成されませんでした(期間・曜日・時刻を確認してください)。",
			);
		} else if (slots.length < posts.length) {
			setAssignNote(
				`${assigned} 件へ割当。枠が ${posts.length - slots.length} 件分不足しています。`,
			);
		} else {
			setAssignNote(`${assigned} 件へ割当(${slots.length} スロット)。`);
		}
	};

	// ---- 出力先テンプレートの一括設定 ----------------------------------------

	const addPreset = () =>
		setOutputPresets((prev) => [
			...prev,
			{ targetId: DEFAULT_TARGET_ID, fit: DEFAULT_FIT },
		]);
	const removePreset = (index: number) =>
		setOutputPresets((prev) =>
			prev.length <= 1 ? prev : prev.filter((_, i) => i !== index),
		);
	const setPreset = (
		index: number,
		patch: Partial<{ targetId: string; fit: FitMode }>,
	) =>
		setOutputPresets((prev) =>
			prev.map((p, i) => (i === index ? { ...p, ...patch } : p)),
		);

	// テンプレートの (ターゲット×フィット) 一式を全 Post の出力先として一括適用する。
	// 各 Post の出力先を作り直す(メタデータはリセット)。
	// 戻り値は実際に適用したか(確認ダイアログでキャンセルされた場合は false)。
	// モーダル側はこれを見て、適用時のみモーダルを閉じる。
	const applyPresets = async (): Promise<boolean> => {
		if (outputPresets.length === 0) return false;
		const ok = await confirm({
			title: "出力先を一括適用",
			body: `全 ${posts.length} 投稿の出力先をこの組み合わせで作り直します。入力済みのタイトル・キャプションはリセットされます。`,
			confirmLabel: "適用",
			tone: "danger",
		});
		if (!ok) return false;
		setPosts((prev) =>
			prev.map((p) => ({
				...p,
				outputs: outputPresets.map((preset) => ({
					...createOutput(),
					targetId: preset.targetId,
					fit: preset.fit,
				})),
			})),
		);
		// 旧 output.id に紐づく生成結果・状態は破棄する。
		preview.reset();
		setPubStatuses(new Map());
		setPresetNote(
			`全 ${posts.length} 投稿に ${outputPresets.length} 出力先を適用しました。`,
		);
		return true;
	};

	// ---- レンダリング --------------------------------------------------------

	const setPubStatus = (outputId: string, status: PubStatus) => {
		setPubStatuses((prev) => {
			const next = new Map(prev);
			next.set(outputId, status);
			return next;
		});
	};

	/**
	 * 現在の設定でレンダリング済みなら再利用し、無い/古い場合のみ `preview_start`
	 * (低ビットレート・spec ハッシュキャッシュ)で再レンダリングする。
	 * この画面の「最終プレビュー」欄・DL・投稿はすべてこの結果を再利用する
	 * (実際の書き出し品質(reframe_start, 8Mbps)は書き出し画面(ExportScreen)側が担う。
	 * このため DL される実体は投稿確認用のプレビュー品質(2Mbps)である点に注意 —
	 * Phase 3 で実際の IG/YouTube 投稿を実装する際に、投稿直前の本書き出しへの
	 * 差し替えを検討する)。
	 */
	const ensureRendered = async (
		post: UploadPost,
		output: UploadOutput,
	): Promise<string> => {
		if (!source) throw new Error("元動画が未選択です。");
		const clip = clips.find((c) => c.id === post.clipId);
		if (!clip) throw new Error("対象クリップが見つかりません。");
		const target = targetById(output.targetId);
		if (!target) throw new Error("出力ターゲットが無効です。");

		const spec = finalSpec(
			clip,
			{ width: source.probe.width, height: source.probe.height },
			target,
			output.fit,
		);
		return preview.ensure(
			output.id,
			source.inputPath,
			spec,
			outputSig(clip, post, output),
		);
	};

	// ---- 投稿処理 ------------------------------------------------------------
	// desktop 版は Phase 3 まで IG/YouTube への実投稿(studio-server の
	// `/api/publish/*` HTTP エンドポイント)に対応しない(desktop に studio-server は
	// 存在しないため、叩けば ECONNREFUSED になる)。ボタンは studio 版と同じ UI 構造を
	// 保つため残しつつ disabled にし(PUBLISH_SUPPORTED 参照)、万一 disabled をすり抜けて
	// 呼ばれても HTTP を叩かず即エラー表示に倒す防御的ガードをここに置く。

	/** 1 Output を投稿する。publishAt は post.publishAt(全出力共通)を使う。 */
	const publishOutput = async (
		post: UploadPost,
		output: UploadOutput,
	): Promise<void> => {
		if (!PUBLISH_SUPPORTED) {
			setPubStatus(output.id, {
				kind: "error",
				message:
					"投稿はデスクトップ版では未対応です(Phase 3 で対応予定)。書き出しは「フォルダへ一括書き出し」を使ってください。",
			});
			return;
		}
		if (!source) return;
		const clip = clips.find((c) => c.id === post.clipId);
		if (!clip) return;
		const target = targetById(output.targetId);
		if (!target) {
			setPubStatus(output.id, {
				kind: "error",
				message: "出力ターゲットが無効です。",
			});
			return;
		}

		try {
			// 1. レンダリング(生成済みなら再利用)。
			setPubStatus(output.id, { kind: "rendering" });
			const outputPath = await ensureRendered(post, output);

			// 2. 投稿(Phase 3 で studio-server 相当の native 実装に置き換える)。
			setPubStatus(output.id, { kind: "publishing" });
			await publishTo(target, post, output, clip.name, outputPath);

			setPubStatus(output.id, { kind: "success" });
		} catch (err) {
			setPubStatus(output.id, {
				kind: "error",
				message: getErrorMessage(err),
			});
			throw err;
		}
	};

	/**
	 * プラットフォーム別の投稿。Phase 3 で実装予定(現状は PUBLISH_SUPPORTED=false のため
	 * publishOutput の早期リターンで到達しない)。
	 */
	const publishTo = async (
		_target: OutputTarget,
		_post: UploadPost,
		_output: UploadOutput,
		_clipName: string,
		_outputPath: string,
	): Promise<void> => {
		throw new Error("投稿はデスクトップ版では未対応です(Phase 3 で対応予定)。");
	};

	// 1 Post の全 Output を逐次投稿する。
	const publishPostMutation = useMutation({
		mutationFn: async (post: UploadPost) => {
			for (const output of post.outputs) {
				try {
					await publishOutput(post, output);
				} catch {
					// 個別ステータスへ反映済み。1 件失敗しても後続は続行する。
				}
			}
		},
	});

	// 全 Post の全 Output を逐次投稿する。
	const publishAllMutation = useMutation({
		mutationFn: async () => {
			for (const post of posts) {
				for (const output of post.outputs) {
					try {
						await publishOutput(post, output);
					} catch {
						// 個別ステータスへ反映済み。1 件失敗しても後続は続行する。
					}
				}
			}
		},
	});

	const busy = publishPostMutation.isPending || publishAllMutation.isPending;

	// busy 状態を App(StepIndicator の離脱抑止)へ押し上げる。
	useEffect(() => {
		onBusyChange?.(busy);
	}, [busy, onBusyChange]);

	// 一括書き出し可否の判定に使う全 Output 数。
	const totalOutputs = posts.reduce((sum, p) => sum + p.outputs.length, 0);

	/**
	 * フォルダへ一括書き出し: 保存先フォルダを選ばせたうえで、全 Post の全 Output を
	 * 実書き出し品質(reframe_start, 既定 8Mbps)で直接そのフォルダへ書き出す。
	 * studio 版は書き出し結果を HTTP 経由の ZIP ダウンロードで渡すが、desktop には
	 * studio-server が存在しないため同じ経路は使えない(既知ギャップ)。
	 * プレビュー品質(2Mbps, preview_start)の使い回しはしない — 投稿確認用と
	 * 実書き出しは別ジョブとして扱う。
	 * ジョブは同時に投入してよい(media-core 側のセマフォが並列上限を守る)。
	 */
	const bulkExportMutation = useMutation({
		mutationFn: async (): Promise<
			{ canceled: true } | { canceled: false; ok: number; total: number }
		> => {
			if (!source) throw new Error("元動画が未選択です。");
			const dir = await pickExportDirectory("書き出し先フォルダを選択");
			if (!dir) return { canceled: true };

			// 対象の (post, output, clip, target) を洗い出す。
			const tasks: {
				output: UploadOutput;
				clip: Clip;
				target: OutputTarget;
				spec: EditSpec;
			}[] = [];
			for (const post of posts) {
				const clip = clips.find((c) => c.id === post.clipId);
				if (!clip) continue;
				for (const output of post.outputs) {
					const target = targetById(output.targetId);
					if (!target) continue;
					const spec = finalSpec(
						clip,
						{ width: source.probe.width, height: source.probe.height },
						target,
						output.fit,
					);
					tasks.push({ output, clip, target, spec });
				}
			}
			if (tasks.length === 0) {
				throw new Error("書き出せる出力がありません。");
			}

			// ファイル名の重複を避ける(同一 clip に同一ターゲット+フィットの
			// Output を複数追加した場合など)。ExportScreen の書き出しと同じ採番
			// ロジックを共有する。
			const uniqueNames = uniqueBaseNames(
				tasks,
				(t) => `${sanitizeFileName(t.clip.name)}_${t.target.id}_${t.output.fit}`,
			);

			bulkExportQueue.startBatch(tasks.map((t) => t.output.id));

			const outcomes = await Promise.all(
				tasks.map(async (t) => {
					const base =
						uniqueNames.get(t) ??
						`${sanitizeFileName(t.clip.name)}_${t.target.id}_${t.output.fit}`;
					try {
						const outputPath = await join(dir, `${base}.mp4`);
						await bulkExportQueue.run(t.output.id, source.inputPath, outputPath, t.spec);
						return true;
					} catch {
						// 個別の失敗は bulkExportQueue.tasks の error に反映済み。スキップして続行。
						return false;
					}
				}),
			);

			return {
				canceled: false,
				ok: outcomes.filter(Boolean).length,
				total: tasks.length,
			};
		},
	});

	/** 実行中の一括書き出しジョブをすべてキャンセルする。 */
	const cancelBulkExport = () => {
		for (const task of bulkExportQueue.tasks.values()) {
			if (task.status === "running" && task.jobId) void cancelJob(task.jobId);
		}
	};

	const bulkExportDone = useMemo(
		() =>
			[...bulkExportQueue.tasks.values()].filter((t) => t.status === "done")
				.length,
		[bulkExportQueue.tasks],
	);
	const bulkExportErrors = useMemo(
		() =>
			[...bulkExportQueue.tasks.values()].filter((t) => t.status === "error")
				.length,
		[bulkExportQueue.tasks],
	);

	// プレビュー生成(現在設定でレンダリング)。
	// ensureRendered は preview.ensure 呼び出し前にガード節で早期 throw することがある
	// (元動画未選択・対象クリップ不明・出力ターゲット無効)。この場合 preview 側の
	// states には何も反映されないため render.error は出ず、以前は catch(() => undefined)
	// で握りつぶしてユーザーに一切見えなくなっていた(P1 バグ)。preview.ensure 到達後の
	// 失敗は引き続き renders.error にも反映されるが、ここでは早期 throw を含む
	// あらゆる失敗を既存の pubStatuses(StatusBadge、折りたたみを開かなくても常時
	// 見える trailing 表示)へも反映し、必ずユーザーに見える形にする。
	const previewOutput = (post: UploadPost, output: UploadOutput) => {
		void ensureRendered(post, output).catch((err: unknown) => {
			setPubStatus(output.id, {
				kind: "error",
				message: getErrorMessage(err),
			});
		});
	};

	// 中央詳細に表示する選択中の Post。
	const selectedPost = posts.find((p) => p.id === selectedPostId) ?? null;

	return (
		<>
			<section ref={rootRef} className="flex h-full min-h-0 flex-col">
				{/* ステップ遷移時のフォーカス移動先(a11y、App.tsx goToStep 参照)。視覚上は非表示。 */}
				<h2 id="wizard-panel-heading-upload" tabIndex={-1} className="sr-only">
					アップロード
				</h2>
				<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
					{!PUBLISH_SUPPORTED && (
						<div className="shrink-0 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
							投稿(YouTube / Instagram)はデスクトップ版では未対応です(Phase 3
							で対応予定)。書き出し済みファイルは右の「フォルダへ一括書き出し」で取得してください。
						</div>
					)}
					<div className="flex min-h-0 flex-1 items-start gap-3">
						{/* 中央: 選択中 Post の詳細 */}
						<div className="max-h-full min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
							{selectedPost ? (
								<PostDetail
									key={selectedPost.id}
									post={selectedPost}
									clips={clips}
									renders={preview.states}
									pubStatuses={pubStatuses}
									busy={busy}
									onPatchPost={(patch) => patchPost(selectedPost.id, patch)}
									onPatchOutput={(outputId, patch) =>
										patchOutput(selectedPost.id, outputId, patch)
									}
									onAddOutput={() => addOutput(selectedPost.id)}
									onRemoveOutput={(outputId) =>
										removeOutput(selectedPost.id, outputId)
									}
									onPreviewOutput={(output) =>
										previewOutput(selectedPost, output)
									}
									onPublishOutput={(output) =>
										void publishOutput(selectedPost, output).catch(
											() => undefined,
										)
									}
									onPublishPost={() => publishPostMutation.mutate(selectedPost)}
								/>
							) : (
								<p className="rounded-md border border-dashed border-line px-3 py-10 text-center text-xs text-neutral-400">
									右の一覧から投稿を選択してください。
								</p>
							)}
						</div>

						{/* 右: 投稿(Post)一覧 */}
						<div className="max-h-full min-h-0 w-72 shrink-0 overflow-y-auto border-l border-line pl-3">
							<div className="flex flex-col gap-2">
								<Button
									variant="secondary"
									size="sm"
									onClick={() => setBulkSettingsOpen(true)}
								>
									一括設定…
								</Button>
								<Button
									variant="secondary"
									size="sm"
									onClick={() => setScheduleSettingsOpen(true)}
								>
									予約スケジュール…
								</Button>
								<Button
									variant="secondary"
									size="sm"
									onClick={() => bulkExportMutation.mutate()}
									disabled={totalOutputs === 0 || bulkExportMutation.isPending}
								>
									{bulkExportMutation.isPending
										? "書き出し中…"
										: "フォルダへ一括書き出し"}
								</Button>
								{bulkExportQueue.tasks.size > 0 && (
									<div className="flex items-center justify-between gap-2">
										<span className="text-[11px] text-neutral-400">
											完了 {bulkExportDone} / {bulkExportQueue.tasks.size} 件
											{bulkExportErrors > 0
												? `(失敗 ${bulkExportErrors} 件)`
												: ""}
										</span>
										{bulkExportMutation.isPending && (
											<Button
												variant="ghost"
												size="sm"
												onClick={cancelBulkExport}
											>
												キャンセル
											</Button>
										)}
									</div>
								)}
								{bulkExportMutation.isError && (
									<span className="text-[11px] text-danger">
										{getErrorMessage(bulkExportMutation.error)}
									</span>
								)}
								<Button
									variant="secondary"
									size="sm"
									onClick={addPost}
									disabled={clips.length === 0}
								>
									+ 投稿を追加
								</Button>
							</div>

							<div className="mt-3 flex flex-col gap-1.5">
								{posts.length === 0 && (
									<p className="rounded-md border border-dashed border-line px-2 py-4 text-center text-[11px] text-neutral-400">
										投稿がありません。
									</p>
								)}
								{posts.map((post, index) => (
									<PostRow
										key={post.id}
										post={post}
										index={index}
										total={posts.length}
										clips={clips}
										selected={post.id === selectedPostId}
										onSelect={() => setSelectedPostId(post.id)}
										onMove={(dir) => movePost(index, dir)}
										onRemove={() => removePost(post.id)}
									/>
								))}
							</div>
						</div>
					</div>
				</div>

				<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
					<Button variant="ghost" onClick={onGoToExport} disabled={busy}>
						戻る
					</Button>
					<Button
						variant="primary"
						onClick={() => publishAllMutation.mutate()}
						disabled={busy || totalOutputs === 0 || !PUBLISH_SUPPORTED}
						title={
							PUBLISH_SUPPORTED
								? undefined
								: "デスクトップ版では未対応(Phase 3 で対応予定)"
						}
					>
						すべて投稿
					</Button>
				</footer>
			</section>

			<BulkPresetsModal
				open={bulkSettingsOpen}
				onClose={() => setBulkSettingsOpen(false)}
				outputPresets={outputPresets}
				presetNote={presetNote}
				onAddPreset={addPreset}
				onRemovePreset={removePreset}
				onSetPreset={setPreset}
				onApply={async () => {
					const applied = await applyPresets();
					if (applied) setBulkSettingsOpen(false);
				}}
			/>

			<ScheduleSettingsModal
				open={scheduleSettingsOpen}
				onClose={() => setScheduleSettingsOpen(false)}
				startDate={startDate}
				endDate={endDate}
				weekdayTimes={weekdayTimes}
				note={assignNote}
				onStartDate={setStartDate}
				onEndDate={setEndDate}
				onToggleWeekday={toggleWeekday}
				onAddTime={addTimeFor}
				onRemoveTime={removeTimeFor}
				onSetTime={setTimeFor}
				onAssign={assignSchedule}
			/>
		</>
	);
}
