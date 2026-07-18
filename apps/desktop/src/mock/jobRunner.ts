import { mockEmit } from "./eventBus";
import { MOCK_OUTPUT_PATH } from "./fixtures";

/**
 * `reframe_start`/`preview_start` のジョブ進行を模す(dev:mock 専用)。
 * `setInterval` で 200ms 刻みに `{namespace}://progress/{jobId}` を発火し、
 * 数秒(既定 15 ステップ = 3s)かけて 0→100% へ進めたのち `{namespace}://done/{jobId}` を
 * 発火する。`reframe_cancel`(`cancelMockJob`)で中断でき、その場合 done は発火しない。
 * `media_core::progress::Progress`/各コマンドの done ペイロード(§lib/tauri.ts)と同形。
 */

interface StartMockJobOptions {
	namespace: "reframe" | "preview" | "ig_publish" | "youtube_publish";
	jobId: string;
	/** progress イベントの fps/frame 換算用(見た目のみ、実エンコードは行わない)。 */
	fps?: number;
	totalFrames?: number;
}

const STEP_MS = 200;
const STEPS = 15; // 200ms * 15 = 3s で 0→100%。

const timers = new Map<string, ReturnType<typeof setInterval>>();

/** ジョブ進行のシミュレーションを開始する。`jobId` はそのまま返す。 */
export function startMockJob(opts: StartMockJobOptions): string {
	const { namespace, jobId } = opts;
	const fps = opts.fps ?? 30;
	const totalFrames = opts.totalFrames ?? fps * 30;
	let tick = 0;

	const timer = setInterval(() => {
		tick += 1;
		const percent = Math.min(100, Math.round((tick / STEPS) * 1000) / 10);
		const frame = Math.round((percent / 100) * totalFrames);

		if (namespace === "ig_publish" || namespace === "youtube_publish") {
			// アップロード系ジョブの進捗形(`IgPublishProgress`/`YoutubePublishProgress`、
			// どちらも `phase: "uploading"` タグの同形。§features/upload/igPublish.ts,
			// §features/upload/youtubePublish.ts)。
			mockEmit(`${namespace}://progress/${jobId}`, {
				phase: "uploading",
				bytesSent: Math.round((percent / 100) * 1_000_000),
				totalBytes: 1_000_000,
				percent,
			});
		} else {
			mockEmit(`${namespace}://progress/${jobId}`, {
				frame,
				totalFrames,
				percent,
				outTimeSecs: frame / fps,
				fps,
				speed: 1.8,
			});
		}

		if (tick >= STEPS) {
			clearInterval(timer);
			timers.delete(jobId);
			if (namespace === "reframe") {
				// libx264 は desktop 移行時に破棄済み(§docs/desktop-migration-plan.md)。
				// dev:mock のスクリーンショットに残存 encoder が映り込まないよう、
				// 実際に使う HW エンコーダ(mac の videotoolbox)の値を返す。
				mockEmit(`reframe://done/${jobId}`, { encoder: "h264_videotoolbox" });
			} else if (namespace === "preview") {
				mockEmit(`preview://done/${jobId}`, { path: MOCK_OUTPUT_PATH });
			} else if (namespace === "ig_publish") {
				mockEmit(`ig_publish://done/${jobId}`, {
					schedulerJobId: `mock-scheduler-job-${jobId}`,
					status: "pending",
				});
			} else {
				// 実際は publishAt 指定時に "scheduled" になりうる(§youtubePublish.ts の
				// YoutubePublishDone コメント参照)が、このジョブ進行シミュレータは publishAt を
				// 受け取らないため区別できない。ig_publish の固定 "pending" と同様、
				// UI 確認用の固定終端値として "private" を返す。
				mockEmit(`youtube_publish://done/${jobId}`, {
					videoId: `mock-youtube-video-${jobId}`,
					status: "private",
				});
			}
		}
	}, STEP_MS);

	timers.set(jobId, timer);
	return jobId;
}

/** `jobId` の進行中シミュレーションを中断する(done は発火しない)。未知の jobId は無視する。 */
export function cancelMockJob(jobId: string): void {
	const timer = timers.get(jobId);
	if (timer === undefined) return;
	clearInterval(timer);
	timers.delete(jobId);
}
