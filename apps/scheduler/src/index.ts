import { Hono } from "hono";
import { scanDueJobs } from "./cron.js";
import type { Env } from "./env.js";
import { jobsRoutes } from "./routes/jobs.js";
import { refreshTokens } from "./token-refresh.js";

const app = new Hono<{ Bindings: Env }>();

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
