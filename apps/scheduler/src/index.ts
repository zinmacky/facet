import { Hono } from "hono";
import { requireBearerAuth } from "./auth.js";
import { scanDueJobs, sweepStaleJobs } from "./cron.js";
import type { Env } from "./env.js";
import { jobsRoutes } from "./routes/jobs.js";
import {
	checkTokenExpiryAndForceRefresh,
	getTokenHealthSnapshot,
	refreshTokens,
} from "./token-refresh.js";

const app = new Hono<{ Bindings: Env }>();

// 疎通チェック用のヘルスチェック。無認証で公開するため認証ミドルウェアより前に登録する。
app.get("/health", (c) => c.json({ ok: true }));

// これ以降の全ルート(状態変更・情報返却を行う公開エンドポイント)に Bearer 認証を適用する。
app.use("*", requireBearerAuth());

// desktop の疎通チェック(2段階目)が叩くエンドポイント。ステータスコードは
// 従来どおり 200 を維持しつつ、body に token 健全性情報を載せて読み手ゼロを解消する
// (GHSA-6vwp-4jwx-8f3w 対応)。
app.get("/", async (c) => {
	const tokenHealth = await getTokenHealthSnapshot(c.env);
	return c.json({ service: "facet-scheduler", tokenHealth });
});
app.route("/jobs", jobsRoutes());

export default {
	fetch: app.fetch,

	/**
	 * cron ハンドラ。event.cron でトリガを分岐する:
	 *  - "* * * * *" 毎分   → 公開時刻到来スキャン + stale ジョブの掃きスイープ
	 *                          + トークン失効監視(閾値割れなら強制リフレッシュ)
	 *  - "0 3 * * *" 毎日3時 → IG トークン更新(通常周期)
	 * いずれも waitUntil で完走させる。毎分の3タスクは独立に waitUntil するため、
	 * いずれか1つの失敗が他を止めない。
	 */
	async scheduled(
		event: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		switch (event.cron) {
			case "* * * * *":
				ctx.waitUntil(scanDueJobs(env));
				ctx.waitUntil(sweepStaleJobs(env));
				ctx.waitUntil(checkTokenExpiryAndForceRefresh(env));
				break;
			case "0 3 * * *":
				ctx.waitUntil(refreshTokens(env));
				break;
			default:
				console.warn(`scheduled: unknown cron ${event.cron}`);
		}
	},
};

export { PublishDO } from "./publish-do.js";

// テスト用(app.request での HTTP レベル検証に使う)。
export { app };
