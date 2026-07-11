import type { EditSpec, FitMode } from "@facet/core";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { join } from "@tauri-apps/api/path";
import { useMutation } from "@tanstack/react-query";
import type { Clip, OutputTarget } from "../../types";
import {
	FIT_OPTIONS,
	OUTPUT_TARGETS,
	finalSpec,
	targetById,
} from "../../types";
import type { MediaInfo } from "../../lib/tauri";
import {
	cancelJob,
	convertFileSrc,
	pickExportDirectory,
	sanitizeFileName,
	startReframe,
} from "../../lib/tauri";
import {
	WEEKDAY_LABELS,
	generateSchedule,
	localInputToMs,
	msToLocalInput,
} from "../../lib/schedule";
import { type PreviewState, usePreview } from "../../lib/usePreview";
import { usePauseVideosOnHide } from "../../lib/usePauseVideosOnHide";
import { clipPreviewSig } from "../../lib/clipSig";
import { uniqueBaseNames } from "../../lib/uniqueBaseName";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	TrashIcon,
} from "../../components/ui/icons";
import { useConfirm } from "../../components/ui/confirm";
import { cn } from "../../components/ui/cn";

/**
 * アップロード画面(Post / Output の二層モデル)。
 * Post = 「どの切り抜きを何時に投稿するか」。1 Post は複数の出力先(Output)を持ち、
 * すべて同じ publishAt(=同時刻)で投稿される。各 Output はターゲット/フィット/メタを持つ。
 * ウィザードの一部として常時マウントされる(active=false のときも DOM に存在する)。
 */

interface UploadScreenProps {
	/** true のとき現在表示中の画面(ウィザードのアクティブステップ)。 */
	active: boolean;
	source: { inputPath: string; probe: MediaInfo } | null;
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

/** 1 投稿の出力先(プラットフォーム別の書き出し・メタ)。 */
interface UploadOutput {
	id: string;
	/** OUTPUT_TARGETS の id。既定 "yt-shorts"。 */
	targetId: string;
	/** 既定 "crop"。 */
	fit: FitMode;
	/** YouTube 用。 */
	title: string;
	/** YouTube 用。 */
	description: string;
	/** Instagram 用。 */
	caption: string;
}

/** 1 投稿(= どの clip を何時に投稿するか)。全 Output を同時刻で投稿する。 */
interface UploadPost {
	id: string;
	clipId: string;
	/** この投稿の予約時刻。全出力に適用。未指定=即時。 */
	publishAt?: number;
	outputs: UploadOutput[];
}

/** 投稿処理の進行状態。 */
type PubStatusKind = "idle" | "rendering" | "publishing" | "success" | "error";

interface PubStatus {
	kind: PubStatusKind;
	message?: string;
}

/**
 * Output の設定シグネチャ。これが変わったらレンダリングは古い(要更新)。
 * `finalSpec` に効く clip.trim/crop/aspect(`clipPreviewSig`)も含める — clip 側の
 * 編集(トリム/クロップ/アスペクト変更)後にプレビューが古いままになる P1 バグの修正
 * (ExportScreen の clipPreviewSig と同じ考え方)。clip が見つからない場合(参照先
 * clip が削除された等)は "missing" を返し、いずれにせよ再レンダリングが必要になる
 * ようにする。
 */
function outputSig(
	clip: Clip | undefined,
	post: UploadPost,
	output: UploadOutput,
): string {
	const clipSig = clip ? clipPreviewSig(clip) : "missing";
	return `${post.clipId}|${clipSig}|${output.targetId}|${output.fit}`;
}

/**
 * 「フォルダへ一括書き出し」1 件(= 1 Output)ぶんの進行状態。
 * `PreviewState`(プレビュー品質・preview_start、usePreview フック)とは別物で、実書き出し品質
 * (reframe_start, 既定 8Mbps)をユーザーが選んだフォルダへ直接書き出す。
 */
interface BulkExportTask {
	status: "running" | "done" | "error";
	/** 0..1。見積り不能な区間は 0 のまま進む。 */
	ratio: number;
	outputPath?: string;
	error?: string;
	/** キャンセルボタン用。 */
	jobId?: string;
}

const DEFAULT_TARGET_ID = "yt-shorts";
const DEFAULT_FIT: FitMode = "crop";

/**
 * IG/YouTube への実投稿は Phase 3 まで desktop 版では未対応
 * (studio-server の `/api/publish/*` に依存しており、desktop にはそのサーバが無い)。
 * 投稿ボタン群は studio 版と UI 構造を保つため残しつつ、ここを false にして
 * disabled + 説明表示のみ行う(HTTP を叩いて ECONNREFUSED になる経路を塞ぐ)。
 */
const PUBLISH_SUPPORTED = false;

/** 既定の Output を生成する。 */
function createOutput(): UploadOutput {
	return {
		id: crypto.randomUUID(),
		targetId: DEFAULT_TARGET_ID,
		fit: DEFAULT_FIT,
		title: "",
		description: "",
		caption: "",
	};
}

/** clip から既定の Post(Output 1 つ)を生成する。 */
function createPost(clipId: string): UploadPost {
	return {
		id: crypto.randomUUID(),
		clipId,
		outputs: [createOutput()],
	};
}

/** 共通の入力スタイル(ダークな編集ツール調)。 */
const inputClass =
	"h-8 rounded-md border border-line bg-elevated px-2 text-xs text-neutral-200 " +
	"focus:border-accent focus:outline-none";
const selectClass = cn(inputClass, "cursor-pointer");
const textareaClass =
	"min-h-[56px] w-full rounded-md border border-line bg-elevated px-2 py-1.5 " +
	"text-xs text-neutral-200 focus:border-accent focus:outline-none";

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
	const [bulkExports, setBulkExports] = useState<Map<string, BulkExportTask>>(
		new Map(),
	);
	// output.id → 実行中の一括書き出しジョブの購読解除関数(キャンセル・cleanup 用)。
	const bulkUnsubsRef = useRef<Map<string, () => void>>(new Map());
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
		for (const unsub of bulkUnsubsRef.current.values()) unsub();
		bulkUnsubsRef.current.clear();
		setBulkExports(new Map());
	}, [resetToken]);

	// アンマウント時に一括書き出しの購読を解除する(保険。通常は上の resetToken effect や
	// 個々のジョブの onDone/onError で解除済み)。
	useEffect(() => {
		const unsubs = bulkUnsubsRef.current;
		return () => {
			for (const unsub of unsubs.values()) unsub();
			unsubs.clear();
		};
	}, []);

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
				message: err instanceof Error ? err.message : String(err),
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

	const setBulkTask = (outputId: string, patch: Partial<BulkExportTask>) => {
		setBulkExports((prev) => {
			const next = new Map(prev);
			const cur = next.get(outputId) ?? {
				status: "running" as const,
				ratio: 0,
			};
			next.set(outputId, { ...cur, ...patch });
			return next;
		});
	};

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

			setBulkExports(() => {
				const next = new Map<string, BulkExportTask>();
				for (const t of tasks)
					next.set(t.output.id, { status: "running", ratio: 0 });
				return next;
			});

			const outcomes = await Promise.all(
				tasks.map(async (t) => {
					const base =
						uniqueNames.get(t) ??
						`${sanitizeFileName(t.clip.name)}_${t.target.id}_${t.output.fit}`;
					try {
						const outputPath = await join(dir, `${base}.mp4`);
						await new Promise<void>((resolve, reject) => {
							let handle: { unsubscribe: () => void } | undefined;
							startReframe(source.inputPath, outputPath, t.spec, {
								onProgress: (progress) => {
									setBulkTask(t.output.id, {
										ratio: (progress.percent ?? 0) / 100,
									});
								},
								onDone: () => {
									handle?.unsubscribe();
									bulkUnsubsRef.current.delete(t.output.id);
									setBulkTask(t.output.id, {
										status: "done",
										ratio: 1,
										outputPath,
									});
									resolve();
								},
								onError: (message) => {
									handle?.unsubscribe();
									bulkUnsubsRef.current.delete(t.output.id);
									setBulkTask(t.output.id, { status: "error", error: message });
									reject(new Error(message));
								},
							})
								.then((h) => {
									handle = h;
									bulkUnsubsRef.current.set(t.output.id, h.unsubscribe);
									setBulkTask(t.output.id, { jobId: h.jobId });
								})
								.catch((err: unknown) => {
									const message =
										err instanceof Error ? err.message : String(err);
									setBulkTask(t.output.id, { status: "error", error: message });
									reject(err instanceof Error ? err : new Error(message));
								});
						});
						return true;
					} catch {
						// 個別の失敗は bulkExports.error に反映済み。スキップして続行。
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
		for (const task of bulkExports.values()) {
			if (task.status === "running" && task.jobId) void cancelJob(task.jobId);
		}
	};

	const bulkExportDone = useMemo(
		() => [...bulkExports.values()].filter((t) => t.status === "done").length,
		[bulkExports],
	);
	const bulkExportErrors = useMemo(
		() => [...bulkExports.values()].filter((t) => t.status === "error").length,
		[bulkExports],
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
				message: err instanceof Error ? err.message : String(err),
			});
		});
	};

	// 中央詳細に表示する選択中の Post。
	const selectedPost = posts.find((p) => p.id === selectedPostId) ?? null;

	return (
		<>
			<section ref={rootRef} className="flex h-full min-h-0 flex-col">
				<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
					{!PUBLISH_SUPPORTED && (
						<div className="shrink-0 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-300">
							投稿(YouTube / Instagram)はデスクトップ版では未対応です(Phase 3
							で対応予定)。書き出し済みファイルは右の「フォルダへ一括書き出し」で取得してください。
						</div>
					)}
					<div className="flex min-h-0 flex-1 gap-3">
						{/* 中央: 選択中 Post の詳細 */}
						<div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
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
						<div className="min-h-0 w-72 shrink-0 overflow-y-auto border-l border-line pl-3">
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
								{bulkExports.size > 0 && (
									<div className="flex items-center justify-between gap-2">
										<span className="text-[11px] text-neutral-400">
											完了 {bulkExportDone} / {bulkExports.size} 件
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
										{(bulkExportMutation.error as Error).message}
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

// ---- 一括設定(出力先テンプレートのモーダル) --------------------------------

interface BulkPresetsModalProps {
	open: boolean;
	onClose: () => void;
	outputPresets: { targetId: string; fit: FitMode }[];
	presetNote: string | null;
	onAddPreset: () => void;
	onRemovePreset: (index: number) => void;
	onSetPreset: (
		index: number,
		patch: Partial<{ targetId: string; fit: FitMode }>,
	) => void;
	onApply: () => void;
}

/**
 * 「一括設定」モーダル: 出力先(ターゲット×フィット)の組み合わせを編集し、
 * 全 Post の出力先へ一括適用する。適用は破壊的(既存メタデータをリセット)なため、
 * 実際の適用は UploadScreen 側の `applyPresets` 内で `useConfirm` による確認を挟む。
 * 確認でキャンセルされた場合はこのモーダルを開いたままにする
 * (UploadScreen 側が applyPresets の戻り値を見て onClose を呼ぶかどうかを決める)。
 */
function BulkPresetsModal(props: BulkPresetsModalProps) {
	return (
		<Modal
			open={props.open}
			title="一括設定"
			onClose={props.onClose}
			widthClass="max-w-xl"
			footer={
				<>
					<Button variant="ghost" onClick={props.onClose}>
						閉じる
					</Button>
					<Button variant="primary" size="sm" onClick={props.onApply}>
						全ての投稿に出力先を適用
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-2">
				<span className="text-[11px] font-medium text-neutral-300">
					出力先の一括設定
				</span>
				<div className="flex flex-col gap-1.5">
					{props.outputPresets.map((preset, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: プリセットは配列位置で識別され(onSetPreset が index を使用)安定IDを持たない
						<div key={index} className="flex items-center gap-2">
							<select
								className={selectClass}
								value={preset.targetId}
								onChange={(e) =>
									props.onSetPreset(index, { targetId: e.target.value })
								}
							>
								{OUTPUT_TARGETS.map((target) => (
									<option key={target.id} value={target.id}>
										{target.label}
									</option>
								))}
							</select>
							<select
								className={selectClass}
								value={preset.fit}
								onChange={(e) =>
									props.onSetPreset(index, {
										fit: e.target.value as FitMode,
									})
								}
							>
								{FIT_OPTIONS.map((opt) => (
									<option key={opt.value} value={opt.value}>
										{opt.label}
									</option>
								))}
							</select>
							{props.outputPresets.length > 1 && (
								<IconButton
									tone="danger"
									size="md"
									aria-label="組み合わせを削除"
									onClick={() => props.onRemovePreset(index)}
								>
									<TrashIcon />
								</IconButton>
							)}
						</div>
					))}
				</div>
				<div className="flex items-center gap-3">
					<Button variant="ghost" size="sm" onClick={props.onAddPreset}>
						+ 組み合わせを追加
					</Button>
					{props.presetNote && (
						<span className="text-[11px] text-neutral-400">
							{props.presetNote}
						</span>
					)}
				</div>
				<p className="text-[11px] text-neutral-400">
					適用すると各投稿の出力先をこの組み合わせで作り直します(メタデータはリセット)。
				</p>
			</div>
		</Modal>
	);
}

// ---- 予約スケジュール(一括割当のモーダル) ----------------------------------

interface ScheduleSettingsModalProps {
	open: boolean;
	onClose: () => void;
	startDate: string;
	endDate: string;
	weekdayTimes: Record<number, string[]>;
	note: string | null;
	onStartDate: (v: string) => void;
	onEndDate: (v: string) => void;
	onToggleWeekday: (day: number) => void;
	onAddTime: (day: number) => void;
	onRemoveTime: (day: number, index: number) => void;
	onSetTime: (day: number, index: number, value: string) => void;
	onAssign: () => void;
}

/**
 * 「予約スケジュール」モーダル: 期間・曜日・時刻から予約枠を生成し、
 * Post の並び順へ予約日時を一括割当する。割当は非破壊(publishAt の上書きのみで、
 * 再割当・個別修正がいつでもできる)ため確認ダイアログは挟まない。
 * 割当結果のノート(割当件数・枠不足の警告)を見せるため、割当後もモーダルは
 * 閉じない(「閉じる」/ Esc / オーバーレイクリックで閉じる)。
 */
function ScheduleSettingsModal(props: ScheduleSettingsModalProps) {
	const selectedDays = Object.keys(props.weekdayTimes)
		.map(Number)
		.sort((a, b) => a - b);

	return (
		<Modal
			open={props.open}
			title="予約スケジュール"
			onClose={props.onClose}
			widthClass="max-w-xl"
			footer={
				<>
					<Button variant="ghost" onClick={props.onClose}>
						閉じる
					</Button>
					<Button variant="primary" size="sm" onClick={props.onAssign}>
						この順で予約日時を割り当て
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center gap-3">
					<label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
						開始日
						<input
							type="date"
							className={inputClass}
							value={props.startDate}
							onChange={(e) => props.onStartDate(e.target.value)}
						/>
					</label>
					<label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
						終了日
						<input
							type="date"
							className={inputClass}
							value={props.endDate}
							onChange={(e) => props.onEndDate(e.target.value)}
						/>
					</label>
				</div>

				<div className="flex items-center gap-1.5">
					<span className="text-[11px] text-neutral-400">曜日</span>
					{WEEKDAY_LABELS.map((label, day) => {
						const active = day in props.weekdayTimes;
						return (
							<button
								key={label}
								type="button"
								onClick={() => props.onToggleWeekday(day)}
								className={cn(
									"h-7 w-7 rounded-md border text-xs transition-colors",
									active
										? "border-accent bg-accent/20 text-accent"
										: "border-line bg-elevated text-neutral-400 hover:border-accent/60",
								)}
							>
								{label}
							</button>
						);
					})}
				</div>

				{/* 曜日ごとの時刻(曜日ごとに異なる複数時刻を設定できる) */}
				{selectedDays.length === 0 ? (
					<p className="text-[11px] text-neutral-400">
						曜日を選ぶと、その曜日の時刻を設定できます。
					</p>
				) : (
					<div className="flex flex-col gap-1.5">
						{selectedDays.map((day) => {
							const list = props.weekdayTimes[day] ?? [];
							return (
								<div key={day} className="flex flex-wrap items-center gap-2">
									<span className="w-5 text-center text-[11px] font-semibold text-accent">
										{WEEKDAY_LABELS[day] ?? ""}
									</span>
									{list.map((time, index) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: 時刻は配列位置で識別され(onSetTime/onRemoveTime が index を使用)安定IDを持たない
										<div key={index} className="flex items-center gap-1">
											<input
												type="time"
												className={inputClass}
												value={time}
												onChange={(e) =>
													props.onSetTime(day, index, e.target.value)
												}
											/>
											{list.length > 1 && (
												<IconButton
													tone="danger"
													aria-label="時刻を削除"
													onClick={() => props.onRemoveTime(day, index)}
												>
													<TrashIcon />
												</IconButton>
											)}
										</div>
									))}
									<Button
										variant="ghost"
										size="sm"
										onClick={() => props.onAddTime(day)}
									>
										+ 時刻
									</Button>
								</div>
							);
						})}
					</div>
				)}

				{props.note && (
					<p className="text-[11px] text-neutral-400">{props.note}</p>
				)}
			</div>
		</Modal>
	);
}

// ---- 折りたたみ(投稿専用フィールドの格納用) --------------------------------

/**
 * ▼/▶ + 見出しの流儀に合わせた、小さな折りたたみ表示。
 * 投稿(Phase 3 まで無効)専用のフィールドをまとめて隠すために使う
 * (PostDetail の予約日時・一括投稿、OutputCard のメタデータ・投稿ボタン)。
 */
function Disclosure({
	title,
	expanded,
	onToggle,
	trailing,
	children,
}: {
	title: string;
	expanded: boolean;
	onToggle: () => void;
	trailing?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="rounded-md border border-line/60 bg-elevated/30 px-2 py-1.5">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={expanded}
				className="flex w-full items-center justify-between gap-1.5 text-left"
			>
				<span className="flex items-center gap-1.5 text-[11px] font-medium text-neutral-300">
					<span className="text-neutral-500">{expanded ? "▼" : "▶"}</span>
					{title}
				</span>
				{trailing}
			</button>
			{expanded && <div className="mt-2 flex flex-col gap-2">{children}</div>}
		</div>
	);
}

// ---- Post 詳細(中央) ------------------------------------------------------

interface PostDetailProps {
	post: UploadPost;
	clips: Clip[];
	renders: Map<string, PreviewState>;
	pubStatuses: Map<string, PubStatus>;
	busy: boolean;
	onPatchPost: (patch: Partial<UploadPost>) => void;
	onPatchOutput: (outputId: string, patch: Partial<UploadOutput>) => void;
	onAddOutput: () => void;
	onRemoveOutput: (outputId: string) => void;
	onPreviewOutput: (output: UploadOutput) => void;
	onPublishOutput: (output: UploadOutput) => void;
	onPublishPost: () => void;
}

function PostDetail(props: PostDetailProps) {
	const { post, clips, busy } = props;
	const [scheduleOpen, setScheduleOpen] = useState(false);
	const postClip = clips.find((c) => c.id === post.clipId);
	// 元画面で決めたクロップ比。出力先アスペクトとの関係を示すために表示する。
	const clipAspectLabel = postClip
		? postClip.aspect === "free"
			? "自由"
			: postClip.aspect
		: "—";
	const datetimeValue =
		post.publishAt !== undefined ? msToLocalInput(post.publishAt) : "";
	const scheduleLabel =
		post.publishAt !== undefined
			? msToLocalInput(post.publishAt).replace("T", " ")
			: "即時";

	const onDatetimeChange = (value: string) => {
		const ms = localInputToMs(value);
		props.onPatchPost(
			ms !== null ? { publishAt: ms } : { publishAt: undefined },
		);
	};

	return (
		<div className="flex flex-col gap-3">
			{/* 投稿ヘッダ: 対象 clip(常時表示)+ 予約日時・一括投稿(折りたたみ) */}
			<div className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3">
				<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
					対象 clip
					<select
						className={selectClass}
						value={post.clipId}
						onChange={(e) => props.onPatchPost({ clipId: e.target.value })}
					>
						{clips.map((clip) => (
							<option key={clip.id} value={clip.id}>
								{clip.name}
							</option>
						))}
					</select>
				</label>

				<Disclosure
					title="投稿設定(予約日時・一括投稿)"
					expanded={scheduleOpen}
					onToggle={() => setScheduleOpen((v) => !v)}
					trailing={
						<span className="text-[11px] text-neutral-400">
							{scheduleLabel}
						</span>
					}
				>
					<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
						予約日時(未指定=即時)
						<input
							type="datetime-local"
							className={inputClass}
							value={datetimeValue}
							onChange={(e) => onDatetimeChange(e.target.value)}
						/>
					</label>
					<div className="flex justify-end">
						<Button
							variant="primary"
							size="sm"
							onClick={props.onPublishPost}
							disabled={busy || !PUBLISH_SUPPORTED}
							title={
								PUBLISH_SUPPORTED
									? undefined
									: "デスクトップ版では未対応(Phase 3 で対応予定)"
							}
						>
							この投稿をすべて投稿
						</Button>
					</div>
				</Disclosure>
			</div>

			{/* 出力先(Output)一覧 */}
			<div className="flex flex-col gap-2">
				<span className="text-[11px] font-semibold text-neutral-300">
					出力先
				</span>
				{post.outputs.map((output) => (
					<OutputCard
						key={output.id}
						post={post}
						clip={postClip}
						output={output}
						clipAspectLabel={clipAspectLabel}
						canRemove={post.outputs.length > 1}
						render={props.renders.get(output.id)}
						status={props.pubStatuses.get(output.id)}
						busy={busy}
						onPatch={(patch) => props.onPatchOutput(output.id, patch)}
						onRemove={() => props.onRemoveOutput(output.id)}
						onPreview={() => props.onPreviewOutput(output)}
						onPublish={() => props.onPublishOutput(output)}
					/>
				))}
				<Button variant="secondary" size="sm" onClick={props.onAddOutput}>
					+ 出力先を追加
				</Button>
			</div>
		</div>
	);
}

// ---- Output カード ----------------------------------------------------------

interface OutputCardProps {
	post: UploadPost;
	/** post.clipId の解決済み clip(finalSpec/outputSig に効く trim/crop/aspect を持つ)。 */
	clip: Clip | undefined;
	output: UploadOutput;
	/** 元画面で決めたクロップ比のラベル(由来表示用)。 */
	clipAspectLabel: string;
	canRemove: boolean;
	render: PreviewState | undefined;
	status: PubStatus | undefined;
	busy: boolean;
	onPatch: (patch: Partial<UploadOutput>) => void;
	onRemove: () => void;
	onPreview: () => void;
	onPublish: () => void;
}

function OutputCard(props: OutputCardProps) {
	const { post, clip, output, render, status, busy } = props;
	const [postSettingsOpen, setPostSettingsOpen] = useState(false);
	const target = useMemo(() => targetById(output.targetId), [output.targetId]);
	const platform = target?.platform;
	// 出力ターゲットのアスペクト比(width/height)。プレビュー枠はこれに追従する。
	const boxRatio = target ? target.width / target.height : 9 / 16;

	// 現在設定と生成済みファイルの整合。fresh=最新、stale=設定変更後で要更新。
	const rendering = render?.rendering ?? false;
	const outputPath = render?.outputPath;
	const sig = outputSig(clip, post, output);
	const fresh = outputPath !== undefined && render?.sig === sig;
	const stale = outputPath !== undefined && render?.sig !== sig;

	return (
		<div className="rounded-lg border border-line bg-panel p-3">
			<div className="flex items-start gap-3">
				{/* 左: 出力先アスペクトに追従する固定プレビュー枠 */}
				<div className="flex w-72 shrink-0 flex-col gap-1.5">
					<div className="flex items-center justify-between">
						<span className="text-[11px] text-neutral-400">
							最終プレビュー
							{stale && <span className="ml-1 text-amber-400">(要更新)</span>}
						</span>
						{fresh && outputPath && (
							<a
								href={convertFileSrc(outputPath)}
								download
								className="text-[11px] text-accent hover:underline"
							>
								DL
							</a>
						)}
					</div>

					<div className="flex h-[32vh] w-full items-center justify-center rounded-lg bg-elevated/40">
						<div
							style={{ aspectRatio: boxRatio }}
							className="flex h-full max-w-full items-center justify-center overflow-hidden rounded-md border border-line bg-black/40"
						>
							{outputPath ? (
								/* biome-ignore lint/a11y/useMediaCaption: 投稿確認用のプレビューで字幕データが存在しない */
								<video
									src={convertFileSrc(outputPath)}
									controls
									className={cn(
										"h-full w-full object-contain",
										stale && "opacity-60",
									)}
								/>
							) : (
								<p className="max-w-[75%] text-center text-[11px] text-neutral-500">
									「プレビュー生成」で最終アスペクト・フィットを確認できます。
								</p>
							)}
						</div>
					</div>

					<Button
						variant="ghost"
						size="sm"
						className="w-full"
						onClick={props.onPreview}
						disabled={rendering || busy}
					>
						{rendering
							? "生成中…"
							: outputPath
								? "プレビュー更新"
								: "プレビュー生成"}
					</Button>
					{render?.error && (
						<p className="text-[11px] text-danger">{render.error}</p>
					)}
				</div>

				{/* 右: 出力ターゲット・フィット + 投稿設定(折りたたみ) */}
				<div className="flex min-w-0 flex-1 flex-col gap-2">
					<div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
						<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
							出力ターゲット
							<select
								className={selectClass}
								value={output.targetId}
								onChange={(e) => props.onPatch({ targetId: e.target.value })}
							>
								{OUTPUT_TARGETS.map((t) => (
									<option key={t.id} value={t.id}>
										{t.label}
									</option>
								))}
							</select>
						</label>

						<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
							フィット
							<select
								className={selectClass}
								value={output.fit}
								onChange={(e) =>
									props.onPatch({ fit: e.target.value as FitMode })
								}
							>
								{FIT_OPTIONS.map((opt) => (
									<option key={opt.value} value={opt.value}>
										{opt.label}
									</option>
								))}
							</select>
						</label>

						{props.canRemove && (
							<IconButton
								tone="danger"
								size="md"
								aria-label="出力先を削除"
								onClick={props.onRemove}
							>
								<TrashIcon />
							</IconButton>
						)}
					</div>

					<p className="text-[11px] leading-snug text-neutral-400">
						元クロップ{" "}
						<span className="font-medium text-neutral-200">
							{props.clipAspectLabel}
						</span>{" "}
						を、選んだ出力先アスペクトへ「
						{FIT_OPTIONS.find((o) => o.value === output.fit)?.label ??
							output.fit}
						」で合わせます。
					</p>

					{/* 投稿専用フィールド(メタデータ・投稿ボタン・ステータス)。
					    Phase 3 まで投稿自体が無効なため、既定で折りたたむ。 */}
					<Disclosure
						title="投稿設定"
						expanded={postSettingsOpen}
						onToggle={() => setPostSettingsOpen((v) => !v)}
						trailing={<StatusBadge status={status} />}
					>
						{platform === "youtube" ? (
							<>
								<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
									タイトル
									<input
										type="text"
										className={cn(inputClass, "w-full")}
										value={output.title}
										onChange={(e) => props.onPatch({ title: e.target.value })}
									/>
								</label>
								<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
									説明
									<textarea
										className={cn(textareaClass, "min-h-[96px] resize-y")}
										value={output.description}
										onChange={(e) =>
											props.onPatch({ description: e.target.value })
										}
									/>
								</label>
							</>
						) : (
							<label className="flex flex-col gap-1 text-[11px] text-neutral-400">
								キャプション
								<textarea
									className={cn(textareaClass, "min-h-[96px] resize-y")}
									maxLength={2200}
									value={output.caption}
									onChange={(e) => props.onPatch({ caption: e.target.value })}
								/>
							</label>
						)}

						<div className="flex justify-end">
							<Button
								variant="primary"
								size="sm"
								onClick={props.onPublish}
								disabled={busy || !PUBLISH_SUPPORTED}
								title={
									PUBLISH_SUPPORTED
										? undefined
										: "デスクトップ版では未対応(Phase 3 で対応予定)"
								}
							>
								投稿
							</Button>
						</div>
					</Disclosure>
				</div>
			</div>
		</div>
	);
}

// ---- 投稿(Post)一覧の行 ---------------------------------------------------

interface PostRowProps {
	post: UploadPost;
	index: number;
	total: number;
	clips: Clip[];
	selected: boolean;
	onSelect: () => void;
	onMove: (dir: -1 | 1) => void;
	onRemove: () => void;
}

function PostRow(props: PostRowProps) {
	const { post, index, total, clips, selected } = props;
	const clipName =
		clips.find((c) => c.id === post.clipId)?.name ?? "(不明な clip)";
	const scheduleLabel =
		post.publishAt !== undefined
			? msToLocalInput(post.publishAt).replace("T", " ")
			: "即時";

	return (
		// biome-ignore lint/a11y/useSemanticElements: 上へ/下へ/削除ボタンを内包する選択カードのため native button 化できない
		<div
			role="button"
			tabIndex={0}
			onClick={props.onSelect}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					props.onSelect();
				}
			}}
			className={cn(
				"cursor-pointer rounded-md border p-2 transition-colors",
				selected
					? "border-accent bg-accent/10"
					: "border-line bg-panel hover:border-accent/60",
			)}
		>
			<div className="flex items-start justify-between gap-1">
				<div className="min-w-0">
					<div className="flex items-center gap-1.5">
						<span className="text-[11px] font-medium text-neutral-400">
							#{index + 1}
						</span>
						<span
							className="truncate text-xs text-neutral-200"
							title={clipName}
						>
							{clipName}
						</span>
					</div>
					<div className="mt-0.5 flex items-center gap-1.5">
						<span
							className="truncate text-[11px] text-neutral-400"
							title={scheduleLabel}
						>
							{scheduleLabel}
						</span>
						<span className="shrink-0 rounded bg-elevated px-1 text-[11px] text-neutral-300">
							{post.outputs.length} 出力
						</span>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<IconButton
						aria-label="上へ"
						disabled={index === 0}
						onClick={(e) => {
							e.stopPropagation();
							props.onMove(-1);
						}}
					>
						<ChevronUpIcon />
					</IconButton>
					<IconButton
						aria-label="下へ"
						disabled={index === total - 1}
						onClick={(e) => {
							e.stopPropagation();
							props.onMove(1);
						}}
					>
						<ChevronDownIcon />
					</IconButton>
					<IconButton
						tone="danger"
						aria-label="削除"
						onClick={(e) => {
							e.stopPropagation();
							props.onRemove();
						}}
					>
						<TrashIcon />
					</IconButton>
				</div>
			</div>
		</div>
	);
}

// ---- ステータス表示 ---------------------------------------------------------

function StatusBadge({ status }: { status: PubStatus | undefined }) {
	const kind = status?.kind ?? "idle";
	const label: Record<PubStatusKind, string> = {
		idle: "未投稿",
		rendering: "レンダリング中…",
		publishing: "投稿中…",
		success: "完了",
		error: "エラー",
	};
	const tone: Record<PubStatusKind, string> = {
		idle: "text-neutral-400",
		rendering: "text-accent",
		publishing: "text-accent",
		success: "text-ok",
		error: "text-danger",
	};
	return (
		<span className={cn("text-[11px]", tone[kind])}>
			{label[kind]}
			{kind === "error" && status?.message ? `: ${status.message}` : ""}
		</span>
	);
}
