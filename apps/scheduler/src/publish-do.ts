import type { Env } from "./env.js";
import type { ContainerStatus } from "./instagram.js";
import {
  createContainer,
  getContainerStatus,
  getIgToken,
  publishContainer,
} from "./instagram.js";

/** ポーリング / リトライの間隔(ms)。 */
const POLL_INTERVAL_MS = 15_000;

/** storage に保持する job id のキー。 */
const JOB_ID_KEY = "jobId";

/**
 * ポーリング後の次アクションを決める純関数。ランタイム非依存でテスト可能。
 *  - IN_PROGRESS → まだ処理中、alarm を張り直す
 *  - FINISHED    → 公開へ
 *  - ERROR/EXPIRED → 恒久失敗
 * attempts が maxAttempts 以上に達している場合は(呼び出し側の例外リトライ用に)fail を返す。
 */
export function decideNext(
  statusCode: ContainerStatus,
  attempts: number,
  maxAttempts: number,
): { action: "reArm" | "publish" | "fail"; reason?: string } {
  if (attempts >= maxAttempts) {
    return { action: "fail", reason: "max attempts reached" };
  }
  switch (statusCode) {
    case "IN_PROGRESS":
      return { action: "reArm" };
    case "FINISHED":
      return { action: "publish" };
    case "ERROR":
      return { action: "fail", reason: "container status ERROR" };
    case "EXPIRED":
      return { action: "fail", reason: "container status EXPIRED" };
  }
}

/** D1 の jobs 行(DO が読むのに必要な列のみ)。 */
interface JobRow {
  id: string;
  r2_key: string;
  media_type: string;
  caption: string | null;
  status: string;
  ig_container_id: string | null;
  attempts: number;
}

/**
 * 1ジョブ = 1インスタンスで公開ステートマシンを直列化する Durable Object。
 * D1 を唯一の真実とし、進行状態(status / attempts / container_id)は毎回そこへ書く。
 * ポーリングは alarm で刻み、Worker 1回の CPU 制限を避ける。
 */
export class PublishDO implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/start") {
      return new Response("not found", { status: 404 });
    }

    const { jobId } = (await req.json()) as { jobId?: string };
    if (typeof jobId !== "string") {
      return new Response("missing jobId", { status: 400 });
    }
    // alarm から参照できるよう job id を storage に退避する。
    await this.state.storage.put(JOB_ID_KEY, jobId);

    const job = await this.loadJob(jobId);
    if (job === null) {
      return new Response("job not found", { status: 404 });
    }
    // pending 以外は既に別発火が進めているので何もしない(冪等)。
    if (job.status !== "pending") {
      return new Response(JSON.stringify({ status: job.status }), {
        headers: { "content-type": "application/json" },
      });
    }

    try {
      // pending → creating。コンテナ生成中。
      await this.updateStatus(jobId, "creating");
      const token = await getIgToken(this.env);
      const videoUrl = `${this.env.R2_PUBLIC_BASE}/${job.r2_key}`;
      const containerId = await createContainer(this.env, token, {
        videoUrl,
        caption: job.caption ?? "",
        mediaType: job.media_type as "VIDEO" | "REELS",
      });
      // creating → processing。container_id を保存しポーリングを開始。
      await this.env.DB.prepare(
        "UPDATE jobs SET status = 'processing', ig_container_id = ?, updated_at = ? WHERE id = ?",
      )
        .bind(containerId, Date.now(), jobId)
        .run();
      await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
      return new Response(JSON.stringify({ status: "processing" }), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      await this.handleFailure(jobId, err);
      return new Response(JSON.stringify({ status: "retry-scheduled" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
  }

  async alarm(): Promise<void> {
    const jobId = await this.state.storage.get<string>(JOB_ID_KEY);
    if (jobId === undefined) {
      return;
    }
    const job = await this.loadJob(jobId);
    if (job === null) {
      return;
    }
    // 既に終端 or 別経路で進行済みなら止める。
    if (job.status !== "processing" && job.status !== "publishing") {
      return;
    }

    try {
      const token = await getIgToken(this.env);

      // publishing で再入した場合(公開途中で alarm が刻まれた等)はコンテナ状態確認をスキップし公開へ。
      if (job.status !== "publishing") {
        if (job.ig_container_id === null) {
          throw new Error("processing job has no container id");
        }
        const statusCode = await getContainerStatus(
          this.env,
          token,
          job.ig_container_id,
        );
        const next = decideNext(
          statusCode,
          job.attempts,
          this.maxAttempts(),
        );
        if (next.action === "reArm") {
          await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
          return;
        }
        if (next.action === "fail") {
          await this.markFailed(jobId, next.reason ?? "container failed");
          return;
        }
        // action === "publish": processing → publishing。
        await this.updateStatus(jobId, "publishing");
      }

      // 公開実行。成功で published + media_id 保存。
      const containerId = job.ig_container_id;
      if (containerId === null) {
        throw new Error("publishing job has no container id");
      }
      const mediaId = await publishContainer(this.env, token, containerId);
      await this.env.DB.prepare(
        "UPDATE jobs SET status = 'published', ig_media_id = ?, last_error = NULL, updated_at = ? WHERE id = ?",
      )
        .bind(mediaId, Date.now(), jobId)
        .run();
      await this.state.storage.deleteAlarm();
    } catch (err) {
      await this.handleFailure(jobId, err);
    }
  }

  private maxAttempts(): number {
    const n = Number.parseInt(this.env.MAX_ATTEMPTS, 10);
    return Number.isFinite(n) && n > 0 ? n : 5;
  }

  private async loadJob(jobId: string): Promise<JobRow | null> {
    const row = await this.env.DB.prepare(
      "SELECT id, r2_key, media_type, caption, status, ig_container_id, attempts FROM jobs WHERE id = ?",
    )
      .bind(jobId)
      .first<JobRow>();
    return row ?? null;
  }

  private async updateStatus(jobId: string, status: string): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
    )
      .bind(status, Date.now(), jobId)
      .run();
  }

  private async markFailed(jobId: string, reason: string): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
    )
      .bind(reason, Date.now(), jobId)
      .run();
    await this.state.storage.deleteAlarm();
  }

  /**
   * 例外時の共通処理。attempts++ し、上限未満なら alarm を張り直して再試行、
   * 上限に達したら failed で確定する。
   */
  private async handleFailure(jobId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const job = await this.loadJob(jobId);
    const attempts = (job?.attempts ?? 0) + 1;
    const now = Date.now();

    if (attempts >= this.maxAttempts()) {
      await this.env.DB.prepare(
        "UPDATE jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
      )
        .bind(attempts, message, now, jobId)
        .run();
      await this.state.storage.deleteAlarm();
      return;
    }

    await this.env.DB.prepare(
      "UPDATE jobs SET attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
    )
      .bind(attempts, message, now, jobId)
      .run();
    // 線形バックオフ(attempts に比例)で再 alarm。
    await this.state.storage.setAlarm(now + POLL_INTERVAL_MS * attempts);
  }
}
