import { env, fetchMock, runDurableObjectAlarm } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * PublishDO を real Durable Object(workerd)として動かす統合テスト。
 * src/publish-do.test.ts(単体)は DurableObjectState.storage / Env.DB を
 * インメモリのフェイクに差し替えて状態機械のロジックだけを検証しており、
 * 実際の DO ランタイム(alarm ディスパッチ、storage の永続化)や real D1 は
 * 一度も経由していなかった。ここでは IG Graph API 呼び出しのみ fetch レベルで
 * スタブ化し、それ以外(D1 / DO / alarm)は実物を使う。
 *
 * バックオフ定数やリトライ回数(PR #130 で指数バックオフ・既定8回に変更)などの
 * 細部には依存せず、「/start → alarm → published」という構造的な状態遷移だけを
 * 検証する。/start の pending → creating は claimPendingForCreating(条件付き
 * UPDATE)による原子的 claim を内部で通過する(claim の D1 プリミティブ自体の
 * 検証は test/integration/d1-schema.test.ts 側)。
 *
 * 1ファイル1テストに意図的にまとめている: real DO(ファイル永続化された
 * SQLite ストレージ)へ複数の it() で個別にアクセスすると、vitest-pool-workers の
 * isolatedStorage スタックの pop に失敗する既知の問題がある
 * (https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage)。
 * ここでは「起動の冪等性」と「alarm を経た公開までの遷移」を1つの流れとして
 * 検証することで実害なく回避する。
 */

const GRAPH_ORIGIN = "https://graph.facebook.com";
const JOB_ID = "do-happy-path";

async function insertPendingJob(jobId: string): Promise<void> {
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO jobs
      (id, idempotency_key, platform, r2_key, media_type, caption, publish_at,
       status, attempts, created_at, updated_at)
     VALUES (?, ?, 'instagram', ?, 'REELS', ?, ?, 'pending', 0, ?, ?)`,
	)
		.bind(jobId, `idem-${jobId}`, "2026/07/19/uuid.mp4", "caption", now, now, now)
		.run();
}

async function loadJob(jobId: string): Promise<{
	status: string;
	ig_container_id: string | null;
	ig_media_id: string | null;
}> {
	const row = await env.DB.prepare(
		"SELECT status, ig_container_id, ig_media_id FROM jobs WHERE id = ?",
	)
		.bind(jobId)
		.first<{
			status: string;
			ig_container_id: string | null;
			ig_media_id: string | null;
		}>();
	if (row === null) throw new Error("job not found");
	return row;
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterAll(() => {
	fetchMock.deactivate();
});

afterEach(() => {
	// 登録した interceptor が全て消費されたことを確認する。2回目の /start が
	// 本当に早期リターンしているなら createContainer 用の interceptor は
	// 1個しか登録していないため、ここが通ることで冪等性を裏付ける
	// (もし冪等化が壊れて2回 fetch されると、undici が
	// 「一致する interceptor が無い」で例外を投げてテスト自体が失敗する)。
	fetchMock.assertNoPendingInterceptors();
});

describe("PublishDO: /start(冪等)→ alarm → published", () => {
	it("2回目の /start は何もせず、alarm 経由で FINISHED から公開まで完走する", async () => {
		await insertPendingJob(JOB_ID);
		await env.TOKENS.put("ig_long_lived", "test-long-lived-token");

		const origin = fetchMock.get(GRAPH_ORIGIN);
		// createContainer は1回しか登録しない: 2回目の /start が冪等(早期リターン)で
		// あることを、この interceptor が1回しか消費されないことで裏付ける。
		origin
			.intercept({ path: "/v21.0/test-ig-user/media", method: "POST" })
			.reply(200, { id: "container-1" });
		origin
			.intercept({
				path: "/v21.0/container-1?fields=status_code",
				method: "GET",
			})
			.reply(200, { status_code: "FINISHED" });
		origin
			.intercept({ path: "/v21.0/test-ig-user/media_publish", method: "POST" })
			.reply(200, { id: "media-1" });

		const stub = env.PUBLISH_DO.get(env.PUBLISH_DO.idFromName(JOB_ID));

		// 1回目の /start: pending → creating → runCreate 成功で processing。
		const startRes = await stub.fetch("https://do/start", {
			method: "POST",
			body: JSON.stringify({ jobId: JOB_ID }),
		});
		expect(startRes.status).toBe(200);
		expect(await startRes.json()).toEqual({ status: "processing" });

		let job = await loadJob(JOB_ID);
		expect(job.status).toBe("processing");
		expect(job.ig_container_id).toBe("container-1");
		expect(job.ig_media_id).toBeNull();

		// 2回目の /start(cron の再スキャン等での重複起動を模す): status が
		// pending でなくなっているため早期リターンし、createContainer は
		// 再実行されない(fetchMock の interceptor が1個しか無いことで保証)。
		const secondStartRes = await stub.fetch("https://do/start", {
			method: "POST",
			body: JSON.stringify({ jobId: JOB_ID }),
		});
		expect(secondStartRes.status).toBe(200);
		expect(await secondStartRes.json()).toEqual({ status: "processing" });

		// alarm 発火(ポーリング): FINISHED なので publishing へ進み、公開まで完走する。
		const alarmRan = await runDurableObjectAlarm(stub);
		expect(alarmRan).toBe(true);

		job = await loadJob(JOB_ID);
		expect(job.status).toBe("published");
		expect(job.ig_media_id).toBe("media-1");
	});
});
