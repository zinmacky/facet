import type { Env } from "./env.js";

/**
 * 毎分の cron で呼ばれる。公開時刻が到来した pending ジョブを列挙し、
 * ジョブ ID から一意に定まる DO stub(idFromName(id))を叩いて公開を起動する。
 *
 * 起動は複数回発火しうる(次の分でも同じ pending が拾われる)ため、
 * DO 側で status を creating に進めて冪等化する前提。ここは fire-and-forget でよい。
 */
export async function scanDueJobs(env: Env): Promise<void> {
	const now = Date.now();
	const { results } = await env.DB.prepare(
		"SELECT id FROM jobs WHERE status = 'pending' AND publish_at <= ?",
	)
		.bind(now)
		.all<{ id: string }>();

	for (const row of results) {
		const stub = env.PUBLISH_DO.get(env.PUBLISH_DO.idFromName(row.id));
		try {
			// job.id を body で渡す。DO は state.id から元の名前を引けないため。
			await stub.fetch("https://do/start", {
				method: "POST",
				body: JSON.stringify({ jobId: row.id }),
			});
		} catch (err) {
			// 個別ジョブの起動失敗は握りつぶし、次の分の再スキャンに委ねる。
			console.error(`scanDueJobs: failed to start job ${row.id}:`, err);
		}
	}
}
