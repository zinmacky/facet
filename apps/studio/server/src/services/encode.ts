import type { FilterPlan } from "@reframe/core";
import { run } from "@reframe/ffmpeg-runner";
import type { EncodeOptions, RunHooks } from "@reframe/ffmpeg-runner";

/**
 * エンコードのゲート層。すべての ffmpeg 実行をここに通す。
 *
 * macOS の VideoToolbox(h264_videotoolbox 等)は同時に開けるハードウェア
 * エンコードセッション数が非常に少なく、多数の書き出しを同時起動すると
 * "Error while opening encoder"(err=-12903)で失敗する。対策:
 *   A. 同時に走る ffmpeg を MAX_CONCURRENT に制限(既定 2、env で変更可)。
 *   B. それでも VideoToolbox 起動に失敗したら libx264(ソフトウェア)で再試行。
 */

const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_ENCODES) || 2);

// ---- 同時実行セマフォ ------------------------------------------------------

let active = 0;
const waiters: (() => void)[] = [];

function pump(): void {
  while (active < MAX_CONCURRENT && waiters.length > 0) {
    active++;
    const next = waiters.shift();
    next?.();
  }
}

function acquire(): Promise<void> {
  return new Promise((resolve) => {
    waiters.push(resolve);
    pump();
  });
}

function release(): void {
  active -= 1;
  pump();
}

// ---- フォールバック判定 ----------------------------------------------------

/** VideoToolbox のエンコーダ起動失敗を示すエラーか。 */
function isEncoderOpenError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /Error while opening encoder|Could not open encoder|err=-12903|-12903/.test(m);
}

/** このエンコードが VideoToolbox(HW)を使うか。 */
function usesVideoToolbox(opts: EncodeOptions): boolean {
  const enc = opts.encoder ?? "h264_videotoolbox";
  return enc.includes("videotoolbox");
}

/**
 * 同時実行を制限しつつエンコードする。
 * VideoToolbox の起動失敗時は libx264 で 1 回だけ再試行(同一スロット内)。
 * 中断(AbortSignal)時はフォールバックしない。
 */
export async function encode(
  plan: FilterPlan,
  opts: EncodeOptions,
  hooks?: RunHooks,
): Promise<void> {
  await acquire();
  try {
    // キュー待機中に中断された場合は走らせない。
    if (hooks?.signal?.aborted) {
      throw new Error("エンコードが中断されました。");
    }
    try {
      await run(plan, opts, hooks);
    } catch (err) {
      if (hooks?.signal?.aborted) throw err;
      if (usesVideoToolbox(opts) && isEncoderOpenError(err)) {
        console.warn(`VideoToolbox 起動に失敗。libx264 で再試行します: ${opts.output}`);
        await run(plan, { ...opts, encoder: "libx264" }, hooks);
      } else {
        throw err;
      }
    }
  } finally {
    release();
  }
}
