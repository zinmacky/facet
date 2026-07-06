import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { jobManifest, type JobManifest, type MediaType } from "@reframe/contract";
import { config } from "../config.js";

/**
 * ローカルの動画を R2 にアップロードし、scheduler にジョブ登録する。
 * Instagram はローカルから直接投稿できないため、公開はクラウド側(scheduler)に委譲する。
 */

export interface UploadToR2AndEnqueueParams {
  videoPath: string;
  caption: string;
  mediaType: MediaType;
  /** 公開時刻(unix ms)。 */
  publishAt: number;
}

export interface UploadToR2AndEnqueueResult {
  jobId: string;
  status: string;
  r2Key: string;
}

/**
 * R2 オブジェクトキーを生成する。純関数として切り出しテスト可能にする。
 * 形式: posts/<YYYY-MM-DD>/<uuid>.mp4 。日付は publishAt を UTC で解釈する。
 */
export function buildR2Key(publishAtMs: number, uuid: string): string {
  const d = new Date(publishAtMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `posts/${yyyy}-${mm}-${dd}/${uuid}.mp4`;
}

/** R2 連携に必要な設定が揃っているか検証しつつ取り出す。 */
function requireR2Config(): {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
} {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = config;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "R2 連携に必要な環境変数が未設定です (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)",
    );
  }
  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
  };
}

export async function uploadToR2AndEnqueue(
  params: UploadToR2AndEnqueueParams,
): Promise<UploadToR2AndEnqueueResult> {
  const { videoPath, caption, mediaType, publishAt } = params;
  const r2 = requireR2Config();

  const r2Key = buildR2Key(publishAt, randomUUID());

  // 1. R2(S3 互換エンドポイント)へ署名付き PUT。
  const client = new AwsClient({
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    service: "s3",
    region: "auto",
  });

  const body = await readFile(videoPath);
  const putUrl = `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}/${r2Key}`;
  const putRes = await client.fetch(putUrl, {
    method: "PUT",
    body,
    headers: { "content-type": "video/mp4" },
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => "");
    throw new Error(`R2 へのアップロードに失敗しました (${putRes.status}): ${text}`);
  }

  // 2. ジョブマニフェストを組み立て、zod で検証してから scheduler に登録する。
  const manifest: JobManifest = jobManifest.parse({
    idempotencyKey: randomUUID(),
    platform: "instagram",
    r2Key,
    mediaType,
    caption,
    publishAt,
  });

  const enqueueRes = await fetch(`${config.SCHEDULER_URL}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(manifest),
  });
  if (!enqueueRes.ok) {
    const text = await enqueueRes.text().catch(() => "");
    throw new Error(`scheduler へのジョブ登録に失敗しました (${enqueueRes.status}): ${text}`);
  }

  const json = (await enqueueRes.json()) as { id: string; status: string };
  return { jobId: json.id, status: json.status, r2Key };
}
