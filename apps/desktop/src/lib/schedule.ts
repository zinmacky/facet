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
	/** 曜日(0=日 .. 6=土)ごとの時刻リスト "HH:MM"。曜日ごとに異なる時刻を持てる。 */
	weekdayTimes: Record<number, string[]>;
}

/** 期間内で、各曜日に設定された時刻の日時(unix ms)を昇順で返す。 */
export function generateSchedule(spec: ScheduleSpec): number[] {
	const { startDate, endDate, weekdayTimes } = spec;
	const start = parseYmd(startDate);
	const end = parseYmd(endDate);
	if (!start || !end || end < start) return [];

	const out: number[] = [];
	const cur = new Date(start);
	// 安全上限(約5.5年 = 2000日)でループ暴走を防ぐ。上限を超える期間を渡した場合、
	// 上限以降の日は警告なく silently 切り捨てられる(意図的な既定挙動 — この機能は
	// 「数日〜数週間分の予約枠」を想定しており、年単位の期間は誤入力の可能性が高いため、
	// エラーにするよりは「とりあえず動く」を優先している。境界値は schedule.test.ts で固定)。
	let guard = 0;
	while (cur <= end && guard < 2000) {
		guard++;
		const times = weekdayTimes[cur.getDay()];
		if (times && times.length > 0) {
			for (const t of times) {
				const hm = parseHm(t);
				if (hm) {
					out.push(
						new Date(
							cur.getFullYear(),
							cur.getMonth(),
							cur.getDate(),
							hm[0],
							hm[1],
							0,
							0,
						).getTime(),
					);
				}
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
	const date = new Date(y, mo - 1, d);
	// `new Date(y, mo, d)` は例えば "2026-02-31" のような存在しない暦日を
	// silently 繰り上げる(例: 2026-03-03 になる)。呼び出し側(generateSchedule)へ
	// 誤った日付のまま返さないよう、構築結果が入力と一致するか検証して弾く
	// (呼び出し元の usePublishExtras.tsx は null/[] を「枠が生成されませんでした」の
	// 汎用メッセージで扱う既存の設計のため、ここでは null を返すだけでよい)。
	if (
		date.getFullYear() !== y ||
		date.getMonth() !== mo - 1 ||
		date.getDate() !== d
	) {
		return null;
	}
	return date;
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
export const WEEKDAY_LABELS = [
	"日",
	"月",
	"火",
	"水",
	"木",
	"金",
	"土",
] as const;
