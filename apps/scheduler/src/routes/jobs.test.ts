import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { jobsRoutes } from "./jobs.js";

/** jobs テーブルの全列(INSERT の bind 引数順は routes/jobs.ts の SQL と一致させる)。 */
interface FakeRow {
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

/**
 * jobs.ts が発行する2種の SELECT(idempotency_key 検索・id 検索)と INSERT を
 * 再現するインメモリ D1 フェイク。SQL 文言をパターン照合して分岐する
 * (publish-do.test.ts の既存フェイクと同じ方針)。
 */
function fakeJobsDB() {
	const rows = new Map<string, FakeRow>();
	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first<T>() {
							if (sql.includes("idempotency_key = ?")) {
								const key = args[0] as string;
								for (const row of rows.values()) {
									if (row.idempotency_key === key) {
										return { id: row.id, status: row.status } as T;
									}
								}
								return null;
							}
							if (sql.includes("WHERE id = ?")) {
								const id = args[0] as string;
								return (rows.get(id) as unknown as T) ?? null;
							}
							return null;
						},
						async run() {
							if (sql.startsWith("INSERT INTO jobs")) {
								const [
									id,
									idempotencyKey,
									platform,
									r2Key,
									mediaType,
									caption,
									publishAt,
									createdAt,
									updatedAt,
								] = args as [
									string,
									string,
									string,
									string,
									string,
									string | null,
									number,
									number,
									number,
								];
								rows.set(id, {
									id,
									idempotency_key: idempotencyKey,
									platform,
									r2_key: r2Key,
									media_type: mediaType,
									caption,
									publish_at: publishAt,
									status: "pending",
									ig_container_id: null,
									ig_media_id: null,
									attempts: 0,
									last_error: null,
									created_at: createdAt,
									updated_at: updatedAt,
								});
							}
							return { success: true };
						},
					};
				},
			};
		},
		__rows: rows,
	};
	return db;
}

function envWithDB(db: ReturnType<typeof fakeJobsDB>): Env {
	return { DB: db } as unknown as Env;
}

function buildApp() {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/jobs", jobsRoutes());
	return app;
}

function validManifest(overrides: Record<string, unknown> = {}) {
	return {
		idempotencyKey: crypto.randomUUID(),
		platform: "instagram",
		r2Key: "posts/2026-07-18/reel.mp4",
		mediaType: "REELS",
		caption: "hello",
		publishAt: Date.now() + 60_000,
		...overrides,
	};
}

describe("POST /jobs", () => {
	let db: ReturnType<typeof fakeJobsDB>;
	let app: ReturnType<typeof buildApp>;

	beforeEach(() => {
		db = fakeJobsDB();
		app = buildApp();
	});

	it("不正なマニフェストは 400 で弾く", async () => {
		const res = await app.request(
			"/jobs",
			{ method: "POST", body: JSON.stringify({ platform: "instagram" }) },
			envWithDB(db),
		);
		expect(res.status).toBe(400);
	});

	it("新規登録は 201 で id と status=pending を返し、D1 へ INSERT する", async () => {
		const manifest = validManifest();
		const res = await app.request(
			"/jobs",
			{ method: "POST", body: JSON.stringify(manifest) },
			envWithDB(db),
		);
		expect(res.status).toBe(201);
		const json = (await res.json()) as { id: string; status: string };
		expect(json.status).toBe("pending");
		expect(typeof json.id).toBe("string");

		expect(db.__rows.size).toBe(1);
		const row = db.__rows.get(json.id);
		expect(row).toMatchObject({
			idempotency_key: manifest.idempotencyKey,
			platform: "instagram",
			r2_key: manifest.r2Key,
			media_type: manifest.mediaType,
			caption: manifest.caption,
			publish_at: manifest.publishAt,
			status: "pending",
			attempts: 0,
		});
	});

	it("同一 idempotencyKey の再送は 200 で既存ジョブを返し、二重 INSERT しない", async () => {
		const manifest = validManifest();
		const first = await app.request(
			"/jobs",
			{ method: "POST", body: JSON.stringify(manifest) },
			envWithDB(db),
		);
		const firstJson = (await first.json()) as { id: string; status: string };

		// 同一 idempotencyKey・別内容(caption 変更)で再送しても既存ジョブがそのまま返る。
		const second = await app.request(
			"/jobs",
			{
				method: "POST",
				body: JSON.stringify(validManifest({
					idempotencyKey: manifest.idempotencyKey,
					caption: "changed",
				})),
			},
			envWithDB(db),
		);

		expect(second.status).toBe(200);
		const secondJson = (await second.json()) as { id: string; status: string };
		expect(secondJson).toEqual(firstJson);
		expect(db.__rows.size).toBe(1);
		// 再送では上書きされず、初回登録時の caption が維持される。
		expect(db.__rows.get(firstJson.id)?.caption).toBe(manifest.caption);
	});
});

describe("GET /jobs/:id", () => {
	let db: ReturnType<typeof fakeJobsDB>;
	let app: ReturnType<typeof buildApp>;

	beforeEach(() => {
		db = fakeJobsDB();
		app = buildApp();
	});

	it("存在しないジョブは 404", async () => {
		const res = await app.request("/jobs/does-not-exist", {}, envWithDB(db));
		expect(res.status).toBe(404);
	});

	it("存在するジョブは JobRecord 形状(camelCase)で返す", async () => {
		const manifest = validManifest();
		const created = await app.request(
			"/jobs",
			{ method: "POST", body: JSON.stringify(manifest) },
			envWithDB(db),
		);
		const { id } = (await created.json()) as { id: string };

		const res = await app.request(`/jobs/${id}`, {}, envWithDB(db));
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json).toMatchObject({
			id,
			idempotencyKey: manifest.idempotencyKey,
			platform: "instagram",
			r2Key: manifest.r2Key,
			mediaType: manifest.mediaType,
			caption: manifest.caption,
			publishAt: manifest.publishAt,
			status: "pending",
			igContainerId: null,
			igMediaId: null,
			attempts: 0,
			lastError: null,
		});
	});
});
