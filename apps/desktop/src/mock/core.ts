import { MOCK_IG_JOB_RECORD, MOCK_PROBE, MOCK_SAMPLE_URL } from "./fixtures";
import { cancelMockJob, startMockJob } from "./jobRunner";

/**
 * `@tauri-apps/api/core` の dev:mock 用差し替え(`invoke`/`convertFileSrc`)。
 * `apps/desktop/src/lib/tauri.ts` が使うコマンドのみを実装する(§commands/*.rs の
 * renderer 向け API と同形のレスポンスを返す)。
 *
 * ここで実装するコマンド集合は `invoke-parity.test.ts` が renderer 側の呼び出しと
 * 突き合わせて検証する — 新しい invoke コマンドを追加してこのファイルへの対応
 * (またはテスト内 allowlist への追記)を忘れるとそのテストが落ちる。
 */

// 公開連携(publish 系コマンド)のインメモリ状態。dev:mock は private エディション
// 既定のため、`PublishGateProvider`(App マウント時)や設定ダイアログがこれらの
// コマンドを呼ぶ。ブラウザ確認用に「保存すればゲートが開く」最小挙動のみ実装する
// (test/tauri-mock.ts の defaultInvokeImpl と同じシナリオ)。
let mockSchedulerApiToken: string | null = null;
let mockHasR2Credentials = false;

// scheduler URL のインメモリモック状態(§features/publish-settings/schedulerUrlStore.ts)。
// `usePublishGate` がマウント時に `getSchedulerUrl()`(内部で `get_scheduler_url` を
// 呼ぶ)経由でこれを読むため、未実装だと dev:mock 起動直後に例外になっていた。
let mockSchedulerUrl: string | null = null;

// YouTube OAuth のインメモリモック状態(§commands/publish/youtube_oauth.rs)。
// クライアント(client_id/secret)とトークンキャッシュ(接続済みフラグ)の2段構え
// (test/tauri-mock.ts の defaultInvokeImpl と同じ状態設計)。
let mockYoutubeOauthClient: { clientId: string; clientSecret: string } | null =
	null;
let mockYoutubeOauthConnected = false;

export async function invoke<T>(
	cmd: string,
	args?: Record<string, unknown>,
): Promise<T> {
	switch (cmd) {
		case "probe":
			return MOCK_PROBE as unknown as T;

		case "reframe_start": {
			// renderer(§lib/tauri.ts)が採番した jobId をそのまま使う。独自採番すると
			// emit する `reframe://progress/<id>` と renderer が listen する UUID が
			// 食い違い、進捗・done・cancel が一切届かなくなる(§ig_publish_start と同規則)。
			const jobId = typeof args?.jobId === "string" ? args.jobId : "";
			startMockJob({ namespace: "reframe", jobId });
			return jobId as unknown as T;
		}

		case "preview_start": {
			const jobId = typeof args?.jobId === "string" ? args.jobId : "";
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
		case "set_scheduler_api_token": {
			const token = typeof args?.token === "string" ? args.token.trim() : "";
			if (!token) throw new Error("トークンが空です。");
			mockSchedulerApiToken = token;
			return undefined as unknown as T;
		}
		case "has_scheduler_api_token":
			return (mockSchedulerApiToken !== null) as unknown as T;
		case "delete_scheduler_api_token":
			mockSchedulerApiToken = null;
			return undefined as unknown as T;
		case "check_scheduler_connection":
			// 実コマンド(§commands/publish/scheduler_check.rs)と同じ優先順位: URL 未設定を
			// トークン未設定より先に判定する(test/tauri-mock.ts の同ケースと揃える)。
			if (mockSchedulerUrl === null) return { status: "no_url" } as unknown as T;
			return (
				mockSchedulerApiToken === null ? { status: "no_token" } : { status: "ok" }
			) as unknown as T;
		case "set_scheduler_url": {
			const trimmed =
				typeof args?.url === "string" ? args.url.trim() : "";
			if (!trimmed) throw new Error("scheduler_url が空です。");
			mockSchedulerUrl = trimmed;
			return undefined as unknown as T;
		}
		case "get_scheduler_url":
			return mockSchedulerUrl as unknown as T;
		case "delete_scheduler_url":
			mockSchedulerUrl = null;
			return undefined as unknown as T;
		case "set_r2_credentials": {
			// 実コマンド/test/tauri-mock.ts と同じ必須項目バリデーション。bucket は空なら
			// Rust 側の既定値相当を使う想定のため必須にしない(値そのものは保持しない —
			// このモックは「保存済みか」の boolean のみ管理する)。
			const accountId = typeof args?.accountId === "string" ? args.accountId.trim() : "";
			const accessKeyId =
				typeof args?.accessKeyId === "string" ? args.accessKeyId.trim() : "";
			const secretAccessKey =
				typeof args?.secretAccessKey === "string" ? args.secretAccessKey.trim() : "";
			if (!accountId || !accessKeyId || !secretAccessKey) {
				throw new Error(
					"R2 のアカウント ID・アクセスキー ID・シークレットアクセスキーは必須です。",
				);
			}
			mockHasR2Credentials = true;
			return undefined as unknown as T;
		}
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
		case "ig_job_status": {
			// 呼び出し側が渡した schedulerJobId をそのまま id として返す(§features/upload/igPublish.ts、
			// test/tauri-mock.ts の同ケースと揃える)。既定 status は "published"(終端・無害)。
			const schedulerJobId =
				typeof args?.schedulerJobId === "string" ? args.schedulerJobId : undefined;
			return {
				outcome: "found",
				...MOCK_IG_JOB_RECORD,
				id: schedulerJobId ?? MOCK_IG_JOB_RECORD.id,
			} as unknown as T;
		}

		// ---- YouTube OAuth / 公開(§commands/publish/youtube_oauth.rs, youtube.rs) --------
		case "set_youtube_oauth_client": {
			const clientId = typeof args?.clientId === "string" ? args.clientId.trim() : "";
			const clientSecret =
				typeof args?.clientSecret === "string" ? args.clientSecret.trim() : "";
			if (!clientId || !clientSecret) {
				throw new Error("クライアントIDとクライアントシークレットは必須です。");
			}
			mockYoutubeOauthClient = { clientId, clientSecret };
			return undefined as unknown as T;
		}
		case "delete_youtube_oauth_client":
			// Rust 側と同じく、クライアント削除はトークンキャッシュも道連れにする。
			mockYoutubeOauthClient = null;
			mockYoutubeOauthConnected = false;
			return undefined as unknown as T;
		case "youtube_oauth_status":
			if (mockYoutubeOauthClient === null) {
				return { status: "not_configured" } as unknown as T;
			}
			return (
				mockYoutubeOauthConnected
					? { status: "connected" }
					: { status: "configured" }
			) as unknown as T;
		case "youtube_oauth_connect":
			if (mockYoutubeOauthClient === null) {
				throw new Error(
					"YouTube の OAuth クライアント(クライアントID/シークレット)が未設定です。設定画面から入力してください。",
				);
			}
			mockYoutubeOauthConnected = true;
			return undefined as unknown as T;
		case "youtube_oauth_disconnect":
			mockYoutubeOauthConnected = false;
			return undefined as unknown as T;

		case "youtube_publish_start": {
			// 実アップロードは行わない。progress→done をタイマーで流すだけの疑似ジョブ
			// (ig_publish_start と同じ jobRunner を使う。§mock/jobRunner.ts)。
			const jobId = typeof args?.jobId === "string" ? args.jobId : "";
			startMockJob({ namespace: "youtube_publish", jobId });
			return undefined as unknown as T;
		}
		case "youtube_publish_cancel": {
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
