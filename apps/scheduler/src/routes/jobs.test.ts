import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
 *
 * `staleReadIdempotencyKey` を指定すると、そのキーでの idempotency_key 検索
 * (SELECT)は最初の1回だけ既存行があっても null を返す。check-then-insert の
 * レース(SELECT 時点では見えなかった行が、後続の INSERT 時点では既にコミット
 * 済みで UNIQUE 制約に弾かれる状況)を再現するためのフック。
 *
 * `forceInsertUniqueError` を true にすると、INSERT は(実際に重複が無くても)
 * 常に UNIQUE 制約違反を投げる。「UNIQUE 制約と誤検知したが再取得しても既存行が
 * 見つからない」という理論上の縁(誤検知 or 真に想定外のエラー)を再現し、
 * jobs.ts が元のエラーをそのまま再送出する(黙って握りつぶさない)ことを検証する。
 */
function fakeJobsDB(
	options: {
		staleReadIdempotencyKey?: string;
		forceInsertUniqueError?: boolean;
	} = {},
) {
	const rows = new Map<string, FakeRow>();
	let staleReadConsumed = false;
	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first<T>() {
							if (sql.includes("idempotency_key = ?")) {
								const key = args[0] as string;
								if (
									options.staleReadIdempotencyKey === key &&
									!staleReadConsumed
								) {
									staleReadConsumed = true;
									return null;
								}
								for (const row of rows.values()) {
									if (row.idempotency_key === key) {
										return {
											id: row.id,
											status: row.status,
											platform: row.platform,
											r2_key: row.r2_key,
											media_type: row.media_type,
											caption: row.caption,
											publish_at: row.publish_at,
										} as T;
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
								if (options.forceInsertUniqueError) {
									throw new Error(
										"D1_ERROR: UNIQUE constraint failed: jobs.idempotency_key: SQLITE_CONSTRAINT",
									);
								}
								// 実際の D1(SQLite)と同じく idempotency_key の UNIQUE 制約を再現する。
								for (const row of rows.values()) {
									if (row.idempotency_key === idempotencyKey) {
										throw new Error(
											"D1_ERROR: UNIQUE constraint failed: jobs.idempotency_key: SQLITE_CONSTRAINT",
										);
									}
								}
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

	it("check-then-insert のレースで idempotency_key の UNIQUE 制約に衝突しても 200 で既存ジョブを返す", async () => {
		const manifest = validManifest();
		const raced = fakeJobsDB({
			staleReadIdempotencyKey: manifest.idempotencyKey,
		});
		const raceApp = buildApp();

		// 「別の並行リクエスト」が既に同一 idempotencyKey でジョブを INSERT 済み、という体を
		// 直接 rows に書き込んで再現する。
		const racedId = crypto.randomUUID();
		const now = Date.now();
		raced.__rows.set(racedId, {
			id: racedId,
			idempotency_key: manifest.idempotencyKey,
			platform: "instagram",
			r2_key: manifest.r2Key,
			media_type: manifest.mediaType,
			caption: manifest.caption,
			publish_at: manifest.publishAt,
			status: "pending",
			ig_container_id: null,
			ig_media_id: null,
			attempts: 0,
			last_error: null,
			created_at: now,
			updated_at: now,
		});

		const res = await raceApp.request(
			"/jobs",
			{ method: "POST", body: JSON.stringify(manifest) },
			envWithDB(raced),
		);

		// 事前の SELECT では見えなかった(stale read)が、INSERT が UNIQUE 制約で弾かれ、
		// 再取得した既存ジョブがそのまま 200 で返る。二重 INSERT もされない。
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json).toMatchObject({ id: racedId, status: "pending" });
		expect(raced.__rows.size).toBe(1);
	});

	it("check-then-insert のレースで内容も食い違う場合は 409 で拒否する", async () => {
		const manifest = validManifest();
		const raced = fakeJobsDB({
			staleReadIdempotencyKey: manifest.idempotencyKey,
		});
		const raceApp = buildApp();

		// 「別の並行リクエスト」が既に同一 idempotencyKey・別内容(caption 違い)で
		// INSERT 済み、という体を再現する。
		const racedId = crypto.randomUUID();
		const now = Date.now();
		raced.__rows.set(racedId, {
			id: racedId,
			idempotency_key: manifest.idempotencyKey,
			platform: "instagram",
			r2_key: manifest.r2Key,
			media_type: manifest.mediaType,
			caption: "別内容のキャプション",
			publish_at: manifest.publishAt,
			status: "pending",
			ig_container_id: null,
			ig_media_id: null,
			attempts: 0,
			last_error: null,
			created_at: now,
			updated_at: now,
		});

		const res = await raceApp.request(
			"/jobs",
			{ method: "POST", body: JSON.stringify(manifest) },
			envWithDB(raced),
		);

		// レース経由でも(通常パスと同じく)内容不一致は 409 で拒否する。
		expect(res.status).toBe(409);
		const json = (await res.json()) as { error: string; id: string };
		expect(json.error).toBeTruthy();
		expect(json.id).toBe(racedId);
		expect(raced.__rows.size).toBe(1);
	});

	it("UNIQUE 制約と誤検知したが再取得しても既存ジョブが見つからない場合は元のエラーをそのまま投げる", async () => {
		const manifest = validManifest();
		const forced = fakeJobsDB({ forceInsertUniqueError: true });
		const forcedApp = buildApp();

		const res = await forcedApp.request(
			"/jobs",
			{ method: "POST", body: JSON.stringify(manifest) },
			envWithDB(forced),
		);

		// 再取得しても既存行が無い(誤検知 or 真に想定外のエラー)場合は握りつぶさず、
		// Hono のデフォルトエラーハンドラ経由で 500 として表面化する。
		expect(res.status).toBe(500);
		expect(forced.__rows.size).toBe(0);
	});

	it("同一 idempotencyKey・同一内容の再送は 200 で既存ジョブを返し、二重 INSERT しない", async () => {
		const manifest = validManifest();
		const first = await app.request(
			"/jobs",
			{ method: "POST", body: JSON.stringify(manifest) },
			envWithDB(db),
		);
		const firstJson = (await first.json()) as { id: string; status: string };

		// 同一 idempotencyKey・完全に同一内容の再送(冪等リプレイ)。
		const second = await app.request(
			"/jobs",
			{ method: "POST", body: JSON.stringify(manifest) },
			envWithDB(db),
		);

		expect(second.status).toBe(200);
		const secondJson = (await second.json()) as { id: string; status: string };
		expect(secondJson).toEqual(firstJson);
		expect(db.__rows.size).toBe(1);
	});

	it("同一 idempotencyKey・別内容の再送は 409 で拒否する(idempotency key の使い回し)", async () => {
		const manifest = validManifest();
		const first = await app.request(
			"/jobs",
			{ method: "POST", body: JSON.stringify(manifest) },
			envWithDB(db),
		);
		const firstJson = (await first.json()) as { id: string; status: string };

		// 同一 idempotencyKey・別内容(caption 変更)で再送すると、古いジョブをそのまま
		// 返さず 409 で拒否する(desktop 側のバグで別内容が紛れ込んでも黙って
		// 古い内容を公開しないようにするため)。
		const second = await app.request(
			"/jobs",
			{
				method: "POST",
				body: JSON.stringify(
					validManifest({
						idempotencyKey: manifest.idempotencyKey,
						caption: "changed",
					}),
				),
			},
			envWithDB(db),
		);

		expect(second.status).toBe(409);
		const secondJson = (await second.json()) as { error: string; id: string };
		expect(secondJson.error).toBeTruthy();
		expect(secondJson.id).toBe(firstJson.id);
		expect(db.__rows.size).toBe(1);
		// 拒否されても既存ジョブは変更されない(初回登録時の caption が維持される)。
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

	it("status が enum 外の不正な行は 500(スキーマ検証で弾く)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});

		const id = crypto.randomUUID();
		const now = Date.now();
		db.__rows.set(id, {
			id,
			idempotency_key: crypto.randomUUID(),
			platform: "instagram",
			r2_key: "posts/2026-07-18/reel.mp4",
			media_type: "REELS",
			caption: "hello",
			publish_at: now + 60_000,
			status: "not-a-real-status",
			ig_container_id: null,
			ig_media_id: null,
			attempts: 0,
			last_error: null,
			created_at: now,
			updated_at: now,
		});

		const res = await app.request(`/jobs/${id}`, {}, envWithDB(db));
		expect(res.status).toBe(500);
		expect(console.error).toHaveBeenCalled();

		vi.restoreAllMocks();
	});
});
