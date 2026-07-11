import { MOCK_PROBE, MOCK_SAMPLE_URL } from "./fixtures";
import { cancelMockJob, startMockJob } from "./jobRunner";

/**
 * `@tauri-apps/api/core` の dev:mock 用差し替え(`invoke`/`convertFileSrc`)。
 * `apps/desktop/src/lib/tauri.ts` が使うコマンドのみを実装する(§commands/*.rs の
 * renderer 向け API と同形のレスポンスを返す)。
 */

let jobSeq = 0;

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

		default:
			throw new Error(`[mock] invoke not implemented for command: ${cmd}`);
	}
}

/** 引数のパスに関わらず、常に `public/mock/sample.mp4` の URL を返す。 */
export function convertFileSrc(_path: string): string {
	return MOCK_SAMPLE_URL;
}
