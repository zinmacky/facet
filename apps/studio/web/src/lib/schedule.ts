/**
 * 予約投稿の一括スケジュール生成。
 * 「期間 × 曜日 × 時刻」から投稿日時(unix ms)の昇順リストを作る。
 * すべてローカルタイム基準(datetime-local と揃える)。
 */

export interface ScheduleSpec {
  /** 開始日 "YYYY-MM-DD"。 */
  startDate: string;
  /** 終了日 "YYYY-MM-DD"(この日を含む)。 */
  endDate: string;
  /** 対象曜日。0=日 .. 6=土。 */
  weekdays: number[];
  /** 各日に割り当てる時刻 "HH:MM"(複数可)。 */
  times: string[];
}

/** 期間内で条件に合う日時(unix ms)を昇順で返す。 */
export function generateSchedule(spec: ScheduleSpec): number[] {
  const { startDate, endDate, weekdays, times } = spec;
  const start = parseYmd(startDate);
  const end = parseYmd(endDate);
  if (!start || !end || end < start || weekdays.length === 0 || times.length === 0) {
    return [];
  }
  const wdSet = new Set(weekdays);
  const parsedTimes = times
    .map(parseHm)
    .filter((t): t is [number, number] => t !== null);
  if (parsedTimes.length === 0) return [];

  const out: number[] = [];
  const cur = new Date(start);
  // 安全上限(約5.5年)でループ暴走を防ぐ。
  let guard = 0;
  while (cur <= end && guard < 2000) {
    guard++;
    if (wdSet.has(cur.getDay())) {
      for (const [h, m] of parsedTimes) {
        out.push(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), h, m, 0, 0).getTime());
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
  return out.sort((a, b) => a - b);
}

function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d);
}

function parseHm(s: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return [h, mm];
}

/** unix ms を datetime-local の value("YYYY-MM-DDTHH:MM")へ変換する。 */
export function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local の value を unix ms へ。無効なら null。 */
export function localInputToMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** 曜日ラベル(0=日)。 */
export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;
