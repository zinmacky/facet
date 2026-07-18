import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import { scanDueJobs, sweepStaleJobs } from "./cron.js";

/** jobs テーブルの1行(cron.ts の2クエリが必要とする列のみ)。 */
interface FakeJobRow {
	id: string;
	status: string;
	publish_at: number;
	updated_at: number;
}

/**
 * cron.ts の2クエリ(scanDueJobs / sweepStaleJobs)専用のインメモリ D1 フェイク。
 * 実 D1 の SQL エンジンは持たないため、対象クエリの SQL 文言をパターン照合して
 * 該当ロジックだけを JS で再現する(publish-do.test.ts の applyWrite と同じ方針)。
 */
function fakeJobsDB(rows: FakeJobRow[]) {
	const prepared: { sql: string; args: unknown[] }[] = [];
	return {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					prepared.push({ sql, args });
					return {
						async all<T>() {
							if (sql.includes("status = 'pending' AND publish_at <= ?")) {
								const now = args[0] as number;
								const results = rows.filter(
									(r) => r.status === "pending" && r.publish_at <= now,
								);
								return { results: results as unknown as T[] };
							}
							if (
								sql.includes(
									"status IN ('creating', 'processing', 'publishing') AND updated_at < ?",
								)
							) {
								const threshold = args[0] as number;
								const results = rows.filter(
									(r) =>
										(r.status === "creating" ||
											r.status === "processing" ||
											r.status === "publishing") &&
										r.updated_at < threshold,
								);
								return { results: results as unknown as T[] };
							}
							return { results: [] as T[] };
						},
					};
				},
			};
		},
		__prepared: prepared,
	};
}

/** PUBLISH_DO(DurableObjectNamespace)のフェイク。fetch 呼び出しを記録する。 */
function fakeDoNamespace(
	fetchImpl?: (id: string, url: string, body: unknown) => Promise<Response>,
) {
	const calls: { id: string; url: string; body: unknown }[] = [];
	const namespace = {
		idFromName(name: string) {
			return name as unknown as DurableObjectId;
		},
		get(id: unknown) {
			return {
				async fetch(url: string, init?: RequestInit) {
					const body = init?.body ? JSON.parse(init.body as string) : undefined;
					calls.push({ id: id as string, url, body });
					if (fetchImpl) {
						return fetchImpl(id as string, url, body);
					}
					return new Response("{}", {
						headers: { "content-type": "application/json" },
					});
				},
			};
		},
	};
	return { namespace, calls };
}

function envWith(
	db: ReturnType<typeof fakeJobsDB>,
	doNamespace: ReturnType<typeof fakeDoNamespace>["namespace"],
): Env {
	return {
		DB: db,
		PUBLISH_DO: doNamespace,
	} as unknown as Env;
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("scanDueJobs", () => {
	it("pending かつ publish_at 到来のジョブのみ DO を起動する", async () => {
		const now = Date.now();
		const db = fakeJobsDB([
			{ id: "due-pending", status: "pending", publish_at: now - 1000, updated_at: now },
			{ id: "future-pending", status: "pending", publish_at: now + 60_000, updated_at: now },
			{ id: "due-processing", status: "processing", publish_at: now - 1000, updated_at: now },
		]);
		const { namespace, calls } = fakeDoNamespace();

		await scanDueJobs(envWith(db, namespace));

		expect(calls).toHaveLength(1);
		expect(calls[0]?.id).toBe("due-pending");
		expect(calls[0]?.url).toBe("https://do/start");
		expect(calls[0]?.body).toEqual({ jobId: "due-pending" });
	});

	it("DO stub の起動失敗は握りつぶし、他ジョブの処理を止めない", async () => {
		const now = Date.now();
		const db = fakeJobsDB([
			{ id: "job-a", status: "pending", publish_at: now - 1000, updated_at: now },
			{ id: "job-b", status: "pending", publish_at: now - 1000, updated_at: now },
		]);
		const { namespace, calls } = fakeDoNamespace(async (id) => {
			if (id === "job-a") {
				throw new Error("do unreachable");
			}
			return new Response("{}");
		});

		await expect(scanDueJobs(envWith(db, namespace))).resolves.toBeUndefined();

		expect(calls.map((c) => c.id)).toEqual(["job-a", "job-b"]);
		expect(console.error).toHaveBeenCalledTimes(1);
	});
});

describe("sweepStaleJobs", () => {
	const STALE_UPDATED_AT = Date.now() - 20 * 60 * 1000; // 20分前(しきい値15分より古い)
	const FRESH_UPDATED_AT = Date.now() - 60 * 1000; // 1分前(しきい値内)

	it("非終端状態かつ長時間無更新のジョブだけ拾う(stale のみ)", async () => {
		const db = fakeJobsDB([
			{
				id: "stale-processing",
				status: "processing",
				publish_at: 0,
				updated_at: STALE_UPDATED_AT,
			},
			{
				id: "fresh-processing",
				status: "processing",
				publish_at: 0,
				updated_at: FRESH_UPDATED_AT,
			},
			{
				id: "stale-pending",
				status: "pending",
				publish_at: 0,
				updated_at: STALE_UPDATED_AT,
			},
			{
				id: "stale-published",
				status: "published",
				publish_at: 0,
				updated_at: STALE_UPDATED_AT,
			},
		]);
		const { namespace, calls } = fakeDoNamespace();

		await sweepStaleJobs(envWith(db, namespace));

		expect(calls).toHaveLength(1);
		expect(calls[0]?.id).toBe("stale-processing");
	});

	it("新鮮な進行中ジョブ(updated_at がしきい値内)は拾わない", async () => {
		const db = fakeJobsDB([
			{
				id: "fresh-creating",
				status: "creating",
				publish_at: 0,
				updated_at: FRESH_UPDATED_AT,
			},
		]);
		const { namespace, calls } = fakeDoNamespace();

		await sweepStaleJobs(envWith(db, namespace));

		expect(calls).toHaveLength(0);
	});

	it("DO が resumed:true を返すと(=本当に孤立していた)警告ログを残す", async () => {
		const db = fakeJobsDB([
			{
				id: "stale-publishing",
				status: "publishing",
				publish_at: 0,
				updated_at: STALE_UPDATED_AT,
			},
		]);
		const { namespace, calls } = fakeDoNamespace(async () =>
			Response.json({ resumed: true }),
		);

		await sweepStaleJobs(envWith(db, namespace));

		expect(calls).toEqual([
			{
				id: "stale-publishing",
				url: "https://do/resume",
				body: { jobId: "stale-publishing" },
			},
		]);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("stale-publishing"),
		);
	});

	it("DO が resumed:false を返すと(=候補だったが alarm は生きていた誤検知)警告を出さない", async () => {
		const db = fakeJobsDB([
			{
				id: "false-positive",
				status: "processing",
				publish_at: 0,
				updated_at: STALE_UPDATED_AT,
			},
		]);
		const { namespace, calls } = fakeDoNamespace(async () =>
			Response.json({ resumed: false }),
		);

		await sweepStaleJobs(envWith(db, namespace));

		expect(calls).toHaveLength(1);
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("DO stub の再開失敗は握りつぶし、他ジョブの処理を止めない", async () => {
		const db = fakeJobsDB([
			{ id: "job-a", status: "processing", publish_at: 0, updated_at: STALE_UPDATED_AT },
			{ id: "job-b", status: "processing", publish_at: 0, updated_at: STALE_UPDATED_AT },
		]);
		const { namespace, calls } = fakeDoNamespace(async (id) => {
			if (id === "job-a") {
				throw new Error("do unreachable");
			}
			return new Response("{}");
		});

		await expect(sweepStaleJobs(envWith(db, namespace))).resolves.toBeUndefined();

		expect(calls.map((c) => c.id)).toEqual(["job-a", "job-b"]);
		expect(console.error).toHaveBeenCalledTimes(1);
	});
});
