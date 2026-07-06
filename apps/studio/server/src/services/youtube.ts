import { createReadStream } from "node:fs";
import { google } from "googleapis";
import { config } from "../config.js";

/**
 * YouTube への予約投稿(アップロード + publishAt スケジュール)。
 *
 * 前提と制約:
 * - 2020-07-28 以降に作成された未監査(unverified)API クライアントでアップロードした動画は、
 *   privacyStatus の指定にかかわらず強制的に "private" に固定されうる。監査を通していない場合、
 *   下記の publishAt による private→public 自動フリップは機能しない点に注意。
 * - 本関数は privacyStatus="private" + publishAt=<ISO> で登録し、その時刻に自動公開させる前提。
 *   このフリップは「監査済み」または該当制約の対象外のクライアントでのみ有効。
 */

export interface UploadWithScheduleParams {
  videoPath: string;
  title: string;
  description?: string;
  /** 公開予約時刻。ISO 8601 文字列。指定時は private 固定で予約公開。 */
  publishAt?: string;
  /** publishAt 未指定時の公開範囲。既定は private。 */
  privacyStatus?: "private" | "unlisted" | "public";
  tags?: string[];
}

export interface UploadWithScheduleResult {
  videoId: string;
  status: string;
}

/** YouTube OAuth 用の必須設定が揃っているか検証しつつ取り出す。 */
function requireYoutubeConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken: string;
} {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI, YOUTUBE_REFRESH_TOKEN } =
    config;
  if (
    !YOUTUBE_CLIENT_ID ||
    !YOUTUBE_CLIENT_SECRET ||
    !YOUTUBE_REDIRECT_URI ||
    !YOUTUBE_REFRESH_TOKEN
  ) {
    throw new Error(
      "YouTube 連携に必要な環境変数が未設定です (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REDIRECT_URI / YOUTUBE_REFRESH_TOKEN)",
    );
  }
  return {
    clientId: YOUTUBE_CLIENT_ID,
    clientSecret: YOUTUBE_CLIENT_SECRET,
    redirectUri: YOUTUBE_REDIRECT_URI,
    refreshToken: YOUTUBE_REFRESH_TOKEN,
  };
}

/**
 * 動画をアップロードし publishAt に予約公開する。
 * resumable upload はライブラリ側が自動的に担う。
 */
export async function uploadWithSchedule(
  params: UploadWithScheduleParams,
): Promise<UploadWithScheduleResult> {
  const { videoPath, title, description, publishAt, privacyStatus, tags } = params;
  const creds = requireYoutubeConfig();

  const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret, creds.redirectUri);
  oauth2.setCredentials({ refresh_token: creds.refreshToken });

  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  // 予約公開(publishAt 指定)時は YouTube 側の要件で private が必須。
  const scheduled = publishAt !== undefined;
  const privacy = scheduled ? "private" : (privacyStatus ?? "private");

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title,
        description: description ?? "",
        ...(tags ? { tags } : {}),
      },
      status: {
        privacyStatus: privacy,
        // publishAt を指定すると、その時刻に private→public へ自動フリップされる(監査済み前提)。
        ...(publishAt !== undefined ? { publishAt } : {}),
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: createReadStream(videoPath),
    },
  });

  const videoId = res.data.id;
  if (!videoId) {
    throw new Error("YouTube のアップロードは成功しましたが videoId が取得できませんでした");
  }

  return { videoId, status: scheduled ? "scheduled" : privacy };
}
