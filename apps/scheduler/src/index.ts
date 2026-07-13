import { Hono } from "hono";
import { requireBearerAuth } from "./auth.js";
import { scanDueJobs } from "./cron.js";
import type { Env } from "./env.js";
import { jobsRoutes } from "./routes/jobs.js";
import { refreshTokens } from "./token-refresh.js";

const app = new Hono<{ Bindings: Env }>();

// 疎通チェック用のヘルスチェック。無認証で公開するため認証ミドルウェアより前に登録する。
app.get("/health", (c) => c.json({ ok: true }));

// これ以降の全ルート(状態変更・情報返却を行う公開エンドポイント)に Bearer 認証を適用する。
app.use("*", requireBearerAuth());

app.get("/", (c) => c.text("facet-scheduler"));
app.route("/jobs", jobsRoutes());

export default {
	fetch: app.fetch,

	/**
	 * cron ハンドラ。event.cron でトリガを分岐する:
	 *  - "* * * * *" 毎分   → 公開時刻到来スキャン
	 *  - "0 3 * * *" 毎日3時 → IG トークン更新
	 * どちらも waitUntil で完走させる。
	 */
	async scheduled(
		event: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		switch (event.cron) {
			case "* * * * *":
				ctx.waitUntil(scanDueJobs(env));
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
