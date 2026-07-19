import type { EditSpec, FitMode } from "@facet/core";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { join } from "@tauri-apps/api/path";
import { useMutation } from "@tanstack/react-query";
import type { Source } from "../../App";
import type { Clip, OutputTarget } from "../../types";
import { targetById } from "../../types";
import { cancelJob, pickExportDirectory, sanitizeFileName } from "../../lib/tauri";
import { useSettings } from "../../lib/settings";
import { PreviewSupersededError, usePreview } from "../../lib/usePreview";
import { useReframeQueue } from "../../lib/useReframeQueue";
import { usePauseVideosOnHide } from "../../lib/usePauseVideosOnHide";
import { uniqueBaseNames } from "../../lib/uniqueBaseName";
import { getErrorMessage } from "../../lib/getErrorMessage";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/confirm";
import { PostDetail } from "./PostDetail";
import { PostRow } from "./PostRow";
import { BulkPresetsModal } from "./BulkPresetsModal";
import {
	buildRenderArgs,
	DEFAULT_FIT,
	DEFAULT_TARGET_ID,
	type UploadOutput,
	type UploadPost,
	createOutput,
	createPost,
} from "./uploadTypes";

/**
 * リフレーム画面(Post / Output の二層モデル)。両エディション共通のコード
 * (public/private どちらのビルドにも含まれる)。ターゲット別アスペクト/フィットの
 * 選択・レンダリング・フォルダへの保存を担う — 製品の核であるリフレーム機能
 * そのものなので、投稿(スケジュール・キャプション・IG/YT 連携)とは違い
 * public 版でも利用できる(§docs/desktop-migration-plan.md の wizard 再構成メモ、
 * v2.4 エディション分離時の切り分けミスの修正)。
 *
 * private エディションでは `publishSlots`(§PublishSlots、下記)経由で投稿系 UI が
 * 差し込まれる。実体は `UploadScreenPrivate.tsx` が `usePublishExtras` の戻り値を
 * ここへ渡す(§features/upload/entry.ts)。public はこの prop を渡さない
 * (§features/upload/entry.public.ts)ため、投稿系コード(igPublish.ts・
 * ScheduleSettingsModal.tsx・PublishGateContext 等)は import グラフにすら現れず、
 * バンドルへ物理的に含まれない。
 *
 * Post = 「どの切り抜きをどの出力先(ターゲット×フィット)一式で扱うか」の単位。
 * ウィザードの一部として常時マウントされる(active=false のときも DOM に存在する)。
 *
 * Post/Output のデータモデル・共有定数は ./uploadTypes に、中央詳細・右一覧行・
 * モーダル等の表示コンポーネントは同ディレクトリの各ファイルに分割している。
 * 本体(このファイル)は状態管理と画面合成のみを担う。
 */

/** entry.ts / entry.public.ts(edition による差し替え先)の型を揃えるため export する。 */
export interface UploadScreenProps {
	/** true のとき現在表示中の画面(ウィザードのアクティブステップ)。 */
	active: boolean;
	/** App.tsx の Source から videoSrc(元動画プレビュー用 URL)を除いたもの。リフレームでは使わない。 */
	source: Omit<Source, "videoSrc"> | null;
	clips: Clip[];
	/**
	 * 増加するたびに全状態(posts/previewErrors/preview/一括設定等)を
	 * 明示的に破棄する(新しい元動画を選択したときのみ App から増分される)。
	 */
	resetToken: number;
	onGoToExport: () => void;
	/**
	 * private のみ: 投稿処理(publishAllMutation/publishPostMutation)の実行中フラグを
	 * App へ押し上げる(離脱抑止用)。`UploadScreenProps` の一部として型を揃えているだけで、
	 * `ReframeScreen` 自身はこれを呼ばない(呼ぶのは `UploadScreenPrivate.tsx` — 実際に
	 * `usePublishExtras` の busy を監視しているのはそちらのため)。public では常に
	 * 未使用(呼ばれない = uploadBusy は false のまま)。
	 */
	onBusyChange?: (busy: boolean) => void;
}

/**
 * private エディションが `usePublishExtras`(§usePublishExtras.ts)経由で差し込む
 * 投稿系 UI のスロット一式。ReframeScreen 自体はこの型の中身(投稿の概念)を
 * 一切知らなくてよいように、すべて「レンダリング結果の ReactNode を受け取るだけ」の
 * 形にしている — ReframeScreen が投稿系の型・文言に依存しないための境界。
 */
export interface PublishSlots {
	/** 投稿処理中(離脱抑止用)。「戻る」ボタンの disabled に反映する。 */
	busy: boolean;
	/** 画面上部のバナー(IG設定案内・YouTube未対応案内)。 */
	banner?: ReactNode;
	/**
	 * 右パネルの「一括設定…」の直後に差し込む追加ボタン(予約スケジュール…)+モーダル。
	 * `assignSchedule` は「生成した予約日時を Post の並び順へ割り当てる」ための
	 * コールバック(posts の所有権は ReframeScreen 側にあるため、関数として注入する)。
	 */
	sidebarActions?: (assignSchedule: (slots: number[]) => void) => ReactNode;
	/** フッタに差し込む追加ボタン(すべて投稿)。 */
	footerActions?: ReactNode;
	/** 投稿一覧の各行に添える予約日時ラベル。 */
	renderPostRowExtra: (post: UploadPost) => ReactNode;
	/** 投稿詳細ヘッダに添える予約日時・一括投稿セクション。 */
	renderPostSection: (
		post: UploadPost,
		onPatchPost: (patch: Partial<UploadPost>) => void,
	) => ReactNode;
	/** OutputCard に添える投稿設定セクション(メタデータ・投稿ボタン)。 */
	renderOutputSection: (
		post: UploadPost,
		output: UploadOutput,
		onPatchOutput: (patch: Partial<UploadOutput>) => void,
	) => ReactNode;
}

interface ReframeScreenProps extends UploadScreenProps {
	/** private のみ: `UploadScreenPrivate.tsx` が `usePublishExtras` の戻り値を渡す。 */
	publishSlots?: PublishSlots;
	/**
	 * private のみ: `posts` state の変化を通知する(`UploadScreenPrivate.tsx` がこれを
	 * 見て自身のミラーを更新し、`usePublishExtras` の孤児クリーンアップ
	 * (削除された Output の投稿状態・投稿用レンダリングの破棄)に使う)。
	 * `posts` の所有権自体はこのコンポーネントに一本化したまま(値を通知するだけで、
	 * ここから制御を受け取ることはない — 二重の真実の源を避けるため片方向)。
	 */
	onPostsChange?: (posts: UploadPost[]) => void;
}

export function ReframeScreen({
	active,
	source,
	clips,
	resetToken,
	onGoToExport,
	publishSlots,
	onPostsChange,
}: ReframeScreenProps) {
	const [posts, setPosts] = useState<UploadPost[]>([]);
	const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
	// output.id → プレビュー生成の早期失敗メッセージ(§OutputCard.tsx の previewError)。
	const [previewErrors, setPreviewErrors] = useState<Map<string, string>>(
		new Map(),
	);
	// output.id → 最終プレビュー(目視確認・DL 用、2Mbps)。
	const preview = usePreview();
	// 「フォルダへ保存」の進行状態(プレビュー品質の preview とは別軸)。
	// 「reframe_start 起動 + progress/done/error を Map と購読解除関数に反映」する部分は
	// ExportScreen の書き出しと共通のため `useReframeQueue` に集約している。
	const bulkExportQueue = useReframeQueue();
	const confirm = useConfirm();
	const { settings, updateSettings } = useSettings();

	const busy = publishSlots?.busy ?? false;

	// private ラッパ(UploadScreenPrivate.tsx)へ posts の変化を通知する(上記
	// `onPostsChange` 参照)。
	// biome-ignore lint/correctness/useExhaustiveDependencies: onPostsChange は親が渡す安定した setState 由来のコールバック(依存に入れると親の再レンダーごとに再実行され得るが無害なので簡潔さを優先)
	useEffect(() => {
		onPostsChange?.(posts);
	}, [posts]);

	// 非アクティブになった瞬間に配下の <video> を pause する。
	const rootRef = usePauseVideosOnHide(active);

	// 下の「clip 追加への追従」effect が既に認識した clip id の集合。「どの post の
	// clipId からも参照されていない clip」を新規 clip の判定に使うと、ユーザーが
	// 「削除」で意図的に取り除いた post(対象 clip 自体は残っている)が、無関係な
	// clip 編集(trim/crop 等)による clips 配列の再生成のたびに復活してしまう。
	// そのため post ではなく「過去に一度でも clips に現れた id か」で新規追加を判定する。
	const knownClipIdsRef = useRef<Set<string>>(new Set());

	// 一度でも Post 初期化(下の追従 effect の「初回」パス)を実行したか。`prev.length
	// === 0` だけを初回判定に使うと、ユーザーが全 Post を手動削除して空になった状態を
	// 「初回」と誤認し、無関係な clip 編集(clips 配列の再生成)を契機に削除済み Post が
	// 丸ごと復活してしまう。初回と全削除を区別するためのフラグ(resetToken でのみ戻す)。
	const hasInitializedRef = useRef(false);

	// 新しい元動画選択(App からの resetToken 増加)時のみ、全状態を明示的に破棄する
	// (最重要: 旧実装の「!open で破棄」を削除し、この明示トリガのみへ置き換えた。
	// 通常の画面往復(戻る/進む)では posts・プレビュー・一括設定は保持される)。
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetToken の変化そのものがトリガ(mount 時の初回実行は無害)
	useEffect(() => {
		setPosts([]);
		setSelectedPostId(null);
		setPreviewErrors(new Map());
		preview.reset();
		setOutputPresets([{ targetId: DEFAULT_TARGET_ID, fit: DEFAULT_FIT }]);
		setPresetNote(null);
		setBulkSettingsOpen(false);
		// 実行中の一括保存ジョブを止めてから状態をクリアする。
		bulkExportQueue.reset();
		// 既知 clip id も合わせてクリアする(新しい元動画の clip はすべて「新規」扱い)。
		knownClipIdsRef.current = new Set();
		// 次の clips で初回初期化を再度許可する。
		hasInitializedRef.current = false;
	}, [resetToken]);

	// 初期化(posts が空): clips 全件から Post を生成し、先頭を選択する。
	// 追加(posts が既にある): 過去に認識していない(＝新規に増えた)clip
	// (編集画面での「切り抜きを追加」)に対してのみ Post を追加生成する。
	// 既存 posts の内容・順序・selectedPostId は変えない(下の孤児 post 除去 effect と
	// 対になる「追加」側の同期。これが無いと ClipEditor で clip を増やしても右一覧の
	// 一覧に反映されなかった)。画面を離れて戻ってきても既存の posts は保持される。
	useEffect(() => {
		if (clips.length === 0) return;
		const currentClipIds = new Set(clips.map((c) => c.id));
		const newClips = clips.filter((clip) => !knownClipIdsRef.current.has(clip.id));
		knownClipIdsRef.current = currentClipIds;
		// 初回のみ全 clip から Post を生成する。`prev.length === 0` だけで判定すると
		// ユーザーの全削除後の空状態を初回と誤認し復活させてしまうため、明示フラグで gate
		// する(判定を setPosts の updater 外で行い、二重呼び出しでも選択 id がずれないようにする)。
		if (!hasInitializedRef.current) {
			hasInitializedRef.current = true;
			const created = clips.map((clip) => createPost(clip.id));
			setPosts(created);
			// 初期化直後は先頭 Post を選択する。
			setSelectedPostId(created[0]?.id ?? null);
			return;
		}
		if (newClips.length === 0) return;
		setPosts((prev) => [...prev, ...newClips.map((clip) => createPost(clip.id))]);
	}, [clips]);

	// 孤児 post の無効化: clips から消えた clipId を参照する post を除去する
	// (ExportScreen.tsx の clip 単位の細粒度無効化 effect が手本)。ClipEditor 側で
	// clip を削除しても resetToken が増分されないため posts に参照切れの post が
	// 残り続けていた(存在しない clip を指す post が「対象 clip不明」のまま操作可能に
	// 見えてしまう P1 バグ)。除去する post の Output に紐づくプレビューも合わせて破棄する
	// (private 側の投稿状態・投稿用レンダリングは `onPostsChange` 経由で
	// `usePublishExtras` 自身が posts の変化を見て破棄する)。
	useEffect(() => {
		const validClipIds = new Set(clips.map((c) => c.id));
		const orphanOutputIds = posts
			.filter((p) => !validClipIds.has(p.clipId))
			.flatMap((p) => p.outputs.map((o) => o.id));
		if (orphanOutputIds.length === 0) return;

		setPosts((prev) => prev.filter((p) => validClipIds.has(p.clipId)));
		for (const outputId of orphanOutputIds) {
			preview.remove(outputId);
		}
		setPreviewErrors((prev) => {
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
			title: "項目を削除",
			body: `この項目(${clipName ?? "対象 clip 不明"})を削除します。この操作は取り消せません。`,
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

	/**
	 * private のみ: 生成した予約日時スロットを posts の並び順へ 1 つずつ割り当てる
	 * (1 Post = 1 スロット)。`publishSlots.sidebarActions` が
	 * ScheduleSettingsModal の「割り当て」操作からこれを呼ぶ(§PublishSlots)。
	 */
	const assignScheduleToPosts = (slots: number[]) => {
		setPosts((prev) =>
			prev.map((p, i) => {
				const slot = slots[i];
				return slot !== undefined ? { ...p, publishAt: slot } : p;
			}),
		);
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
			body: "この出力先(ターゲット・設定)を削除します。この操作は取り消せません。",
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
		setPreviewErrors((prev) => {
			const next = new Map(prev);
			next.delete(outputId);
			return next;
		});
		preview.remove(outputId);
	};

	// ---- 出力先テンプレートの一括設定 ----------------------------------------

	const [outputPresets, setOutputPresets] = useState<
		{ targetId: string; fit: FitMode }[]
	>([{ targetId: DEFAULT_TARGET_ID, fit: DEFAULT_FIT }]);
	const [presetNote, setPresetNote] = useState<string | null>(null);
	const [bulkSettingsOpen, setBulkSettingsOpen] = useState(false);

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
			body: `全 ${posts.length} 項目の出力先をこの組み合わせで作り直します。入力済みの設定はリセットされます。`,
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
		// 旧 output.id に紐づく生成結果は破棄する。
		preview.reset();
		setPreviewErrors(new Map());
		setPresetNote(
			`全 ${posts.length} 項目に ${outputPresets.length} 出力先を適用しました。`,
		);
		return true;
	};

	// ---- レンダリング --------------------------------------------------------

	/**
	 * 現在の設定でレンダリング済みなら再利用し、無い/古い場合のみ `preview_start`
	 * (低ビットレート 2Mbps・spec ハッシュキャッシュ)で再レンダリングする。
	 * この画面の「最終プレビュー」欄・DL はこの結果を再利用する(目視確認用なので
	 * 高速なプレビュー品質でよい。DL される実体もプレビュー品質である点は従来どおり —
	 * 実際の保存物が必要なら「フォルダへ保存」を使う)。
	 */
	const ensureRendered = async (
		post: UploadPost,
		output: UploadOutput,
	): Promise<string> => {
		const { input, spec, sig } = buildRenderArgs(source, clips, post, output);
		return preview.ensure(output.id, input, spec, sig);
	};

	// プレビュー生成(現在設定でレンダリング)。
	// ensureRendered は preview.ensure 呼び出し前(buildRenderArgs のガード節)で早期
	// throw することがある(元動画未選択・対象クリップ不明・出力ターゲット無効)。この場合 preview 側の
	// states には何も反映されないため render.error は出ず、以前は catch(() => undefined)
	// で握りつぶされてユーザーに一切見えなくなっていた(P1 バグ)。ここでは早期 throw を
	// 含むあらゆる失敗を `previewErrors`(常時見える表示、§OutputCard.tsx)へも反映し、
	// 必ずユーザーに見える形にする。
	const previewOutput = (post: UploadPost, output: UploadOutput) => {
		void ensureRendered(post, output)
			.then(() => {
				// 撮り直しが成功した後も、前回失敗時に previewErrors へ書き込んだバナーが
				// 残り続けていた(previewErrors は resetToken/preset 再適用/output 削除
				// でしかクリアされないため)。成功したら、その key の古いエラー表示を消す。
				setPreviewErrors((prev) => {
					if (!prev.has(output.id)) return prev;
					const next = new Map(prev);
					next.delete(output.id);
					return next;
				});
			})
			.catch((err: unknown) => {
				if (err instanceof PreviewSupersededError) {
					// cancel-and-restart による打ち切り(usePreview.ts 参照)。設定変更で
					// 撮り直しただけのユーザー操作起因であり失敗ではないため、常時表示の
					// previewErrors には書き込まない(撮り直した側の呼び出しが改めて
					// この then/catch を実行して結果を反映する)。
					return;
				}
				setPreviewErrors((prev) => {
					const next = new Map(prev);
					next.set(output.id, getErrorMessage(err));
					return next;
				});
			});
	};

	// 一括保存可否の判定に使う全 Output 数。
	const totalOutputs = posts.reduce((sum, p) => sum + p.outputs.length, 0);

	/**
	 * フォルダへ保存: 保存先フォルダを選ばせたうえで、全 Post の全 Output を
	 * 実書き出し品質(reframe_start, 既定 8Mbps — 本書き出しと同一品質)で直接
	 * そのフォルダへ書き出す。studio 版は書き出し結果を HTTP 経由の ZIP ダウンロードで
	 * 渡すが、desktop には studio-server が存在しないため同じ経路は使えない(既知ギャップ)。
	 * プレビュー品質(2Mbps, preview_start)の使い回しはしない — プレビュー確認用と
	 * 保存は別ジョブとして扱う。
	 * ジョブは同時に投入してよい(media-core 側のセマフォが並列上限を守る)。
	 */
	const bulkExportMutation = useMutation({
		mutationFn: async (): Promise<
			{ canceled: true } | { canceled: false; ok: number; total: number }
		> => {
			if (!source) throw new Error("元動画が未選択です。");
			// ダイアログの初期表示先には前回選択したフォルダを渡し、選択確定時に更新する
			// (ExportScreen の書き出し先選択と同じパターン。デスクトップが既定表示される
			// 問題を避けるため)。
			const dir = await pickExportDirectory(
				"書き出し先フォルダを選択",
				settings.lastExportDir,
			);
			if (!dir) return { canceled: true };
			updateSettings({ lastExportDir: dir });

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
					const { spec } = buildRenderArgs(source, clips, post, output);
					tasks.push({ output, clip, target, spec });
				}
			}
			if (tasks.length === 0) {
				throw new Error("保存できる出力がありません。");
			}

			// ファイル名の重複を避ける(同一 clip に同一ターゲット+フィットの
			// Output を複数追加した場合など)。ExportScreen の書き出しと同じ採番
			// ロジックを共有する。
			const uniqueNames = uniqueBaseNames(
				tasks,
				(t) => `${sanitizeFileName(t.clip.name)}_${t.target.id}_${t.output.fit}`,
			);

			// key ごとの世代トークン(バグ3: 世代管理)。run() にそのまま渡す。
			const tokens = bulkExportQueue.startBatch(tasks.map((t) => t.output.id));

			const outcomes = await Promise.all(
				tasks.map(async (t) => {
					const base =
						uniqueNames.get(t) ??
						`${sanitizeFileName(t.clip.name)}_${t.target.id}_${t.output.fit}`;
					try {
						const outputPath = await join(dir, `${base}.mp4`);
						// startBatch が tasks 全 output.id 分のトークンを発行済みなので必ず存在する。
						const token = tokens.get(t.output.id);
						if (!token) return false;
						await bulkExportQueue.run(
							token,
							t.output.id,
							source.inputPath,
							outputPath,
							t.spec,
							settings.encoder,
						);
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

	/** 実行中の一括保存ジョブをすべてキャンセルする。 */
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

	// 中央詳細に表示する選択中の Post。
	const selectedPost = posts.find((p) => p.id === selectedPostId) ?? null;

	return (
		<>
			<section ref={rootRef} className="flex h-full min-h-0 flex-col">
				{/* ステップ遷移時のフォーカス移動先(a11y、App.tsx goToStep 参照)。視覚上は非表示。 */}
				<h2 id="wizard-panel-heading-upload" tabIndex={-1} className="sr-only">
					リフレーム
				</h2>
				<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
					{publishSlots?.banner}
					<div className="flex min-h-0 flex-1 items-start gap-3">
						{/* 中央: 選択中 Post の詳細 */}
						<div className="max-h-full min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
							{selectedPost ? (
								<PostDetail
									key={selectedPost.id}
									post={selectedPost}
									clips={clips}
									renders={preview.states}
									previewErrors={previewErrors}
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
									scheduleSlot={publishSlots?.renderPostSection(
										selectedPost,
										(patch) => patchPost(selectedPost.id, patch),
									)}
									renderOutputExtra={(output) =>
										publishSlots?.renderOutputSection(
											selectedPost,
											output,
											(patch) => patchOutput(selectedPost.id, output.id, patch),
										)
									}
								/>
							) : (
								<p className="rounded-md border border-dashed border-line px-3 py-10 text-center text-xs text-neutral-400">
									右の一覧から項目を選択してください。
								</p>
							)}
						</div>

						{/* 右: 項目(Post)一覧 */}
						<div className="max-h-full min-h-0 w-72 shrink-0 overflow-y-auto border-l border-line pl-3">
							<div className="flex flex-col gap-2">
								<Button
									variant="secondary"
									size="sm"
									onClick={() => setBulkSettingsOpen(true)}
								>
									一括設定…
								</Button>
								{publishSlots?.sidebarActions?.(assignScheduleToPosts)}
								<Button
									variant="secondary"
									size="sm"
									onClick={() => bulkExportMutation.mutate()}
									disabled={totalOutputs === 0 || bulkExportMutation.isPending}
								>
									{bulkExportMutation.isPending ? "保存中…" : "フォルダへ保存"}
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
									+ 項目を追加
								</Button>
							</div>

							<div className="mt-3 flex flex-col gap-1.5">
								{posts.length === 0 && (
									<p className="rounded-md border border-dashed border-line px-2 py-4 text-center text-[11px] text-neutral-400">
										項目がありません。
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
										extra={publishSlots?.renderPostRowExtra(post)}
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
					{publishSlots?.footerActions}
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
		</>
	);
}
