import { jobManifest, jobRecord } from "@facet/contract";
import type { JobRecord } from "@facet/contract";
import { Hono } from "hono";
import type { Env } from "../env.js";

/** D1 の jobs 行(全列)。camelCase の JobRecord へ写像する。 */
interface JobRowFull {
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
 * D1 行を contract の JobRecord 形状へ変換し、`jobRecord` zod スキーマで検証する。
 * D1 は素の SQLite であり列値の型・enum 値を保証しないため、ここで unchecked な
 * `as` キャストのまま返すと不正な行(例: status が enum 外の文字列)がそのまま
 * クライアントへ流出しうる。スキーマ不適合は行データの破損・想定外の書き込みを
 * 示すバグシグナルなので、ここでは黙って握りつぶさず null を返し、呼び出し側で
 * ログを残した上で 500 とする(サービスを止めてでも不正なレスポンスを返さない)。
 */
function toJobRecord(row: JobRowFull): JobRecord | null {
	const candidate = {
		id: row.id,
		idempotencyKey: row.idempotency_key,
		platform: "instagram",
		r2Key: row.r2_key,
		mediaType: row.media_type,
		caption: row.caption ?? "",
		publishAt: row.publish_at,
		status: row.status,
		igContainerId: row.ig_container_id,
		igMediaId: row.ig_media_id,
		attempts: row.attempts,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	const parsed = jobRecord.safeParse(candidate);
	if (!parsed.success) {
		console.error(
			`toJobRecord: D1 行が JobRecord スキーマに適合しません(id=${row.id}):`,
			parsed.error.issues,
		);
		return null;
	}
	return parsed.data;
}

/** /jobs 配下のルータを組み立てて返す。 */
export function jobsRoutes() {
	const app = new Hono<{ Bindings: Env }>();

	// 登録。idempotencyKey で二重登録を弾き、既存があればそれを返す。
	app.post("/", async (c) => {
		const raw = await c.req.json().catch(() => null);
		const parsed = jobManifest.safeParse(raw);
		if (!parsed.success) {
			return c.json(
				{ error: "invalid job manifest", issues: parsed.error.issues },
				400,
			);
		}
		const manifest = parsed.data;

		// 既存の同一 idempotencyKey を検索。あれば 200 で既存を返す(再送は冪等)。
		const existing = await c.env.DB.prepare(
			"SELECT id, status FROM jobs WHERE idempotency_key = ?",
		)
			.bind(manifest.idempotencyKey)
			.first<{ id: string; status: string }>();
		if (existing) {
			return c.json({ id: existing.id, status: existing.status }, 200);
		}

		const id = crypto.randomUUID();
		const now = Date.now();
		await c.env.DB.prepare(
			`INSERT INTO jobs
        (id, idempotency_key, platform, r2_key, media_type, caption, publish_at,
         status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
		)
			.bind(
				id,
				manifest.idempotencyKey,
				manifest.platform,
				manifest.r2Key,
				manifest.mediaType,
				manifest.caption,
				manifest.publishAt,
				now,
				now,
			)
			.run();

		return c.json({ id, status: "pending" }, 201);
	});

	// 取得。JobRecord 形状で返す。無ければ 404。
	app.get("/:id", async (c) => {
		const id = c.req.param("id");
		const row = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?")
			.bind(id)
			.first<JobRowFull>();
		if (!row) {
			return c.json({ error: "job not found" }, 404);
		}
		const record = toJobRecord(row);
		if (!record) {
			return c.json({ error: "internal error: invalid job record" }, 500);
		}
		return c.json(record, 200);
	});

	return app;
}
