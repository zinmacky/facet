import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	igPublishDone,
	igPublishProgress,
	igPublishRuntimeError,
	jobCreateResponse,
	jobStatus,
} from "@facet/contract";
import type { IgPublishDone } from "../features/upload/igPublish";
import { mockOn } from "../mock/eventBus";
import { startMockJob } from "../mock/jobRunner";
import {
	MOCK_IG_PUBLISH_DONE,
	MOCK_IG_PUBLISH_ERROR,
	MOCK_IG_PUBLISH_PROGRESS,
} from "./tauri-mock";

/**
 * `@facet/contract` の zod スキーマ(SSOT)と、desktop の TS 側モック実装
 * (`test/tauri-mock.ts` 経由でテストが emit する `ig_publish://{progress,done,error}/<jobId>`
 * ペイロード、`mock/jobRunner.ts` が dev:mock 用に実際に emit するペイロード)が契約から
 * 乖離していないかを検証する(GHSA-6w5m-8gcr-rf63 / Issue #93)。
 *
 * カバー範囲:
 * - `IgPublishDone`(`features/upload/igPublish.ts`)は Rust 側 `commands/publish/ig.rs`
 *   の `run_ig_publish` が `JobCreateResponse { id, status }` を
 *   `IgPublishDone { schedulerJobId: id, status }` へリネームして emit したもの。
 *   `jobCreateResponse`(POST /jobs の HTTP レスポンス契約)とは別物のため、
 *   `schedulerJobId → id` に読み替えた上で `jobCreateResponse` とも突き合わせる
 *   (旧・短期対応から継続)一方、`@facet/contract` に追加した `igPublishDone` 自体の
 *   スキーマでも直接検証する(パート B-1)。
 * - `IgPublishProgress`/`IgPublishRuntimeError` は `@facet/contract` に追加した
 *   `igPublishProgress`/`igPublishRuntimeError`(discriminated union)で検証する
 *   (パート B-1・B-4。旧・短期対応ではここに対応する zod スキーマが無く対象外だった)。
 * - `test/tauri-mock.ts` の `MOCK_IG_PUBLISH_*`(`UploadScreen.igPublish.test.tsx` が
 *   実際に emit する値そのもの)を import して検証するため、UploadScreen 側のテストが
 *   その値を変えれば本テストも連動する(手打ちの重複を避ける)。
 * - `mock/jobRunner.ts`(dev:mock が実際に emit するペイロード)は fake timer で実行して
 *   捕捉した実データを検証する(同じく手打ちの重複ではなく実際の実行結果)。
 * - `status` が契約の `jobStatus` enum の値であることを網羅的に検証する
 *   (`igPublishDone.status` 自体は `jobStatus` より緩い `z.string()` — 理由は
 *   `packages/contract/src/ig-publish-events.ts` 冒頭コメント参照 — なので、この
 *   網羅チェックは `jobCreateResponse` 側の厳密な契約に対して行う)。
 *
 * カバーしない範囲:
 * - `jobManifest`(POST /jobs のリクエストボディ)側の TS 実装は desktop に存在しない
 *   (Rust 側 `jobs/manifest.rs` が直接組み立てる)ため対象外。Rust 側の契約整合性は
 *   `apps/desktop/src-tauri/src/jobs/manifest.rs` のテストでカバー済み。
 * - typify による contract-rs のコード生成配線自体(パート A)はこのファイルの対象外
 *   (Rust 側テストでカバー)。
 */

/** `IgPublishDone` を `jobCreateResponse` の形(`id`/`status`)へ読み替える。 */
function toJobCreateResponseShape(done: IgPublishDone): unknown {
	return { id: done.schedulerJobId, status: done.status };
}

describe("contract boundary: ig_publish done payload", () => {
	it("tauri-mock.ts の MOCK_IG_PUBLISH_DONE(UploadScreen テストが実際に emit する値)は igPublishDone/jobCreateResponse 契約に適合する", () => {
		expect(() => igPublishDone.parse(MOCK_IG_PUBLISH_DONE)).not.toThrow();
		expect(() =>
			jobCreateResponse.parse(toJobCreateResponseShape(MOCK_IG_PUBLISH_DONE)),
		).not.toThrow();
	});

	it("jobStatus の全パターンで IgPublishDone.status が契約に適合する", () => {
		for (const status of jobStatus.options) {
			const done: IgPublishDone = { schedulerJobId: "job-x", status };
			expect(() =>
				jobCreateResponse.parse(toJobCreateResponseShape(done)),
			).not.toThrow();
		}
	});

	it("契約に無い status は弾かれる(検証ロジック自体の回帰確認)", () => {
		expect(() =>
			jobCreateResponse.parse({ id: "job-x", status: "not-a-real-status" }),
		).toThrow();
	});
});

describe("contract boundary: ig_publish progress payload", () => {
	it("tauri-mock.ts の MOCK_IG_PUBLISH_PROGRESS(UploadScreen テストが実際に emit する値)は igPublishProgress 契約に適合する", () => {
		expect(() => igPublishProgress.parse(MOCK_IG_PUBLISH_PROGRESS)).not.toThrow();
	});

	it("enqueuing フェーズ(追加フィールド無し)も igPublishProgress 契約に適合する", () => {
		expect(() => igPublishProgress.parse({ phase: "enqueuing" })).not.toThrow();
	});
});

describe("contract boundary: ig_publish error payload", () => {
	it("tauri-mock.ts の MOCK_IG_PUBLISH_ERROR(UploadScreen テストが実際に emit する値)は igPublishRuntimeError 契約に適合する", () => {
		expect(() => igPublishRuntimeError.parse(MOCK_IG_PUBLISH_ERROR)).not.toThrow();
	});
});

describe("contract boundary: mock/jobRunner.ts(dev:mock)の実際の emit", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("ig_publish ジョブの progress ペイロードは igPublishProgress 契約に適合する", () => {
		const jobId = "job-progress";
		let captured: unknown;
		mockOn(`ig_publish://progress/${jobId}`, (event) => {
			captured ??= event.payload;
		});

		startMockJob({ namespace: "ig_publish", jobId });
		// jobRunner.ts: 200ms 刻みの最初の tick で progress が発火する。
		vi.advanceTimersByTime(200);

		expect(captured).toBeDefined();
		expect(() => igPublishProgress.parse(captured)).not.toThrow();
	});

	it("ig_publish ジョブが完了時に emit する done ペイロードは igPublishDone/jobCreateResponse 契約に適合する", () => {
		const jobId = "job-1";
		let captured: unknown;
		mockOn(`ig_publish://done/${jobId}`, (event) => {
			captured = event.payload;
		});

		startMockJob({ namespace: "ig_publish", jobId });
		// jobRunner.ts: 200ms * 15 ステップ = 3s で done が発火する。
		vi.advanceTimersByTime(3_000);

		expect(captured).toBeDefined();
		const done = captured as IgPublishDone;
		expect(() => igPublishDone.parse(done)).not.toThrow();
		expect(() =>
			jobCreateResponse.parse(toJobCreateResponseShape(done)),
		).not.toThrow();
	});
});
