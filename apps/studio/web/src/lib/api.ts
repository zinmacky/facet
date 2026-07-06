import type { EditSpec } from "@reframe/core";
import type { JobCreateResponse, MediaType } from "@reframe/contract";

/**
 * studio server(:5178)への薄い fetch ラッパ。
 * すべて dev proxy 経由の相対パス(/api・/files)で叩き、CORS を持ち込まない。
 * server は現状スタブなので、UI が要求するレスポンス形状をここで型として固定する。
 */

const API_BASE = "/api";

/** 共通 JSON POST。非 2xx は本文を載せて throw する。 */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ApiError(res.status, detail || res.statusText);
  }
  return (await res.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ApiError(res.status, detail || res.statusText);
  }
  return (await res.json()) as T;
}

/** ステータスコードを保持する API エラー。UI 側で分岐に使える。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---- file pick -------------------------------------------------------------

/** ネイティブファイルダイアログの結果。成功時 path、キャンセル時 canceled。 */
export interface PickResult {
  path?: string;
  canceled?: boolean;
}

/** OS のファイルダイアログを開いて元動画のパスを得る。 */
export async function pickFile(): Promise<PickResult> {
  return postJson<PickResult>("/files/pick", {});
}

// ---- ファイル配信 / ダウンロード -------------------------------------------

/** ローカルファイルの配信 URL(<video> src 用)。/files は dev proxy 経由。 */
export function fileRawUrl(path: string): string {
  return `/files/raw?path=${encodeURIComponent(path)}`;
}

/** ダウンロード用 URL(Content-Disposition attachment)。 */
export function fileDownloadUrl(path: string): string {
  return `${fileRawUrl(path)}&download=1`;
}

/** 複数ファイルを ZIP でまとめてダウンロードする。 */
export async function downloadZip(paths: string[], name = "reframe-export.zip"): Promise<void> {
  const res = await fetch(`/files/zip`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths, name }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ApiError(res.status, detail || res.statusText);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- probe -----------------------------------------------------------------

/** ffprobe 由来のソースメタ。UI は width/height/duration を主に使う。 */
export interface ProbeResult {
  /** server が配信できる相対 URL(/files/...)。<video> の src に使う。 */
  url: string;
  width: number;
  height: number;
  /** 秒。 */
  duration: number;
  /** 例: "h264"。 */
  codec?: string;
  fps?: number;
}

/** ローカルパスを probe してソース寸法と配信 URL を得る。 */
export function probeFile(path: string): Promise<ProbeResult> {
  return postJson<ProbeResult>("/probe", { path });
}

// ---- preview ---------------------------------------------------------------

/** プレビュー生成レスポンス。低解像度のプレビュークリップ URL を返す想定。 */
export interface PreviewResult {
  url: string;
  width: number;
  height: number;
}

/** EditSpec からプレビュー(短尺・低解像度)を生成する。input は元動画の絶対パス。 */
export function postPreview(spec: EditSpec, input: string): Promise<PreviewResult> {
  return postJson<PreviewResult>("/preview", { spec, input });
}

// ---- export ----------------------------------------------------------------

/** 書き出しリクエスト。output は保存先ベース名/相対パス。 */
export interface ExportRequest {
  spec: EditSpec;
  /** 元動画の絶対パス(probe に渡したパス)。 */
  input: string;
  /** 出力ファイル名(server の WORK_DIR 基準)。 */
  output: string;
}

/** 書き出しジョブ受理レスポンス。SSE の購読キーになる。 */
export interface ExportAccepted {
  jobId: string;
}

/** 書き出しジョブを受理させる。進捗は subscribeExport で購読する。 */
export function postExport(req: ExportRequest): Promise<ExportAccepted> {
  return postJson<ExportAccepted>("/export", req);
}

/** SSE で流れてくる書き出し進捗イベント。 */
export type ExportEvent =
  | { type: "progress"; ratio: number; fps?: number }
  | { type: "notice"; message: string }
  | { type: "done"; outputPath: string; r2Key?: string }
  | { type: "error"; message: string };

/**
 * 書き出し進捗を EventSource で購読する。
 * 戻り値の関数で購読解除する(コンポーネントの effect cleanup で呼ぶ)。
 */
export function subscribeExport(
  jobId: string,
  handlers: {
    onEvent: (event: ExportEvent) => void;
    onError?: (err: Event) => void;
  },
): () => void {
  // EventSource は proxy 経由の相対 URL で問題なく張れる。
  const es = new EventSource(`${API_BASE}/export/${encodeURIComponent(jobId)}/events`);

  es.onmessage = (msg) => {
    try {
      const parsed = JSON.parse(msg.data) as ExportEvent;
      handlers.onEvent(parsed);
      if (parsed.type === "done" || parsed.type === "error") es.close();
    } catch {
      // 壊れたフレームは無視(server 側の flush 境界で稀に起きうる)。
    }
  };
  es.onerror = (err) => {
    handlers.onError?.(err);
  };

  return () => es.close();
}

// ---- publish ---------------------------------------------------------------

/** YouTube 公開ペイロード。書き出し済みファイルを予約投稿する。 */
export interface YoutubePublishPayload {
  /** 書き出し済み出力パス(server の WORK_DIR 基準)。 */
  outputPath: string;
  title: string;
  description?: string;
  /** 公開時刻(unix ms)。未指定なら即時公開。 */
  publishAt?: number;
  privacyStatus?: "private" | "unlisted" | "public";
}

/** YouTube 公開レスポンス。 */
export interface YoutubePublishResult {
  videoId: string;
  status: string;
}

/** YouTube へ(予約)投稿する。 */
export function publishYoutube(
  payload: YoutubePublishPayload,
): Promise<YoutubePublishResult> {
  return postJson<YoutubePublishResult>("/publish/youtube", payload);
}

/**
 * Instagram 公開ペイロード。studio → scheduler の JobManifest を組む素材。
 * server が R2 アップロード + idempotencyKey 発番 + scheduler 登録を担う。
 */
export interface InstagramPublishPayload {
  outputPath: string;
  mediaType: MediaType;
  caption: string;
  /** 公開時刻(unix ms)。scheduler がこの時刻以降に公開する。 */
  publishAt: number;
}

/** Instagram 予約は scheduler のジョブ登録結果をそのまま返す。 */
export function publishInstagram(
  payload: InstagramPublishPayload,
): Promise<JobCreateResponse> {
  return postJson<JobCreateResponse>("/publish/instagram", payload);
}

/** scheduler 上のジョブ状態を引く(Queue のポーリング用)。 */
export function getJob(id: string): Promise<import("@reframe/contract").JobRecord> {
  return getJson(`/jobs/${encodeURIComponent(id)}`);
}
