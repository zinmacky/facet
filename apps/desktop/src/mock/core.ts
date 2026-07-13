import { MOCK_PROBE, MOCK_SAMPLE_URL } from "./fixtures";
import { cancelMockJob, startMockJob } from "./jobRunner";

/**
 * `@tauri-apps/api/core` の dev:mock 用差し替え(`invoke`/`convertFileSrc`)。
 * `apps/desktop/src/lib/tauri.ts` が使うコマンドのみを実装する(§commands/*.rs の
 * renderer 向け API と同形のレスポンスを返す)。
 */

let jobSeq = 0;

// 公開連携(publish 系コマンド)のインメモリ状態。dev:mock は private エディション
// 既定のため、`PublishGateProvider`(App マウント時)や設定ダイアログがこれらの
// コマンドを呼ぶ。ブラウザ確認用に「保存すればゲートが開く」最小挙動のみ実装する
// (test/tauri-mock.ts の defaultInvokeImpl と同じシナリオ)。
let mockSchedulerApiToken: string | null = null;
let mockHasR2Credentials = false;

export async function invoke<T>(
	cmd: string,
	args?: Record<string, unknown>,
): Promise<T> {
	switch (cmd) {
		case "probe":
			return MOCK_PROBE as unknown as T;

		case "reframe_start": {
			jobSeq += 1;
			const jobId = `mock-reframe-${jobSeq}`;
			startMockJob({ namespace: "reframe", jobId });
			return jobId as unknown as T;
		}

		case "preview_start": {
			jobSeq += 1;
			const jobId = `mock-preview-${jobSeq}`;
			startMockJob({ namespace: "preview", jobId });
			return jobId as unknown as T;
		}

		case "reframe_cancel": {
			const jobId = typeof args?.jobId === "string" ? args.jobId : "";
			cancelMockJob(jobId);
			return undefined as unknown as T;
		}

		case "set_max_concurrent_encodes":
			// dev:mock はジョブを実際には並列実行しないため、値の保持は不要(no-op)。
			return undefined as unknown as T;

		// ---- 公開連携(§commands/publish/)。UI 確認用の最小実装 ------------------
		case "set_scheduler_api_token":
			mockSchedulerApiToken =
				typeof args?.token === "string" ? args.token : null;
			return undefined as unknown as T;
		case "has_scheduler_api_token":
			return (mockSchedulerApiToken !== null) as unknown as T;
		case "delete_scheduler_api_token":
			mockSchedulerApiToken = null;
			return undefined as unknown as T;
		case "check_scheduler_connection":
			return (
				mockSchedulerApiToken === null ? { status: "no_token" } : { status: "ok" }
			) as unknown as T;
		case "set_r2_credentials":
			mockHasR2Credentials = true;
			return undefined as unknown as T;
		case "has_r2_credentials":
			return mockHasR2Credentials as unknown as T;
		case "delete_r2_credentials":
			mockHasR2Credentials = false;
			return undefined as unknown as T;

		case "ig_publish_start": {
			// 実アップロードは行わない。進捗→完了をタイマーで流すだけの疑似ジョブ。
			const jobId = typeof args?.jobId === "string" ? args.jobId : "";
			startMockJob({ namespace: "ig_publish", jobId });
			return undefined as unknown as T;
		}
		case "ig_publish_cancel": {
			const jobId = typeof args?.jobId === "string" ? args.jobId : "";
			cancelMockJob(jobId);
			return undefined as unknown as T;
		}

		default:
			throw new Error(`[mock] invoke not implemented for command: ${cmd}`);
	}
}

/** 引数のパスに関わらず、常に `public/mock/sample.mp4` の URL を返す。 */
export function convertFileSrc(_path: string): string {
	return MOCK_SAMPLE_URL;
}
