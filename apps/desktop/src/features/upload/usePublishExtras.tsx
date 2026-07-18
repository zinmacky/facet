import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Source } from "../../App";
import type { Clip, OutputTarget } from "../../types";
import { targetById } from "../../types";
import { generateSchedule, msToLocalInput } from "../../lib/schedule";
import { usePreview } from "../../lib/usePreview";
import { getErrorMessage } from "../../lib/getErrorMessage";
import { Button } from "../../components/ui/Button";
import { usePublishGateContext } from "../publish-settings/PublishGateContext";
import { describeIgPublishError, startIgPublish } from "./igPublish";
import {
	describeYoutubePublishError,
	startYoutubePublish,
} from "./youtubePublish";
import { OutputPublishSection } from "./OutputPublishSection";
import { PostScheduleSection } from "./PostScheduleSection";
import { ScheduleSettingsModal } from "./ScheduleSettingsModal";
import { isPlatformPublishSupported, type PubStatus } from "./publishSupport";
import type { PublishSlots } from "./ReframeScreen";
import {
	buildRenderArgs,
	type UploadOutput,
	type UploadPost,
} from "./uploadTypes";

interface UsePublishExtrasArgs {
	clips: Clip[];
	source: Omit<Source, "videoSrc"> | null;
	/** ReframeScreen が所有する posts の読み取り専用ミラー(§UploadScreenPrivate.tsx)。 */
	posts: UploadPost[];
	resetToken: number;
}

/**
 * リフレーム画面の private 専用部分(投稿: スケジュール・キャプション・IG/YT 連携)を
 * まとめて実装するフック。戻り値の `PublishSlots` を `ReframeScreen` へ渡すことで
 * 投稿系 UI を描画する(`UploadScreenPrivate.tsx` 参照)。
 *
 * このファイルおよびここから import する `igPublish.ts` / `ScheduleSettingsModal.tsx` /
 * `PostScheduleSection.tsx` / `OutputPublishSection.tsx` / `PublishGateContext` /
 * `schedulerUrlStore.ts` / `publishSupport.ts` は private エディションからしか
 * import されない(entry.ts 経由)ため、public バンドルには一切含まれない。
 */
export function usePublishExtras({
	clips,
	source,
	posts,
	resetToken,
}: UsePublishExtrasArgs): PublishSlots {
	// output.id → 投稿処理の進行状態。
	const [pubStatuses, setPubStatuses] = useState<Map<string, PubStatus>>(
		new Map(),
	);
	// output.id → 投稿用レンダリング結果(本書き出しと同一品質 8Mbps、publish-cache)。
	// 目視確認は共通側の高速な 2Mbps(preview)のまま、実際に IG へ投稿される実体のみ
	// この publish 品質を使う(preview とはキャッシュディレクトリごと分離される —
	// §src-tauri/src/commands/preview.rs の RenderQuality)。
	const publishRender = usePreview("publish");
	// 実行時ゲート(§features/publish-settings/PublishGateContext.tsx、
	// docs/desktop-migration-plan.md §6.6・§11-3)。`igReady`(scheduler 疎通 OK かつ
	// R2 資格情報保存済み)+ `isPlatformPublishSupported`(コード対応状況)の両方を
	// 満たす場合のみ Instagram への投稿ボタンを有効化する(`canPublishTarget` 参照)。
	const publishGate = usePublishGateContext();

	// 一括予約スケジュールの入力状態。
	const [startDate, setStartDate] = useState("");
	const [endDate, setEndDate] = useState("");
	const [weekdayTimes, setWeekdayTimes] = useState<Record<number, string[]>>(
		{},
	);
	const [assignNote, setAssignNote] = useState<string | null>(null);
	const [scheduleSettingsOpen, setScheduleSettingsOpen] = useState(false);

	// 新しい元動画選択(resetToken 増加)時のみ、投稿系の全状態を明示的に破棄する
	// (§ReframeScreen.tsx の同種 effect と対になる、private 側の破棄)。
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetToken の変化そのものがトリガ(mount 時の初回実行は無害)
	useEffect(() => {
		setPubStatuses(new Map());
		publishRender.reset();
		setStartDate("");
		setEndDate("");
		setWeekdayTimes({});
		setAssignNote(null);
		setScheduleSettingsOpen(false);
	}, [resetToken]);

	// posts から消えた output.id の投稿状態・投稿用レンダリングを破棄する(孤児防止。
	// ReframeScreen 側の孤児 post 除去 effect が `posts` state 自体を更新すると、
	// その変化がここへ `posts` prop 経由で伝わってくる — §UploadScreenPrivate.tsx の
	// posts ミラー)。
	const knownOutputIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const currentIds = new Set(posts.flatMap((p) => p.outputs.map((o) => o.id)));
		const removed = [...knownOutputIdsRef.current].filter(
			(id) => !currentIds.has(id),
		);
		knownOutputIdsRef.current = currentIds;
		if (removed.length === 0) return;
		setPubStatuses((prev) => {
			const next = new Map(prev);
			for (const id of removed) next.delete(id);
			return next;
		});
		for (const id of removed) publishRender.remove(id);
	}, [posts, publishRender.remove]);

	/** `target` への投稿がボタンとして有効化されるか(コード対応 + 実行時ゲート)。 */
	const canPublishTarget = (target: OutputTarget | undefined): boolean => {
		if (!target) return false;
		if (!isPlatformPublishSupported(target.platform)) return false;
		if (target.platform === "instagram") return publishGate.igReady;
		if (target.platform === "youtube") return publishGate.ytReady;
		return false;
	};

	const setPubStatus = (outputId: string, status: PubStatus) => {
		setPubStatuses((prev) => {
			const next = new Map(prev);
			next.set(outputId, status);
			return next;
		});
	};

	/**
	 * 投稿用レンダリング。`ReframeScreen` の `ensureRendered` と同じキャッシュ方式
	 * (sig 一致なら再利用)だが、品質は本書き出しと同一(8Mbps)・生成先は
	 * `publish-cache`(プレビューと分離)。IG へ投稿される実体は必ずこちらを通す
	 * (プレビュー品質 2Mbps の動画が投稿される問題の修正)。ファイルサイズ上限
	 * (≤300MB)等のバリデーションは、この結果のパスを受け取った `ig_publish_start`
	 * (Rust 側)がアップロード前に 8Mbps 生成物へ対して行う。
	 */
	const ensurePublishRendered = async (
		post: UploadPost,
		output: UploadOutput,
	): Promise<string> => {
		const { input, spec, sig } = buildRenderArgs(source, clips, post, output);
		return publishRender.ensure(output.id, input, spec, sig);
	};

	// Instagram は R2 アップロード + scheduler へのジョブ登録(`ig_publish_start`、
	// §6.4)、YouTube は OAuth + resumable upload + publishAt(`youtube_publish_start`、
	// §6.5)をいずれも native(Rust)で実装済み。`canPublishTarget` が false の間は
	// disabled にし、万一すり抜けて呼ばれてもここで即エラー表示に倒す防御的ガードを置く。

	/** 1 Output を投稿する。publishAt は post.publishAt(全出力共通)を使う。 */
	const publishOutput = async (
		post: UploadPost,
		output: UploadOutput,
	): Promise<void> => {
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
		if (!canPublishTarget(target)) {
			setPubStatus(output.id, {
				kind: "error",
				message:
					target.platform === "instagram"
						? "Instagram への投稿には設定(scheduler + R2)が必要です。設定画面から入力してください。"
						: "YouTube への投稿には Google との接続が必要です。設定画面から接続してください。",
			});
			return;
		}
		// タイトル必須は Rust 側(youtube_publish_start)でも検証されるが、8Mbps の
		// 投稿用レンダリング(数十秒かかりうる)の前に判明できる失敗はここで先に弾く。
		if (target.platform === "youtube" && !output.title.trim()) {
			setPubStatus(output.id, {
				kind: "error",
				message: "タイトルは必須です。投稿設定でタイトルを入力してください。",
			});
			return;
		}

		try {
			// 1. 投稿用レンダリング(本書き出しと同一品質 8Mbps。生成済みなら再利用)。
			setPubStatus(output.id, { kind: "rendering" });
			const outputPath = await ensurePublishRendered(post, output);

			// 2. 投稿。
			setPubStatus(output.id, { kind: "publishing" });
			await publishTo(target, post, output, outputPath);

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
	 * プラットフォーム別の投稿。進捗を `pubStatuses` の message に反映する。
	 * - Instagram: R2 アップロード + scheduler 登録(`startIgPublish`、§6.4)。
	 * - YouTube: resumable upload + publishAt 予約(`startYoutubePublish`、§6.5)。
	 *   タイトル/説明は `UploadOutput` のメタデータ(`title`/`description`)を使う。
	 *   publishAt 指定時は YouTube 側が時刻公開を担う(scheduler は経由しない)。
	 */
	const publishTo = async (
		target: OutputTarget,
		post: UploadPost,
		output: UploadOutput,
		outputPath: string,
	): Promise<void> => {
		if (target.platform === "youtube") {
			await new Promise<void>((resolve, reject) => {
				startYoutubePublish(
					{
						inputPath: outputPath,
						title: output.title,
						description: output.description,
						// IG(scheduler 必須)と異なり、YouTube は publishAt 未指定を
						// 「即時アップロード(private)」として自然に扱えるため
						// Date.now() での補完はしない(旧 studio 版と同じ扱い)。
						...(post.publishAt !== undefined
							? { publishAt: post.publishAt }
							: {}),
					},
					{
						onProgress: (progress) => {
							setPubStatus(output.id, {
								kind: "publishing",
								message: `アップロード中 ${Math.round(progress.percent)}%`,
							});
						},
						onDone: () => resolve(),
						onError: (error) =>
							reject(new Error(describeYoutubePublishError(error))),
					},
				).catch((err: unknown) => {
					reject(err instanceof Error ? err : new Error(getErrorMessage(err)));
				});
			});
			return;
		}

		const publishAt = post.publishAt ?? Date.now();

		await new Promise<void>((resolve, reject) => {
			startIgPublish(
				{
					inputPath: outputPath,
					caption: output.caption,
					publishAt,
				},
				{
					onProgress: (progress) => {
						setPubStatus(output.id, {
							kind: "publishing",
							message:
								progress.phase === "uploading"
									? `アップロード中 ${Math.round(progress.percent)}%`
									: "投稿ジョブを登録中…",
						});
					},
					onDone: () => resolve(),
					onError: (error) => reject(new Error(describeIgPublishError(error))),
				},
			).catch((err: unknown) => {
				reject(err instanceof Error ? err : new Error(getErrorMessage(err)));
			});
		});
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
	const totalOutputs = posts.reduce((sum, p) => sum + p.outputs.length, 0);
	/** 「すべて投稿」ボタンの活性化判定: いずれかの Output が投稿可能(canPublishTarget)か。 */
	const anyPublishableOutput = posts.some((post) =>
		post.outputs.some((output) => canPublishTarget(targetById(output.targetId))),
	);

	// ---- 曜日・時刻リスト操作 ------------------------------------------------

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

	return {
		busy,
		banner: (
			<>
				{!publishGate.igReady && (
					<div className="shrink-0 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
						Instagram
						への投稿には設定(scheduler の疎通確認 + R2 資格情報)が必要です。設定画面から入力してください。
						{publishGate.ready && !publishGate.hasR2Credentials && (
							<> (scheduler の疎通は OK です。R2 資格情報が未設定です。)</>
						)}
					</div>
				)}
				{!publishGate.ytReady && (
					<div className="shrink-0 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
						YouTube
						への投稿には設定(OAuth クライアント + Google 接続)が必要です。設定画面から接続してください。
					</div>
				)}
				{publishGate.ytReady && (
					// §12.2: publishAt(予約公開)は監査済み Google Cloud プロジェクトのみ
					// 有効で、未監査プロジェクトでは private 固定のまま自動公開されない
					// (API はエラーを返さないため実行時には検知できない)。常時表示の警告と
					// してユーザーに伝える(docs/desktop-migration-plan.md §6.5・§12.2)。
					<div className="shrink-0 rounded-md border border-line bg-elevated/40 px-3 py-2 text-[11px] text-neutral-400">
						YouTube
						の予約公開(公開日時指定)は監査済みの Google Cloud プロジェクトでのみ機能します。未監査の場合は非公開のままアップロードされるため、YouTube
						Studio で手動予約してください。
					</div>
				)}
			</>
		),
		sidebarActions: (assignSchedule) => (
			<>
				<Button
					variant="secondary"
					size="sm"
					onClick={() => setScheduleSettingsOpen(true)}
				>
					予約スケジュール…
				</Button>
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
					onAssign={() => {
						const slots = generateSchedule({ startDate, endDate, weekdayTimes });
						assignSchedule(slots);
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
					}}
				/>
			</>
		),
		footerActions: (
			<Button
				variant="primary"
				onClick={() => publishAllMutation.mutate()}
				disabled={busy || totalOutputs === 0 || !anyPublishableOutput}
				title={
					anyPublishableOutput
						? undefined
						: "投稿可能な出力先がありません(Instagram / YouTube の設定を確認してください)"
				}
			>
				すべて投稿
			</Button>
		),
		renderPostRowExtra: (post) => {
			const scheduleLabel =
				post.publishAt !== undefined
					? msToLocalInput(post.publishAt).replace("T", " ")
					: "即時";
			return (
				<span className="truncate text-[11px] text-neutral-400" title={scheduleLabel}>
					{scheduleLabel}
				</span>
			);
		},
		renderPostSection: (post, onPatchPost) => {
			const anyOutputPublishable = post.outputs.some((o) =>
				canPublishTarget(targetById(o.targetId)),
			);
			return (
				<PostScheduleSection
					post={post}
					busy={busy}
					anyOutputPublishable={anyOutputPublishable}
					onPatchPost={onPatchPost}
					onPublishPost={() => publishPostMutation.mutate(post)}
				/>
			);
		},
		renderOutputSection: (post, output, onPatchOutput) => {
			const target = targetById(output.targetId);
			return (
				<OutputPublishSection
					output={output}
					platform={target?.platform}
					status={pubStatuses.get(output.id)}
					busy={busy}
					canPublish={canPublishTarget(target)}
					onPatch={onPatchOutput}
					onPublish={() => void publishOutput(post, output).catch(() => undefined)}
				/>
			);
		},
	};
}
