import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createContainer,
	getContainerStatus,
	getIgToken,
	InstagramError,
	publishContainer,
} from "./instagram.js";
import { decideNext, PublishDO } from "./publish-do.js";

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

function makeHarness(initial: Partial<FakeJob>) {
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
							applyWrite(row, sql, args);
							return { success: true };
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
		MAX_ATTEMPTS: "5",
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
		// MAX_ATTEMPTS=5。attempts=4 で失敗すると 5 に達し終端。
		const { DO, row, store } = makeHarness({ status: "creating", attempts: 4 });
		store.set("pollDeadline", Date.now() + 60_000);

		await DO.alarm();

		expect(row.status).toBe("failed");
		expect(row.attempts).toBe(5);
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
			attempts: 4, // 上限到達で failed 確定させ、終端を観測する
		});

		await DO.alarm();

		expect(row.status).toBe("failed");
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
