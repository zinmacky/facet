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

/**
 * stale ジョブとみなす無更新時間のしきい値(ms)。20分。
 * PublishDO.fetch() が D1 へ status='creating' 等を書いた直後、例外を投げない
 * 中断(isolate 退避等)が起きると alarm が張られないまま孤立しうる
 * (scanDueJobs は status='pending' しか拾わないため回収経路が無い)。
 * このしきい値は通常のポーリング間隔(POLL_INTERVAL_MS=15秒)や、transient 失敗の
 * 指数バックオフ上限(publish-do.ts の BACKOFF_SCHEDULE_MS、15分で頭打ち)より
 * 厳密に大きく取り、正常にバックオフ待機中なだけのジョブを誤検知しないようにする
 * (厳密に大きくないと、待機の終わり際に updated_at が閾値を跨いで stale 候補に
 * 一時的に乗ってしまう。実害は無い — handleResume の alarm 有無ガードが吸収する —
 * が、無駄な /resume 呼び出しを避けるため十分な余裕を持たせる)。
 */
const STALE_THRESHOLD_MS = 20 * 60 * 1000;

/**
 * 毎分の cron で呼ばれる掃きスイープ。非終端状態(creating/processing/publishing)
 * のまま updated_at が STALE_THRESHOLD_MS 以上更新されていないジョブを、
 * 孤立(alarm 未設定)の疑いありとして DO の /resume へ送り込み再開させる。
 *
 * PublishDO.alarm() の reArm(ポーリング継続)は毎回 updated_at を更新するため、
 * 正常にポーリング中のジョブが本条件に乗ることは基本的に無い(publish-do.ts の
 * touchUpdatedAt 参照)。それでも本関数の SELECT 条件はあくまで「疑わしい候補」を
 * 拾うだけであり、実際に再開してよいか(alarm が本当に張られていないか)の
 * 最終判断は DO 側(/resume)に委ねる。二重起動安全性の詳細は publish-do.ts の
 * handleResume のコメントを参照。
 */
export async function sweepStaleJobs(env: Env): Promise<void> {
	const threshold = Date.now() - STALE_THRESHOLD_MS;
	const { results } = await env.DB.prepare(
		"SELECT id FROM jobs WHERE status IN ('creating', 'processing', 'publishing') AND updated_at < ?",
	)
		.bind(threshold)
		.all<{ id: string }>();

	for (const row of results) {
		const stub = env.PUBLISH_DO.get(env.PUBLISH_DO.idFromName(row.id));
		try {
			const res = await stub.fetch("https://do/resume", {
				method: "POST",
				body: JSON.stringify({ jobId: row.id }),
			});
			// resumed:true(alarm 未設定 = 本当に孤立していた)のときだけ警告ログを
			// 残す。alarm が生きていた(resumed:false)候補は誤検知であり、ここで
			// 毎回 warn すると本当の孤立の見落としにつながる「沈黙回収」ならぬ
			// 「警告インフレ」を招くため区別する。
			const { resumed } = (await res.json()) as { resumed?: boolean };
			if (resumed) {
				console.warn(`sweepStaleJobs: revived orphaned job: ${row.id}`);
			}
		} catch (err) {
			// 個別ジョブの再開失敗は握りつぶし、次の分の再スイープに委ねる。
			console.error(`sweepStaleJobs: failed to resume job ${row.id}:`, err);
		}
	}
}
