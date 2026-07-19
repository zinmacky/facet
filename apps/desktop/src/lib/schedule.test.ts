import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	generateSchedule,
	localInputToMs,
	msToLocalInput,
	type ScheduleSpec,
} from "./schedule";

/** `Date(y, m, d)` に日数を加算した "YYYY-MM-DD" を返す(テスト用の日付計算補助)。 */
function addDaysYmd(base: Date, days: number): string {
	const d = new Date(base);
	d.setDate(d.getDate() + days);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

describe("generateSchedule", () => {
	it("単一の曜日・時刻で期間内の該当日すべてに枠を生成する", () => {
		// 2026-07-19 は日曜日。
		const spec: ScheduleSpec = {
			startDate: "2026-07-19",
			endDate: "2026-08-02",
			weekdayTimes: { 0: ["09:00"] },
		};
		const slots = generateSchedule(spec);
		expect(slots.map(msToLocalInput)).toEqual([
			"2026-07-19T09:00",
			"2026-07-26T09:00",
			"2026-08-02T09:00",
		]);
	});

	it("同一曜日に複数時刻を割り当てられる", () => {
		const spec: ScheduleSpec = {
			startDate: "2026-07-19",
			endDate: "2026-07-19",
			weekdayTimes: { 0: ["09:00", "12:30", "18:00"] },
		};
		const slots = generateSchedule(spec);
		expect(slots.map(msToLocalInput)).toEqual([
			"2026-07-19T09:00",
			"2026-07-19T12:30",
			"2026-07-19T18:00",
		]);
	});

	it("複数の曜日にまたがる枠を昇順で返す", () => {
		// 2026-07-20(月) 〜 2026-07-24(金)。
		const spec: ScheduleSpec = {
			startDate: "2026-07-20",
			endDate: "2026-07-24",
			weekdayTimes: {
				1: ["20:00"], // 月
				3: ["08:00"], // 水
				5: ["12:00"], // 金
			},
		};
		const slots = generateSchedule(spec);
		expect(slots.map(msToLocalInput)).toEqual([
			"2026-07-20T20:00",
			"2026-07-22T08:00",
			"2026-07-24T12:00",
		]);
	});

	it("該当する曜日/時刻が無ければ空配列", () => {
		const spec: ScheduleSpec = {
			startDate: "2026-07-19",
			endDate: "2026-07-25",
			weekdayTimes: { 1: [] },
		};
		expect(generateSchedule(spec)).toEqual([]);
	});

	it("endDate が startDate より前なら空配列", () => {
		const spec: ScheduleSpec = {
			startDate: "2026-07-19",
			endDate: "2026-07-18",
			weekdayTimes: { 0: ["09:00"], 6: ["09:00"] },
		};
		expect(generateSchedule(spec)).toEqual([]);
	});

	it("startDate と endDate が同日でも該当すれば1件返す", () => {
		const spec: ScheduleSpec = {
			startDate: "2026-07-19",
			endDate: "2026-07-19",
			weekdayTimes: { 0: ["09:00"] },
		};
		expect(generateSchedule(spec).map(msToLocalInput)).toEqual([
			"2026-07-19T09:00",
		]);
	});

	it("不正な時刻文字列(HH>23, MM>59)は無視して他の枠だけ返す", () => {
		const spec: ScheduleSpec = {
			startDate: "2026-07-19",
			endDate: "2026-07-19",
			weekdayTimes: { 0: ["25:00", "09:60", "09:00", "not-a-time"] },
		};
		expect(generateSchedule(spec).map(msToLocalInput)).toEqual([
			"2026-07-19T09:00",
		]);
	});

	describe("不正な日付フォーマット・暦日", () => {
		it.each([
			["startDate が正規表現に一致しない", "2026/07/19", "2026-07-25"],
			["startDate が空文字", "", "2026-07-25"],
			["endDate が正規表現に一致しない", "2026-07-19", "07-25-2026"],
			["月が範囲外(13月)", "2026-13-01", "2026-13-10"],
			["日が範囲外(32日)", "2026-07-32", "2026-08-05"],
		])("%s -> 空配列", (_label, startDate, endDate) => {
			expect(
				generateSchedule({ startDate, endDate, weekdayTimes: { 0: ["09:00"] } }),
			).toEqual([]);
		});

		it("存在しない暦日(2026-02-31)は silently 繰り上げず空配列にする", () => {
			// 修正前は `new Date(2026, 1, 31)` が 2026-03-03 へ silently 繰り上がり、
			// 誤った日付のまま枠が生成されてしまっていた(バグ)。
			const spec: ScheduleSpec = {
				startDate: "2026-02-31",
				endDate: "2026-03-10",
				weekdayTimes: { 0: ["09:00"], 1: ["09:00"], 2: ["09:00"], 3: ["09:00"], 4: ["09:00"], 5: ["09:00"], 6: ["09:00"] },
			};
			expect(generateSchedule(spec)).toEqual([]);
		});

		it("うるう年でない年の 2026-02-29 は不正な暦日として拒否する", () => {
			expect(
				generateSchedule({
					startDate: "2026-02-29",
					endDate: "2026-03-01",
					weekdayTimes: { 0: ["09:00"], 1: ["09:00"], 2: ["09:00"], 3: ["09:00"], 4: ["09:00"], 5: ["09:00"], 6: ["09:00"] },
				}),
			).toEqual([]);
		});

		it("うるう年の 2028-02-29 は正しい暦日として受理する", () => {
			const slots = generateSchedule({
				startDate: "2028-02-29",
				endDate: "2028-02-29",
				weekdayTimes: { 2: ["09:00"] }, // 2028-02-29 は火曜日
			});
			expect(slots.map(msToLocalInput)).toEqual(["2028-02-29T09:00"]);
		});

		it("endDate が不正な暦日(2026-04-31)の場合も空配列", () => {
			expect(
				generateSchedule({
					startDate: "2026-04-01",
					endDate: "2026-04-31",
					weekdayTimes: { 0: ["09:00"], 1: ["09:00"], 2: ["09:00"], 3: ["09:00"], 4: ["09:00"], 5: ["09:00"], 6: ["09:00"] },
				}),
			).toEqual([]);
		});
	});

	describe("月・年境界", () => {
		it("月をまたぐ期間でも正しく1日ずつ進む(1月→2月)", () => {
			const spec: ScheduleSpec = {
				startDate: "2026-01-30",
				endDate: "2026-02-02",
				weekdayTimes: {
					0: ["09:00"],
					1: ["09:00"],
					2: ["09:00"],
					3: ["09:00"],
					4: ["09:00"],
					5: ["09:00"],
					6: ["09:00"],
				},
			};
			expect(generateSchedule(spec).map(msToLocalInput)).toEqual([
				"2026-01-30T09:00",
				"2026-01-31T09:00",
				"2026-02-01T09:00",
				"2026-02-02T09:00",
			]);
		});

		it("年をまたぐ期間でも正しく1日ずつ進む(2026年→2027年)", () => {
			const spec: ScheduleSpec = {
				startDate: "2026-12-30",
				endDate: "2027-01-02",
				weekdayTimes: {
					0: ["09:00"],
					1: ["09:00"],
					2: ["09:00"],
					3: ["09:00"],
					4: ["09:00"],
					5: ["09:00"],
					6: ["09:00"],
				},
			};
			expect(generateSchedule(spec).map(msToLocalInput)).toEqual([
				"2026-12-30T09:00",
				"2026-12-31T09:00",
				"2027-01-01T09:00",
				"2027-01-02T09:00",
			]);
		});
	});

	describe("2000日ガード(安全上限)", () => {
		it("期間がちょうど2000日ならすべての枠を返す(切り捨てなし)", () => {
			const start = new Date(2020, 0, 1);
			const spec: ScheduleSpec = {
				startDate: "2020-01-01",
				// 1999日後 = start を含めて2000日分。
				endDate: addDaysYmd(start, 1999),
				weekdayTimes: {
					0: ["09:00"],
					1: ["09:00"],
					2: ["09:00"],
					3: ["09:00"],
					4: ["09:00"],
					5: ["09:00"],
					6: ["09:00"],
				},
			};
			expect(generateSchedule(spec)).toHaveLength(2000);
		});

		it("期間が2000日を超えると、上限を超えた日以降は警告なく切り捨てられる", () => {
			const start = new Date(2020, 0, 1);
			const spec: ScheduleSpec = {
				startDate: "2020-01-01",
				// 2000日後 = start を含めて2001日分になるはずが、2000件で打ち切られる。
				endDate: addDaysYmd(start, 2000),
				weekdayTimes: {
					0: ["09:00"],
					1: ["09:00"],
					2: ["09:00"],
					3: ["09:00"],
					4: ["09:00"],
					5: ["09:00"],
					6: ["09:00"],
				},
			};
			const slots = generateSchedule(spec);
			expect(slots).toHaveLength(2000);
			// 2001日目(最終日)は含まれない。
			expect(slots.map(msToLocalInput)).not.toContain(
				`${addDaysYmd(start, 2000)}T09:00`,
			);
		});
	});

	describe("DST(サマータイム)を跨ぐローカル時刻", () => {
		const originalTz = process.env.TZ;

		beforeEach(() => {
			// DST を採用するタイムゾーンへ切り替える(このリポジトリの開発機/CI は
			// JST/UTC 相当で DST が無いため、明示的に切り替えないと再現できない)。
			process.env.TZ = "America/New_York";
		});

		afterEach(() => {
			process.env.TZ = originalTz;
		});

		it("スプリングフォワード(2026-03-08、2時台が存在しない)でも例外を投げず有効な時刻を返す", () => {
			// 2026年の米国東部は 3/8 2:00 AM に 3:00 AM へ繰り上がる。
			const spec: ScheduleSpec = {
				startDate: "2026-03-08",
				endDate: "2026-03-08",
				weekdayTimes: { 0: ["02:30"] }, // 2026-03-08 は日曜日
			};
			const slots = generateSchedule(spec);
			expect(slots).toHaveLength(1);
			expect(Number.isFinite(slots[0])).toBe(true);
		});

		it("フォールバック(2026-11-01、1時台が重複する)でも例外を投げず有効な時刻を返す", () => {
			const spec: ScheduleSpec = {
				startDate: "2026-11-01",
				endDate: "2026-11-01",
				weekdayTimes: { 0: ["01:30"] }, // 2026-11-01 は日曜日
			};
			const slots = generateSchedule(spec);
			expect(slots).toHaveLength(1);
			expect(Number.isFinite(slots[0])).toBe(true);
		});
	});
});

describe("msToLocalInput / localInputToMs", () => {
	it("往復変換で元の ms(分精度)に戻る", () => {
		const ms = new Date(2026, 6, 19, 9, 5, 0, 0).getTime();
		const roundTripped = localInputToMs(msToLocalInput(ms));
		expect(roundTripped).toBe(ms);
	});

	it("localInputToMs は空文字なら null", () => {
		expect(localInputToMs("")).toBeNull();
	});

	it("localInputToMs は不正な文字列なら null", () => {
		expect(localInputToMs("not-a-date")).toBeNull();
	});

	it("msToLocalInput は0埋めした2桁で月日時分を整形する", () => {
		const ms = new Date(2026, 0, 5, 9, 5, 0, 0).getTime();
		expect(msToLocalInput(ms)).toBe("2026-01-05T09:05");
	});
});
