import { spawn } from "node:child_process";
import type { FilterPlan } from "@facet/core";

/** 対応する映像エンコーダ。 */
export type Encoder = "h264_videotoolbox" | "hevc_videotoolbox" | "libx264";

/** エンコード指定。encoder/bitrate/audioBitrate/overwrite は既定値あり。 */
export interface EncodeOptions {
  input: string;
  output: string;
  encoder?: Encoder;
  bitrate?: string;
  audioBitrate?: string;
  overwrite?: boolean;
  /** 総尺(ミリ秒)。与えられれば Progress.percent を計算する。 */
  totalDurationMs?: number;
}

/** エンコード進捗。ffmpeg -progress の 1 レコード分に対応する。 */
export interface Progress {
  outTimeMs: number;
  frame: number;
  fps: number;
  speed: number;
  percent?: number;
}

/** run のフック。進捗通知と中断シグナル。 */
export interface RunHooks {
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

const DEFAULT_ENCODER: Encoder = "h264_videotoolbox";
const DEFAULT_BITRATE = "8M";
const DEFAULT_AUDIO_BITRATE = "128k";

/**
 * FilterPlan と EncodeOptions から ffmpeg 引数配列を組み立てる純関数。
 * -progress/-nostats は付けない(run 側で付与する)ため、単体テストしやすい。
 *
 * 引数順序の要点:
 *   - seekArgs(-ss 等)は入力より前に置くことで高速シークになる
 *   - durationArgs(-t/-to 等)は入力より後ろに置き -ss 起点からの相対にする
 */
export function buildFfmpegArgs(plan: FilterPlan, opts: EncodeOptions): string[] {
  const encoder = opts.encoder ?? DEFAULT_ENCODER;
  const bitrate = opts.bitrate ?? DEFAULT_BITRATE;
  const audioBitrate = opts.audioBitrate ?? DEFAULT_AUDIO_BITRATE;

  return [
    "-hide_banner",
    ...(opts.overwrite ? ["-y"] : []),
    ...plan.seekArgs,
    "-i",
    opts.input,
    ...plan.durationArgs,
    "-filter_complex",
    plan.filterComplex,
    "-map",
    plan.outLabel,
    "-map",
    "0:a?",
    "-c:v",
    encoder,
    "-b:v",
    bitrate,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
    "-movflags",
    "+faststart",
    opts.output,
  ];
}

/** 保持する stderr の末尾行数。 */
const STDERR_TAIL_LINES = 40;

/** ffmpeg -progress の key=value 行を Progress に蓄積するパーサ。 */
interface ProgressAccumulator {
  outTimeMs: number;
  frame: number;
  fps: number;
  speed: number;
}

/**
 * -progress の 1 行を解釈して accumulator を更新する。
 * "progress=continue"/"end" に達したらそのレコードを確定する合図(true)を返す。
 */
function applyProgressLine(line: string, acc: ProgressAccumulator): boolean {
  const eq = line.indexOf("=");
  if (eq < 0) return false;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();

  switch (key) {
    case "out_time_us": {
      const us = Number(value);
      if (Number.isFinite(us)) acc.outTimeMs = us / 1000;
      return false;
    }
    case "out_time_ms": {
      // ffmpeg の out_time_ms は実際にはマイクロ秒単位。out_time_us が無い場合の保険。
      const ms = Number(value);
      if (Number.isFinite(ms)) acc.outTimeMs = ms / 1000;
      return false;
    }
    case "frame": {
      const n = Number(value);
      if (Number.isFinite(n)) acc.frame = n;
      return false;
    }
    case "fps": {
      const n = Number(value);
      if (Number.isFinite(n)) acc.fps = n;
      return false;
    }
    case "speed": {
      // "1.23x" 形式。末尾の x を除去。
      const n = Number(value.replace(/x$/, ""));
      if (Number.isFinite(n)) acc.speed = n;
      return false;
    }
    case "progress":
      // continue / end のいずれでもレコード確定。
      return true;
    default:
      return false;
  }
}

/**
 * ffmpeg を spawn してエンコードを実行する。
 * - stdout を行バッファで読み、-progress レコードごとに onProgress を呼ぶ
 * - stderr は末尾数十行だけ保持し、失敗時のエラーに含める
 * - exit code 0 で resolve、非 0 で reject
 * - signal.abort で子プロセスを kill して reject
 */
export function run(plan: FilterPlan, opts: EncodeOptions, hooks?: RunHooks): Promise<void> {
  const args = [...buildFfmpegArgs(plan, opts), "-progress", "pipe:1", "-nostats"];
  const totalDurationMs = opts.totalDurationMs;

  return new Promise<void>((resolve, reject) => {
    const signal = hooks?.signal;
    if (signal?.aborted) {
      reject(new Error("エンコードは開始前に中断されました"));
      return;
    }

    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    let settled = false;
    let aborted = false;
    const stderrTail: string[] = [];

    // stdout の行バッファ。
    let stdoutBuf = "";
    const acc: ProgressAccumulator = { outTimeMs: 0, frame: 0, fps: 0, speed: 0 };

    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGKILL");
    };

    const cleanup = (): void => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    if (signal) signal.addEventListener("abort", onAbort);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf("\n");
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const complete = applyProgressLine(line, acc);
        if (complete && hooks?.onProgress) {
          const progress: Progress = {
            outTimeMs: acc.outTimeMs,
            frame: acc.frame,
            fps: acc.fps,
            speed: acc.speed,
          };
          if (totalDurationMs !== undefined && totalDurationMs > 0) {
            progress.percent = Math.min(100, (acc.outTimeMs / totalDurationMs) * 100);
          }
          hooks.onProgress(progress);
        }
        nl = stdoutBuf.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.length === 0) continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`ffmpeg の起動に失敗しました: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        reject(new Error("エンコードは中断されました"));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderrTail.join("\n");
      reject(new Error(`ffmpeg が異常終了しました (exit code ${code ?? "null"}):\n${tail}`));
    });
  });
}
