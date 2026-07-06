import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { files } from "./routes/files.js";
import { preview } from "./routes/preview.js";
import { exportRoute } from "./routes/export.js";
import { publish } from "./routes/publish.js";

const app = new Hono();

// ローカルの studio web(別ポート)からのアクセスを許可する。
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      // localhost / 127.0.0.1 の任意ポートのみ許可。
      return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

// ヘルスチェック。
app.get("/health", (c) => c.json({ ok: true }));

// scheduler のジョブ状態を中継する(web の Queue ポーリング用)。
app.get("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const res = await fetch(`${config.SCHEDULER_URL}/jobs/${encodeURIComponent(id)}`);
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
});

// 各ルートをマウント(ルートは自身のパスプレフィックスを持つ)。
app.route("/", files);
app.route("/", preview);
app.route("/", exportRoute);
app.route("/", publish);

serve({ fetch: app.fetch, hostname: "localhost", port: config.PORT }, (info) => {
  // 起動ログ。
  console.log(`studio-server が http://localhost:${info.port} で起動しました`);
});
