import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobCreateResponse, jobStatus } from "@facet/contract";
import type { IgPublishDone } from "../features/upload/igPublish";
import { mockOn } from "../mock/eventBus";
import { startMockJob } from "../mock/jobRunner";
import { MOCK_IG_PUBLISH_DONE } from "./tauri-mock";

/**
 * `@facet/contract` の zod スキーマ(SSOT)と、desktop の TS 側モック実装
 * (`test/tauri-mock.ts` 経由でテストが emit する `ig_publish://done/<jobId>` ペイロード、
 * `mock/jobRunner.ts` が dev:mock 用に実際に emit するペイロード)が契約から乖離して
 * いないかを検証する(GHSA-6w5m-8gcr-rf63 / Issue #93 の短期対応、実装内容2)。
 *
 * カバー範囲:
 * - `IgPublishDone`(`features/upload/igPublish.ts`)は Rust 側 `commands/publish/ig.rs`
 *   の `run_ig_publish` が `JobCreateResponse { id, status }` を
 *   `IgPublishDone { schedulerJobId: id, status }` へリネームして emit したもの。
 *   契約(`packages/contract`)に `IgPublishDone` 自体の zod スキーマは無い(イベント
 *   ペイロードは POST /jobs の HTTP レスポンスそのものではなく Tauri イベント形状の
 *   ため)ので、`schedulerJobId → id` に読み替えた上で `jobCreateResponse` と照合する。
 * - `test/tauri-mock.ts` の `MOCK_IG_PUBLISH_DONE`(`UploadScreen.igPublish.test.tsx` が
 *   実際に emit する値そのもの)を import して検証するため、UploadScreen 側のテストが
 *   その値を変えれば本テストも連動する(手打ちの重複を避ける)。
 * - `mock/jobRunner.ts`(dev:mock が実際に emit する done ペイロード)は fake timer で
 *   実行して捕捉した実データを検証する(同じく手打ちの重複ではなく実際の実行結果)。
 * - `status` が契約の `jobStatus` enum の値であることを網羅的に検証する。
 *
 * カバーしない範囲(短期対応のスコープ外、報告に明記):
 * - `IgPublishProgress`/`IgPublishRuntimeError`(契約に対応する zod スキーマが無い、
 *   Rust→renderer 専用の内部イベント形状のため検証できない)。
 * - `jobManifest`(POST /jobs のリクエストボディ)側の TS 実装は desktop に存在しない
 *   (Rust 側 `jobs/manifest.rs` が直接組み立てる)ため対象外。Rust 側の契約整合性は
 *   `apps/desktop/src-tauri/src/jobs/manifest.rs` のテストでカバー済み。
 * - typify による contract-rs のコード生成配線自体はスコープ外(Issue #93 記載の通り)。
 */

/** `IgPublishDone` を `jobCreateResponse` の形(`id`/`status`)へ読み替える。 */
function toJobCreateResponseShape(done: IgPublishDone): unknown {
	return { id: done.schedulerJobId, status: done.status };
}

describe("contract boundary: ig_publish done payload", () => {
	it("tauri-mock.ts の MOCK_IG_PUBLISH_DONE(UploadScreen テストが実際に emit する値)は jobCreateResponse 契約に適合する", () => {
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

describe("contract boundary: mock/jobRunner.ts(dev:mock)の実際の emit", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("ig_publish ジョブが完了時に emit する done ペイロードは jobCreateResponse 契約に適合する", () => {
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
		expect(() =>
			jobCreateResponse.parse(toJobCreateResponseShape(done)),
		).not.toThrow();
	});
});
