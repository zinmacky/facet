import type { Env } from "./env.js";
import type { ContainerStatus } from "./instagram.js";
import {
	createContainer,
	getContainerStatus,
	getIgToken,
	InstagramError,
	publishContainer,
} from "./instagram.js";

/**
 * publish が「同一 creation_id は既に公開済み」を示すエラーかを判定する。
 * creation_id は単回利用のため、publish 成功直後・D1 反映前のクラッシュで再入すると
 * この応答が返る。これを失敗ではなく成功として扱うことで誤 failed 化を防ぐ。
 *
 * best-effort な判定であることに注意:
 *  - false-negative(検知漏れ)は「実は公開済みなのに failed 化」に直結するため、
 *    IG 実応答の文言差・ローカライズに弱いメッセージ照合は本来望ましくない。
 *  - 一方 false-positive(取り違え)は「未公開なのに published」になり、こちらも危険。
 * 現状は `error.error_subcode` の確実な値が未確認のためメッセージ照合に留める。
 * 実運用ログで二重 publish 時の `subcode`(InstagramError.subcode としてログ可能)を
 * 確認でき次第、subcode ベースの厳密判定へ移行すること。
 */
function isAlreadyPublishedError(err: unknown): boolean {
	if (!(err instanceof InstagramError)) {
		return false;
	}
	const message = err.message.toLowerCase();
	return (
		message.includes("already been published") ||
		message.includes("already published")
	);
}

/** ポーリング / リトライの間隔(ms)。 */
const POLL_INTERVAL_MS = 15_000;

/**
 * コンテナ処理の完了待ちポーリングを打ち切る上限(ms)。attempts ベースの
 * maxAttempts(既定5)は「正常処理でも数分かかる」ポーリングには小さすぎるため、
 * ポーリング専用の別上限を設ける。この時間内に FINISHED/ERROR/EXPIRED のいずれにも
 * ならなければ timeout として failed 確定する(コンテナ自体は約24時間で失効するため、
 * それより十分手前で見切る)。
 */
const MAX_POLL_MS = 60 * 60 * 1000;

/** storage に保持する job id のキー。 */
const JOB_ID_KEY = "jobId";

/** storage に保持するポーリング打ち切り時刻(epoch ms)のキー。 */
const POLL_DEADLINE_KEY = "pollDeadline";

/**
 * ポーリング後の次アクションを決める純関数。ランタイム非依存でテスト可能。
 *  - IN_PROGRESS → まだ処理中、alarm を張り直す
 *  - FINISHED    → 公開へ
 *  - ERROR/EXPIRED → 恒久失敗
 * attempts が maxAttempts 以上に達している場合は(呼び出し側の例外リトライ用に)fail を返す。
 */
export function decideNext(
	statusCode: ContainerStatus,
	attempts: number,
	maxAttempts: number,
): { action: "reArm" | "publish" | "fail"; reason?: string } {
	if (attempts >= maxAttempts) {
		return { action: "fail", reason: "max attempts reached" };
	}
	switch (statusCode) {
		case "IN_PROGRESS":
			return { action: "reArm" };
		case "FINISHED":
			return { action: "publish" };
		case "ERROR":
			return { action: "fail", reason: "container status ERROR" };
		case "EXPIRED":
			return { action: "fail", reason: "container status EXPIRED" };
	}
}

/** D1 の jobs 行(DO が読むのに必要な列のみ)。 */
interface JobRow {
	id: string;
	r2_key: string;
	media_type: string;
	caption: string | null;
	status: string;
	ig_container_id: string | null;
	ig_media_id: string | null;
	attempts: number;
}

/**
 * 1ジョブ = 1インスタンスで公開ステートマシンを直列化する Durable Object。
 * D1 を唯一の真実とし、進行状態(status / attempts / container_id)は毎回そこへ書く。
 * ポーリングは alarm で刻み、Worker 1回の CPU 制限を避ける。
 */
export class PublishDO implements DurableObject {
	private readonly state: DurableObjectState;
	private readonly env: Env;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/resume") {
			return this.handleResume(req);
		}
		if (url.pathname !== "/start") {
			return new Response("not found", { status: 404 });
		}

		const { jobId } = (await req.json()) as { jobId?: string };
		if (typeof jobId !== "string") {
			return new Response("missing jobId", { status: 400 });
		}
		// alarm から参照できるよう job id を storage に退避する。
		await this.state.storage.put(JOB_ID_KEY, jobId);

		const job = await this.loadJob(jobId);
		if (job === null) {
			return new Response("job not found", { status: 404 });
		}
		// pending 以外は既に別発火が進めているので何もしない(冪等)。
		if (job.status !== "pending") {
			return new Response(JSON.stringify({ status: job.status }), {
				headers: { "content-type": "application/json" },
			});
		}

		// pending → creating を原子的に claim する。loadJob は D1 サブリクエストであり
		// DO の input gate(state.storage 操作のみ保護)の対象外のため、この読み取りと
		// 直後の書き込みの間に別インスタンス(同一ジョブに対する重複した /start 起動。
		// cron の毎分スキャンが同じ pending ジョブを跨分で拾う、コンテナ生成が長引いて
		// sweepStaleJobs 経由の /resume と競合する、等)が割り込みうる。上の status
		// チェックだけでは両者が同時に "pending" を観測して二重に createContainer を
		// 呼び、IG コンテナを孤立させる恐れがある(指摘1)。WHERE status = 'pending' 付き
		// UPDATE で claim し、meta.changes が 0 なら他方が既に claim 済みとして
		// 副作用なしで返す。
		const claimed = await this.claimPendingForCreating(jobId);
		if (!claimed) {
			return new Response(JSON.stringify({ status: "already-claimed" }), {
				headers: { "content-type": "application/json" },
			});
		}

		try {
			const token = await getIgToken(this.env);
			await this.runCreate(jobId, job, token);
			return new Response(JSON.stringify({ status: "processing" }), {
				headers: { "content-type": "application/json" },
			});
		} catch (err) {
			// createContainer 等の transient 失敗。status は creating のまま handleFailure が
			// attempts++ して alarm を張り直し、その alarm(下の creating 分岐)が生成を
			// リトライする。上限到達で failed 確定する。
			await this.handleFailure(jobId, err);
			return new Response(JSON.stringify({ status: "retry-scheduled" }), {
				status: 202,
				headers: { "content-type": "application/json" },
			});
		}
	}

	/**
	 * cron.ts の sweepStaleJobs から叩かれる。「D1 が非終端状態のまま updated_at が
	 * 長時間更新されていない」候補に対して、実際に孤立しているか(alarm 未設定か)を
	 * この DO 自身に判定させ、孤立していれば alarm 経路に載せて復帰させる。
	 *
	 * 二重起動安全性: alarm が既に張られている(=このインスタンスが生きていて
	 * 通常どおり継続中)場合は何もしない。processing の reArm(下記 alarm() 内)は
	 * ポーリングのたびに updated_at を更新するため、正常に長時間ポーリング中の
	 * ジョブが stale 候補に乗ること自体がまず起きない。それでも乗った場合に備え、
	 * alarm の有無という DO 自身の storage(durable、isolate 退避を跨いで残る)を
	 * 最終ガードにする。
	 *
	 * alarm 未設定のときの再開は `this.alarm()` を直接呼ばず `setAlarm(Date.now())`
	 * でプラットフォームの alarm ディスパッチ経路に載せる。直接呼び出しだと、
	 * ちょうど自然発火した alarm() が実行中(alarm は発火時点で消費されるため
	 * getAlarm() は既に null を返しうる)の場合に、このハンドラがもう一本
	 * alarm() 相当の処理を並行実行してしまいうる。Durable Objects は alarm() を
	 * 同時に1つしか実行しない保証を alarm ディスパッチ機構が担うため、
	 * setAlarm 経由にすることでその保証に乗り、二重実行を避ける。
	 */
	private async handleResume(req: Request): Promise<Response> {
		const { jobId } = (await req.json()) as { jobId?: string };
		if (typeof jobId !== "string") {
			return new Response("missing jobId", { status: 400 });
		}
		// JOB_ID_KEY が何らかの理由で未設定(/start が保存前に中断した等の極端なケース)
		// でも自己回復できるよう、渡された jobId で補完しておく。
		await this.state.storage.put(JOB_ID_KEY, jobId);

		const existingAlarm = await this.state.storage.getAlarm();
		if (existingAlarm !== null) {
			// 正常進行中。二重起動を避けてここでは何もしない。
			return new Response(JSON.stringify({ resumed: false }), {
				headers: { "content-type": "application/json" },
			});
		}

		// alarm 未設定 = 本当に孤立している可能性が高い。即時発火の alarm を
		// 予約し、実際の復帰処理は通常の alarm() ディスパッチに委ねる。
		await this.state.storage.setAlarm(Date.now());
		return new Response(JSON.stringify({ resumed: true }), {
			headers: { "content-type": "application/json" },
		});
	}

	/**
	 * コンテナ生成フェーズ(creating → processing)。fetch の初回起動と、生成が
	 * transient 失敗したあとの alarm リトライの双方から呼ばれる共通実体。
	 * 成功時に container_id を保存し、ポーリング打ち切り時刻を storage に記録して
	 * ポーリング alarm を開始する。
	 */
	private async runCreate(
		jobId: string,
		job: JobRow,
		token: string,
	): Promise<void> {
		const videoUrl = `${this.env.R2_PUBLIC_BASE}/${job.r2_key}`;
		const containerId = await createContainer(this.env, token, {
			videoUrl,
			caption: job.caption ?? "",
			mediaType: job.media_type as "VIDEO" | "REELS",
		});
		// creating → processing。container_id を保存しポーリングを開始。
		await this.env.DB.prepare(
			"UPDATE jobs SET status = 'processing', ig_container_id = ?, updated_at = ? WHERE id = ?",
		)
			.bind(containerId, Date.now(), jobId)
			.run();
		// ポーリングの打ち切り時刻を記録する(S-3: 正常化しないコンテナを無制限に
		// 叩き続けないための上限)。
		await this.state.storage.put(POLL_DEADLINE_KEY, Date.now() + MAX_POLL_MS);
		await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
	}

	async alarm(): Promise<void> {
		const jobId = await this.state.storage.get<string>(JOB_ID_KEY);
		if (jobId === undefined) {
			return;
		}
		const job = await this.loadJob(jobId);
		if (job === null) {
			return;
		}
		// 既に終端 or 別経路で進行済みなら止める。creating も含めるのが要点:
		// コンテナ生成が transient 失敗したジョブは status=creating のまま alarm が
		// 張られており、ここで拾ってリトライしないと published にも failed にも
		// ならず永久スタックする(旧実装のバグ)。
		if (
			job.status !== "creating" &&
			job.status !== "processing" &&
			job.status !== "publishing"
		) {
			return;
		}

		try {
			const token = await getIgToken(this.env);

			// creating: コンテナ未生成。生成フェーズを(再)実行して processing へ進める。
			if (job.status === "creating") {
				await this.runCreate(jobId, job, token);
				return;
			}

			// publishing で再入した場合(公開途中で alarm が刻まれた等)はコンテナ状態確認をスキップし公開へ。
			if (job.status !== "publishing") {
				if (job.ig_container_id === null) {
					throw new Error("processing job has no container id");
				}
				const statusCode = await getContainerStatus(
					this.env,
					token,
					job.ig_container_id,
				);
				const next = decideNext(statusCode, job.attempts, this.maxAttempts());
				if (next.action === "reArm") {
					// ポーリング打ち切り時刻を超えていれば timeout として失敗確定する
					// (S-3: reArm は attempts を増やさないため、別途上限を課す)。
					if (await this.pollDeadlinePassed()) {
						await this.markFailed(jobId, "polling timeout");
						return;
					}
					// updated_at を更新しておく(指摘1対応)。ここを更新しないと、
					// 正常にポーリングを継続しているだけのジョブが sweepStaleJobs の
					// stale 候補(updated_at 長時間無更新)に誤って乗り続けてしまう。
					await this.touchUpdatedAt(jobId);
					await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
					return;
				}
				if (next.action === "fail") {
					await this.markFailed(jobId, next.reason ?? "container failed");
					return;
				}
				// action === "publish": processing → publishing。
				await this.updateStatus(jobId, "publishing");
			}

			// 既に media_id が確定済みなら公開は成功済み。二重 publish を避けて終端する
			// (S-2: publishing で再入しても同一 creation_id を再送しない)。
			if (job.ig_media_id !== null) {
				await this.markPublished(jobId, job.ig_media_id);
				return;
			}

			// 公開実行。成功で published + media_id 保存。
			const containerId = job.ig_container_id;
			if (containerId === null) {
				throw new Error("publishing job has no container id");
			}
			try {
				const mediaId = await publishContainer(this.env, token, containerId);
				await this.markPublished(jobId, mediaId);
			} catch (err) {
				// creation_id は単回利用。publish 成功直後・D1 反映前のクラッシュで再入すると
				// IG は「既に公開済み」を返す。これを失敗にすると成功済みジョブを誤って
				// failed 化してしまうため、published として扱う(media_id は不明なので null)。
				// IG の重複時応答仕様に依存する best-effort(§PR 説明)。
				if (isAlreadyPublishedError(err)) {
					await this.markPublished(jobId, null);
					return;
				}
				throw err;
			}
		} catch (err) {
			await this.handleFailure(jobId, err);
		}
	}

	/** ポーリング打ち切り時刻を過ぎているか。未記録なら今から上限を張り直す(false)。 */
	private async pollDeadlinePassed(): Promise<boolean> {
		const deadline = await this.state.storage.get<number>(POLL_DEADLINE_KEY);
		if (deadline === undefined) {
			// 旧経路で processing に入った等で未記録の場合、ここで上限を張って以後を bound する。
			await this.state.storage.put(POLL_DEADLINE_KEY, Date.now() + MAX_POLL_MS);
			return false;
		}
		return Date.now() > deadline;
	}

	/** published で終端する(media_id 不明時は null)。alarm と poll deadline を掃除する。 */
	private async markPublished(
		jobId: string,
		mediaId: string | null,
	): Promise<void> {
		await this.env.DB.prepare(
			"UPDATE jobs SET status = 'published', ig_media_id = ?, last_error = NULL, updated_at = ? WHERE id = ?",
		)
			.bind(mediaId, Date.now(), jobId)
			.run();
		await this.state.storage.deleteAlarm();
		await this.state.storage.delete(POLL_DEADLINE_KEY);
	}

	private maxAttempts(): number {
		const n = Number.parseInt(this.env.MAX_ATTEMPTS, 10);
		return Number.isFinite(n) && n > 0 ? n : 5;
	}

	private async loadJob(jobId: string): Promise<JobRow | null> {
		const row = await this.env.DB.prepare(
			"SELECT id, r2_key, media_type, caption, status, ig_container_id, ig_media_id, attempts FROM jobs WHERE id = ?",
		)
			.bind(jobId)
			.first<JobRow>();
		return row ?? null;
	}

	private async updateStatus(jobId: string, status: string): Promise<void> {
		await this.env.DB.prepare(
			"UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
		)
			.bind(status, Date.now(), jobId)
			.run();
	}

	/**
	 * pending → creating の claim を `WHERE status = 'pending'` 付き UPDATE で原子的に
	 * 行う(指摘1)。D1 はこの1文を単一トランザクションとして実行するため、
	 * read-then-write(loadJob → updateStatus)と違い他インスタンスの割り込み余地が無い。
	 * `meta.changes` が 0 ならこの UPDATE は何行にもマッチしなかった、つまり呼び出し時点で
	 * 既に他インスタンスが claim 済み(status が pending でなくなっていた)ということなので
	 * false を返し、呼び出し側は副作用(コンテナ生成)を一切行わずに終える。
	 */
	private async claimPendingForCreating(jobId: string): Promise<boolean> {
		const result = await this.env.DB.prepare(
			"UPDATE jobs SET status = 'creating', updated_at = ? WHERE id = ? AND status = 'pending'",
		)
			.bind(Date.now(), jobId)
			.run();
		return result.meta.changes > 0;
	}

	/** status は変えず updated_at だけ進める(reArm で「生存」を D1 に反映するため)。 */
	private async touchUpdatedAt(jobId: string): Promise<void> {
		await this.env.DB.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?")
			.bind(Date.now(), jobId)
			.run();
	}

	private async markFailed(jobId: string, reason: string): Promise<void> {
		await this.env.DB.prepare(
			"UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
		)
			.bind(reason, Date.now(), jobId)
			.run();
		await this.state.storage.deleteAlarm();
		await this.state.storage.delete(POLL_DEADLINE_KEY);
	}

	/**
	 * 例外時の共通処理。attempts++ し、上限未満なら alarm を張り直して再試行、
	 * 上限に達したら failed で確定する。
	 */
	private async handleFailure(jobId: string, err: unknown): Promise<void> {
		const message = err instanceof Error ? err.message : String(err);
		const job = await this.loadJob(jobId);
		const attempts = (job?.attempts ?? 0) + 1;
		const now = Date.now();

		if (attempts >= this.maxAttempts()) {
			await this.env.DB.prepare(
				"UPDATE jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
			)
				.bind(attempts, message, now, jobId)
				.run();
			await this.state.storage.deleteAlarm();
			await this.state.storage.delete(POLL_DEADLINE_KEY);
			return;
		}

		await this.env.DB.prepare(
			"UPDATE jobs SET attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
		)
			.bind(attempts, message, now, jobId)
			.run();
		// 線形バックオフ(attempts に比例)で再 alarm。
		await this.state.storage.setAlarm(now + POLL_INTERVAL_MS * attempts);
	}
}
