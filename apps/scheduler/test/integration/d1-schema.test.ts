import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { scanDueJobs } from "../../src/cron.js";
import type { Env } from "../../src/env.js";

/**
 * real D1(workerd 上の SQLite)を使う統合テスト。
 * 単体テスト(src/*.test.ts)は D1 の挙動を SQL 文言の文字列照合で模した
 * フェイクに頼っているため、以下は実際には一切実行されていなかった:
 *   - migrations/0001_jobs.sql が実際に適用できるか
 *   - jobs テーブルの列がコード側の期待と一致するか
 *   - idempotency_key の UNIQUE 制約が本当に効くか
 *   - idx_due(status, publish_at)に対する cron.ts の SELECT が正しい行を返すか
 * このファイルはそれらを real D1 に対して検証する。
 *
 * マイグレーション適用は setupFiles(apply-migrations.ts)で全テスト共通に済ませてある。
 * isolatedStorage(既定 true)により、各 it() ごとに書き込みはロールバックされる。
 */

interface JobRow {
	id: string;
	idempotency_key: string;
	platform: string;
	r2_key: string;
	media_type: string;
	caption: string | null;
	publish_at: number;
	status: string;
	ig_container_id: string | null;
	ig_media_id: string | null;
	attempts: number;
	last_error: string | null;
	created_at: number;
	updated_at: number;
}

/** jobs.ts の INSERT と同形の1行を作る最小ヘルパー。 */
async function insertJob(
	overrides: Partial<JobRow> & Pick<JobRow, "id" | "idempotency_key">,
): Promise<void> {
	const now = Date.now();
	const row: JobRow = {
		platform: "instagram",
		r2_key: "2026/07/19/uuid.mp4",
		media_type: "REELS",
		caption: null,
		publish_at: now,
		status: "pending",
		ig_container_id: null,
		ig_media_id: null,
		attempts: 0,
		last_error: null,
		created_at: now,
		updated_at: now,
		...overrides,
	};
	await env.DB.prepare(
		`INSERT INTO jobs
      (id, idempotency_key, platform, r2_key, media_type, caption, publish_at,
       status, ig_container_id, ig_media_id, attempts, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			row.id,
			row.idempotency_key,
			row.platform,
			row.r2_key,
			row.media_type,
			row.caption,
			row.publish_at,
			row.status,
			row.ig_container_id,
			row.ig_media_id,
			row.attempts,
			row.last_error,
			row.created_at,
			row.updated_at,
		)
		.run();
}

describe("migrations + schema smoke", () => {
	it("jobs テーブルへ INSERT でき、コードが参照する全列を持つ", async () => {
		await insertJob({ id: "smoke-1", idempotency_key: "idem-smoke-1" });

		// routes/jobs.ts の SELECT * と publish-do.ts の列指定 SELECT の両方が
		// 期待する列名を、実 D1 に対して確認する(列名 typo は本テストで検知できる)。
		const row = await env.DB.prepare(
			`SELECT id, idempotency_key, platform, r2_key, media_type, caption, publish_at,
              status, ig_container_id, ig_media_id, attempts, last_error, created_at, updated_at
         FROM jobs WHERE id = ?`,
		)
			.bind("smoke-1")
			.first<JobRow>();

		expect(row).toMatchObject({
			id: "smoke-1",
			idempotency_key: "idem-smoke-1",
			platform: "instagram",
			status: "pending",
			attempts: 0,
			ig_container_id: null,
			ig_media_id: null,
		});
	});

	it("idx_due(status, publish_at)を含むスキーマが sqlite_master に存在する", async () => {
		const idx = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_due'",
		).first<{ name: string }>();
		expect(idx?.name).toBe("idx_due");
	});
});

describe("idempotency_key の UNIQUE 制約", () => {
	it("同じ idempotency_key での2件目の INSERT は制約違反で reject される", async () => {
		await insertJob({ id: "job-a", idempotency_key: "dup-key" });

		// UNIQUE 制約違反であることまで確認する(列数不一致等の別要因による
		// reject を誤って合格させないため、エラーメッセージも照合する)。
		await expect(
			insertJob({ id: "job-b", idempotency_key: "dup-key" }),
		).rejects.toThrow(/unique/i);

		// 1件目だけが残っていることも確認する(部分的にコミットされていない)。
		const count = await env.DB.prepare(
			"SELECT COUNT(*) as n FROM jobs WHERE idempotency_key = ?",
		)
			.bind("dup-key")
			.first<{ n: number }>();
		expect(count?.n).toBe(1);
	});

	it("異なる idempotency_key なら複数 INSERT できる", async () => {
		await insertJob({ id: "job-c", idempotency_key: "key-c" });
		await insertJob({ id: "job-d", idempotency_key: "key-d" });

		const count = await env.DB.prepare(
			"SELECT COUNT(*) as n FROM jobs WHERE id IN ('job-c', 'job-d')",
		).first<{ n: number }>();
		expect(count?.n).toBe(2);
	});
});

describe("cron.ts scanDueJobs: idx_due に対する実 SELECT", () => {
	// PUBLISH_DO の呼び出しは記録するだけの軽量フェイクに留める(DO/IG API を
	// 経由した状態遷移は test/integration/publish-do.test.ts 側で別途検証する)。
	// ここで見たいのは cron.ts の SQL が real D1 に対して正しい行だけを返すこと。
	function recordingDoNamespace() {
		const calls: string[] = [];
		return {
			namespace: {
				idFromName(name: string) {
					return name as unknown as DurableObjectId;
				},
				get() {
					return {
						async fetch(_url: string, init?: RequestInit) {
							const body = init?.body
								? (JSON.parse(init.body as string) as { jobId: string })
								: undefined;
							if (body) calls.push(body.jobId);
							return new Response("{}", {
								headers: { "content-type": "application/json" },
							});
						},
					};
				},
			},
			calls,
		};
	}

	beforeEach(async () => {
		const now = Date.now();
		await insertJob({
			id: "due-pending",
			idempotency_key: "scan-due-pending",
			status: "pending",
			publish_at: now - 60_000,
		});
		await insertJob({
			id: "future-pending",
			idempotency_key: "scan-future-pending",
			status: "pending",
			publish_at: now + 60_000,
		});
		await insertJob({
			id: "due-processing",
			idempotency_key: "scan-due-processing",
			status: "processing",
			publish_at: now - 60_000,
		});
		await insertJob({
			id: "due-published",
			idempotency_key: "scan-due-published",
			status: "published",
			publish_at: now - 60_000,
		});
	});

	it("到来済み pending のみを拾い、未到来・非 pending は除外する", async () => {
		const { namespace, calls } = recordingDoNamespace();
		const scanEnv = { DB: env.DB, PUBLISH_DO: namespace } as unknown as Env;

		await scanDueJobs(scanEnv);

		expect(calls).toEqual(["due-pending"]);
	});
});

describe("claim 用の条件付き UPDATE(WHERE id = ? AND status = 'pending')", () => {
	// PublishDO.fetch("/start") の claimPendingForCreating(publish-do.ts)が
	// pending → creating の遷移をこの形の条件付き UPDATE で原子的に claim しており、
	// meta.changes === 0 を「他インスタンスが claim 済み」(already-claimed 応答)の
	// 判定に使っている。ここではその依拠する D1 の保証 —— この1文が単一
	// トランザクションとして実行され、負けた側の meta.changes が実 D1 で 0 と
	// 報告されること —— を、DO を経由せず生 SQL で直接検証する
	// (claim を含む DO 側の一連の流れは test/integration/publish-do.test.ts が担う)。
	it("2回目の claim UPDATE は対象行が既に pending でないため 0 件更新になる", async () => {
		await insertJob({ id: "claim-1", idempotency_key: "claim-key-1" });

		const first = await env.DB.prepare(
			"UPDATE jobs SET status = 'creating', updated_at = ? WHERE id = ? AND status = 'pending'",
		)
			.bind(Date.now(), "claim-1")
			.run();
		expect(first.meta.changes).toBe(1);

		const second = await env.DB.prepare(
			"UPDATE jobs SET status = 'creating', updated_at = ? WHERE id = ? AND status = 'pending'",
		)
			.bind(Date.now(), "claim-1")
			.run();
		expect(second.meta.changes).toBe(0);

		const row = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?")
			.bind("claim-1")
			.first<{ status: string }>();
		expect(row?.status).toBe("creating");
	});

	it("存在しない行への claim UPDATE も 0 件更新になる(id 不一致)", async () => {
		const result = await env.DB.prepare(
			"UPDATE jobs SET status = 'creating', updated_at = ? WHERE id = ? AND status = 'pending'",
		)
			.bind(Date.now(), "does-not-exist")
			.run();
		expect(result.meta.changes).toBe(0);
	});
});
