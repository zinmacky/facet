import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createContainer,
	getContainerStatus,
	getIgToken,
	InstagramError,
	publishContainer,
} from "./instagram.js";
import { backoffDelayMs, decideNext, PublishDO } from "./publish-do.js";

// instagram の外部 API 呼び出しはスタブ化する。InstagramError は実クラスを残し、
// isAlreadyPublishedError の instanceof 判定が効くようにする。
vi.mock("./instagram.js", async (importActual) => {
	const actual = await importActual<typeof import("./instagram.js")>();
	return {
		...actual,
		getIgToken: vi.fn(),
		createContainer: vi.fn(),
		getContainerStatus: vi.fn(),
		publishContainer: vi.fn(),
	};
});

const mockGetIgToken = vi.mocked(getIgToken);
const mockCreateContainer = vi.mocked(createContainer);
const mockGetContainerStatus = vi.mocked(getContainerStatus);
const mockPublishContainer = vi.mocked(publishContainer);

/**
 * decideNext の純粋テスト。Worker ランタイム不要。
 * status_code と attempts から次アクションが正しく決まることを検証する。
 */
describe("decideNext", () => {
	const MAX = 5;

	it("FINISHED は publish", () => {
		expect(decideNext("FINISHED", 0, MAX).action).toBe("publish");
	});

	it("IN_PROGRESS は reArm", () => {
		expect(decideNext("IN_PROGRESS", 0, MAX).action).toBe("reArm");
	});

	it("ERROR は fail", () => {
		const r = decideNext("ERROR", 0, MAX);
		expect(r.action).toBe("fail");
		expect(r.reason).toBeDefined();
	});

	it("EXPIRED は fail", () => {
		const r = decideNext("EXPIRED", 0, MAX);
		expect(r.action).toBe("fail");
		expect(r.reason).toBeDefined();
	});

	it("attempts が max 到達なら status に関わらず fail", () => {
		expect(decideNext("FINISHED", MAX, MAX).action).toBe("fail");
		expect(decideNext("IN_PROGRESS", MAX, MAX).action).toBe("fail");
		expect(decideNext("IN_PROGRESS", MAX + 1, MAX).action).toBe("fail");
	});

	it("attempts が max 未満なら通常判定", () => {
		expect(decideNext("IN_PROGRESS", MAX - 1, MAX).action).toBe("reArm");
		expect(decideNext("FINISHED", MAX - 1, MAX).action).toBe("publish");
	});
});

/**
 * DO 状態機械(alarm)の回帰テスト。DurableObjectState.storage / Env.DB を
 * インメモリのフェイクで置き換え、instagram の外部呼び出しはスタブ化して
 * 状態遷移だけを検証する(Workers ランタイム不要)。
 */

interface FakeJob {
	id: string;
	r2_key: string;
	media_type: string;
	caption: string | null;
	status: string;
	ig_container_id: string | null;
	ig_media_id: string | null;
	attempts: number;
	updated_at: number;
}

/** 既知の UPDATE 文パターンを判定してインメモリ行へ反映する。id は常に末尾の bind 引数。 */
function applyWrite(row: FakeJob, sql: string, args: unknown[]): void {
	if (sql.includes("status = 'processing'")) {
		row.status = "processing";
		row.ig_container_id = args[0] as string;
	} else if (sql.includes("status = 'published'")) {
		row.status = "published";
		row.ig_media_id = args[0] as string | null;
		row.last_error = undefined;
	} else if (sql.includes("status = 'failed'") && sql.includes("attempts = ?")) {
		row.status = "failed";
		row.attempts = args[0] as number;
	} else if (sql.includes("status = 'failed'")) {
		row.status = "failed";
	} else if (sql.includes("SET status = ?")) {
		row.status = args[0] as string;
	} else if (sql.includes("SET attempts = ?")) {
		row.attempts = args[0] as number;
	}
	// 本コードベースの UPDATE 文は "... updated_at = ?, ... WHERE id = ?" の形
	// (id が常に最後の bind 引数)を守っているため、updated_at は末尾から2番目に
	// 現れる。touchUpdatedAt のような status を変えない更新もここで一律に拾える。
	if (sql.includes("updated_at = ?")) {
		const idx = args.length - 2;
		if (idx >= 0) {
			row.updated_at = args[idx] as number;
		}
	}
}

/**
 * @param options.claimSucceeds pending → creating の原子的 claim(WHERE status = 'pending'
 *   付き UPDATE)が成功するか。false にすると D1 の `meta.changes = 0` 相当を返し、
 *   「loadJob 時点では pending だったが claim 実行時には既に他インスタンスが奪っていた」
 *   という同時発火の競合を模せる(row 自体は変更しない = 競合相手側の状態はこの
 *   フェイクの外側の出来事として扱う)。
 * @param options.maxAttempts env.MAX_ATTEMPTS に渡す文字列(既定 "8")。maxAttempts()
 *   のパース fallback(未設定/不正値なら 8)を検証するテスト用に上書きできる。
 */
function makeHarness(
	initial: Partial<FakeJob>,
	options?: { claimSucceeds?: boolean; maxAttempts?: string },
) {
	const row: FakeJob & { last_error?: string } = {
		id: "job-1",
		r2_key: "2026/07/13/uuid.mp4",
		media_type: "REELS",
		caption: "hello",
		status: "pending",
		ig_container_id: null,
		ig_media_id: null,
		attempts: 0,
		updated_at: 0,
		...initial,
	};
	const store = new Map<string, unknown>();
	const storage = {
		get: async (k: string) => store.get(k),
		put: async (k: string, v: unknown) => {
			store.set(k, v);
		},
		delete: async (k: string) => {
			store.delete(k);
		},
		setAlarm: async (t: number) => {
			store.set("__alarm", t);
		},
		deleteAlarm: async () => {
			store.delete("__alarm");
		},
		getAlarm: async () => store.get("__alarm") ?? null,
	};
	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async run() {
							// claimPendingForCreating(指摘1)の原子的 claim。実 D1 の
							// `WHERE ... AND status = 'pending'` は当フェイクでは
							// options.claimSucceeds で明示的に制御する(既定 true)。
							if (sql.includes("AND status = 'pending'")) {
								const claimSucceeds = options?.claimSucceeds ?? true;
								if (claimSucceeds) {
									row.status = "creating";
									const idx = args.length - 2; // updated_at
									if (idx >= 0) {
										row.updated_at = args[idx] as number;
									}
								}
								return { meta: { changes: claimSucceeds ? 1 : 0 } };
							}
							applyWrite(row, sql, args);
							return { meta: { changes: 1 } };
						},
						async first() {
							// loadJob の SELECT。id 一致でコピーを返す。
							return args[0] === row.id ? { ...row } : null;
						},
					};
				},
			};
		},
	};
	const env = {
		R2_PUBLIC_BASE: "https://r2.example",
		// 既定8: BACKOFF_SCHEDULE_MS(30秒〜15分の指数バックオフ)と組み合わせて
		// 合計約48.5分粘る本番デフォルトに合わせる。
		MAX_ATTEMPTS: options?.maxAttempts ?? "8",
		DB: db,
	};
	// storage に jobId を退避しておく(alarm は storage 経由で job を引く)。
	store.set("jobId", row.id);
	// biome-ignore lint/suspicious/noExplicitAny: フェイクを DO の型へ流し込む
	const DO = new PublishDO({ storage } as any, env as any);
	return { DO, row, store };
}

describe("PublishDO.alarm: creating リトライ(H-1)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetIgToken.mockResolvedValue("token");
		mockCreateContainer.mockResolvedValue("container-1");
		mockGetContainerStatus.mockResolvedValue("FINISHED");
		mockPublishContainer.mockResolvedValue("media-1");
	});

	it("creating で滞留したジョブを alarm が拾い、生成成功で processing へ進める", async () => {
		const { DO, row, store } = makeHarness({ status: "creating", attempts: 1 });

		await DO.alarm();

		expect(mockCreateContainer).toHaveBeenCalledTimes(1);
		expect(row.status).toBe("processing");
		expect(row.ig_container_id).toBe("container-1");
		// ポーリング alarm と打ち切り時刻が張られる。
		expect(store.get("__alarm")).toBeDefined();
		expect(store.get("pollDeadline")).toBeDefined();
	});

	it("creating の生成が再び失敗すると attempts++ して creating のまま alarm を張り直す", async () => {
		mockCreateContainer.mockRejectedValueOnce(new InstagramError("transient"));
		const { DO, row, store } = makeHarness({ status: "creating", attempts: 1 });

		await DO.alarm();

		expect(row.status).toBe("creating");
		expect(row.attempts).toBe(2);
		expect(store.get("__alarm")).toBeDefined();
	});

	it("creating で attempts が上限に達すると failed 確定し alarm/deadline を掃除する", async () => {
		mockCreateContainer.mockRejectedValueOnce(new InstagramError("transient"));
		// MAX_ATTEMPTS=8(既定)。attempts=7 で失敗すると 8 に達し終端。
		const { DO, row, store } = makeHarness({ status: "creating", attempts: 7 });
		store.set("pollDeadline", Date.now() + 60_000);

		await DO.alarm();

		expect(row.status).toBe("failed");
		expect(row.attempts).toBe(8);
		expect(store.get("__alarm")).toBeUndefined();
		expect(store.get("pollDeadline")).toBeUndefined();
	});
});

describe("PublishDO.alarm: publish 冪等化(S-2)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetIgToken.mockResolvedValue("token");
		mockPublishContainer.mockResolvedValue("media-1");
	});

	it("ig_media_id が既にあれば publish せず published で終端する", async () => {
		const { DO, row, store } = makeHarness({
			status: "publishing",
			ig_container_id: "container-1",
			ig_media_id: "media-existing",
		});
		store.set("pollDeadline", Date.now() + 60_000);

		await DO.alarm();

		expect(mockPublishContainer).not.toHaveBeenCalled();
		expect(row.status).toBe("published");
		expect(row.ig_media_id).toBe("media-existing");
		// 終端で alarm / deadline を掃除する。
		expect(store.get("__alarm")).toBeUndefined();
		expect(store.get("pollDeadline")).toBeUndefined();
	});

	it("publish が『既に公開済み』を返したら failed ではなく published にする", async () => {
		mockPublishContainer.mockRejectedValueOnce(
			new InstagramError("The media has already been published"),
		);
		const { DO, row } = makeHarness({
			status: "publishing",
			ig_container_id: "container-1",
		});

		await DO.alarm();

		expect(row.status).toBe("published");
	});

	it("publish が無関係なエラーなら published にはせず failed リトライへ回す", async () => {
		mockPublishContainer.mockRejectedValueOnce(
			new InstagramError("temporary server error"),
		);
		const { DO, row } = makeHarness({
			status: "publishing",
			ig_container_id: "container-1",
			attempts: 7, // MAX_ATTEMPTS=8。上限到達で failed 確定させ、終端を観測する
		});

		await DO.alarm();

		expect(row.status).toBe("failed");
	});
});

/**
 * PublishDO.fetch("/start") の回帰テスト(指摘1: pending → creating の原子的 claim)。
 * loadJob(D1 サブリクエスト)は DO の input gate 対象外のため、読み取りと直後の
 * 書き込みの間に別インスタンス(重複した cron 起動等)が割り込みうる。
 * WHERE status = 'pending' 付き UPDATE で claim し、meta.changes = 0(他が既に
 * claim 済み)なら副作用なしで返すことを検証する。
 */
describe("PublishDO.fetch /start: pending → creating の原子的 claim(指摘1)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetIgToken.mockResolvedValue("token");
		mockCreateContainer.mockResolvedValue("container-1");
	});

	function startRequest(jobId: string) {
		return new Request("https://do/start", {
			method: "POST",
			body: JSON.stringify({ jobId }),
		});
	}

	it("claim に成功すれば creating へ進み、コンテナ生成を実行する", async () => {
		const { DO, row } = makeHarness({ status: "pending" });

		const res = await DO.fetch(startRequest(row.id));

		expect(res.status).toBe(200);
		expect(mockCreateContainer).toHaveBeenCalledTimes(1);
		expect(row.status).toBe("processing");
	});

	it("loadJob 時点では pending でも claim 実行時に既に奪われていれば、コンテナ生成を一切行わない(同時発火の競合)", async () => {
		const { DO, row } = makeHarness(
			{ status: "pending" },
			{ claimSucceeds: false },
		);

		const res = await DO.fetch(startRequest(row.id));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "already-claimed" });
		// 副作用なし: token 取得もコンテナ生成もしない。
		expect(mockGetIgToken).not.toHaveBeenCalled();
		expect(mockCreateContainer).not.toHaveBeenCalled();
		// claim に失敗しているので row 自体もこのインスタンス側からは変更されない
		// (勝った側の別インスタンスが進める前提で、こちらは何もしない)。
		expect(row.status).toBe("pending");
	});
});

/**
 * handleFailure の指数バックオフ(指摘2)の回帰テスト。旧: 線形 15秒×n backoff
 * (5 attempts で合計 150 秒 ≈ 2.5分)は短時間の IG/ネットワーク障害でも
 * 即座に恒久失敗させてしまっていた。新スケジュールは 30秒 → 1分 → 2分 → 5分 →
 * 10分 → 15分(以降15分固定)で、maxAttempts の既定値8と組み合わせて
 * 合計約48.5分粘ってから failed 確定する。
 */
describe("backoffDelayMs: 指数バックオフのスケジュール", () => {
	it("attempts 1〜6 は 30秒, 1分, 2分, 5分, 10分, 15分の順に伸びる", () => {
		expect(backoffDelayMs(1)).toBe(30_000);
		expect(backoffDelayMs(2)).toBe(60_000);
		expect(backoffDelayMs(3)).toBe(120_000);
		expect(backoffDelayMs(4)).toBe(300_000);
		expect(backoffDelayMs(5)).toBe(600_000);
		expect(backoffDelayMs(6)).toBe(900_000);
	});

	it("attempts が配列長を超えても 15分で頭打ちになる(無制限には伸びない)", () => {
		expect(backoffDelayMs(7)).toBe(900_000);
		expect(backoffDelayMs(20)).toBe(900_000);
	});
});

describe("PublishDO.handleFailure: 指数バックオフの適用と恒久失敗の即時 fail", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetIgToken.mockResolvedValue("token");
	});

	it("transient 失敗(creating)の再試行は backoffDelayMs のとおりに alarm を張る", async () => {
		mockCreateContainer.mockRejectedValueOnce(new InstagramError("transient"));
		const { DO, row, store } = makeHarness({ status: "creating", attempts: 2 });
		const before = Date.now();

		await DO.alarm();

		expect(row.status).toBe("creating");
		expect(row.attempts).toBe(3);
		const alarmAt = store.get("__alarm") as number;
		// attempts=3 回目の失敗 → backoffDelayMs(3) = 120秒後に再試行。
		expect(alarmAt - before).toBeGreaterThanOrEqual(120_000);
		expect(alarmAt - before).toBeLessThan(120_000 + 5_000); // テスト実行の揺れを許容
	});

	it("恒久失敗(container status ERROR)は backoff を経由せず即座に failed 確定する", async () => {
		mockGetContainerStatus.mockResolvedValue("ERROR");
		const { DO, row, store } = makeHarness({
			status: "processing",
			ig_container_id: "container-1",
			attempts: 0,
		});
		store.set("pollDeadline", Date.now() + 60_000);

		await DO.alarm();

		expect(row.status).toBe("failed");
		// decideNext の ERROR 分岐は markFailed に直行するため、handleFailure による
		// attempts++ は起きない(恒久失敗は再試行しない)。
		expect(row.attempts).toBe(0);
		expect(store.get("__alarm")).toBeUndefined();
		expect(store.get("pollDeadline")).toBeUndefined();
	});

	it("恒久失敗(container status EXPIRED)も同様に即座に failed 確定する", async () => {
		mockGetContainerStatus.mockResolvedValue("EXPIRED");
		const { DO, row, store } = makeHarness({
			status: "processing",
			ig_container_id: "container-1",
			attempts: 0,
		});
		store.set("pollDeadline", Date.now() + 60_000);

		await DO.alarm();

		expect(row.status).toBe("failed");
		expect(row.attempts).toBe(0);
		expect(store.get("__alarm")).toBeUndefined();
	});

	it("MAX_ATTEMPTS が未設定/不正値なら既定の8で失敗確定する(maxAttempts() の fallback)", async () => {
		mockCreateContainer.mockRejectedValueOnce(new InstagramError("transient"));
		const { DO, row } = makeHarness(
			{ status: "creating", attempts: 7 },
			{ maxAttempts: "not-a-number" },
		);

		await DO.alarm();

		// fallback の 8 に達するので failed 確定(5 のままなら既に上限超過で挙動が
		// 変わらないため、7→8 で初めて閾値を跨ぐこの attempts 値が fallback 値の
		// 検証になる)。
		expect(row.status).toBe("failed");
		expect(row.attempts).toBe(8);
	});
});

describe("PublishDO.alarm: ポーリング上限(S-3)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetIgToken.mockResolvedValue("token");
		mockGetContainerStatus.mockResolvedValue("IN_PROGRESS");
	});

	it("打ち切り時刻を過ぎた IN_PROGRESS は polling timeout で failed", async () => {
		const { DO, row, store } = makeHarness({
			status: "processing",
			ig_container_id: "container-1",
		});
		store.set("pollDeadline", Date.now() - 1000); // 既に過去

		await DO.alarm();

		expect(row.status).toBe("failed");
	});

	it("打ち切り時刻内の IN_PROGRESS は processing のまま reArm する", async () => {
		const { DO, row, store } = makeHarness({
			status: "processing",
			ig_container_id: "container-1",
			updated_at: 1000,
		});
		store.set("pollDeadline", Date.now() + 60_000); // 十分先

		await DO.alarm();

		expect(row.status).toBe("processing");
		expect(store.get("__alarm")).toBeDefined();
		// 指摘1対応: reArm でも updated_at を更新し、健全なジョブが
		// sweepStaleJobs の stale 候補に誤って乗らないようにする。
		expect(row.updated_at).toBeGreaterThan(1000);
	});
});

/**
 * PublishDO.fetch("/resume") の回帰テスト(アーキテクチャレビュー指摘1: 非例外系
 * クラッシュによる孤立ジョブの掃きスイープ)。cron.ts の sweepStaleJobs が
 * 「D1 は非終端状態のまま updated_at が長時間更新されていない」候補を送り込む先。
 * 二重起動安全性の要点は「alarm の有無」で判定すること: alarm が生きていれば
 * 何もせず、alarm が消えている(=本当に孤立している)ときだけ alarm() 相当の
 * 継続処理を実行する。
 */
describe("PublishDO.fetch /resume: stale スイープからの再開", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetIgToken.mockResolvedValue("token");
		mockCreateContainer.mockResolvedValue("container-1");
		mockGetContainerStatus.mockResolvedValue("FINISHED");
		mockPublishContainer.mockResolvedValue("media-1");
	});

	function resumeRequest(jobId: string) {
		return new Request("https://do/resume", {
			method: "POST",
			body: JSON.stringify({ jobId }),
		});
	}

	it("alarm が既に張られていれば何もしない(二重起動防止)", async () => {
		const { DO, row, store } = makeHarness({
			status: "processing",
			ig_container_id: "container-1",
		});
		store.set("__alarm", Date.now() + 60_000); // 正常進行中を模す

		const res = await DO.fetch(resumeRequest(row.id));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ resumed: false });
		expect(mockGetContainerStatus).not.toHaveBeenCalled();
		expect(row.status).toBe("processing");
	});

	it("alarm が無ければ即時 alarm を予約する(this.alarm() を直接呼ばない)", async () => {
		const { DO, row, store } = makeHarness({ status: "creating", attempts: 1 });
		// alarm 未設定(store に __alarm キーが無い)= 孤立状態を模す。

		const res = await DO.fetch(resumeRequest(row.id));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ resumed: true });
		// setAlarm(now) で予約するだけで、この時点では継続処理(createContainer 等)は
		// まだ実行しない。直接 alarm() を呼ぶと、自然発火した alarm() と並行実行
		// しうる(alarm は発火時点で消費され getAlarm() が null になるため)ので、
		// 通常の alarm ディスパッチ(=同時に1つしか実行しない保証)に委ねる。
		expect(mockCreateContainer).not.toHaveBeenCalled();
		expect(row.status).toBe("creating");
		expect(store.get("__alarm")).toBeDefined();
	});

	it("予約された alarm が実際に発火すると、通常どおり継続処理が進む", async () => {
		const { DO, row, store } = makeHarness({ status: "creating", attempts: 1 });

		await DO.fetch(resumeRequest(row.id));
		// cron から見えない、プラットフォームの alarm ディスパッチをここで模す。
		await DO.alarm();

		expect(mockCreateContainer).toHaveBeenCalledTimes(1);
		expect(row.status).toBe("processing");
		expect(store.get("pollDeadline")).toBeDefined();
	});

	it("JOB_ID_KEY が storage に無くても body の jobId で自己回復する", async () => {
		const { DO, row, store } = makeHarness({ status: "creating", attempts: 1 });
		store.delete("jobId"); // JOB_ID_KEY 未設定(極端なケース)を模す。

		await DO.fetch(resumeRequest(row.id));
		await DO.alarm();

		expect(mockCreateContainer).toHaveBeenCalledTimes(1);
		expect(row.status).toBe("processing");
	});

	it("jobId が無い / 型不正なリクエストは 400", async () => {
		const { DO } = makeHarness({ status: "processing" });

		const res = await DO.fetch(
			new Request("https://do/resume", { method: "POST", body: "{}" }),
		);

		expect(res.status).toBe(400);
	});
});
