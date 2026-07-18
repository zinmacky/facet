import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	editSpec,
	igPublishDone,
	igPublishProgress,
	igPublishRuntimeError,
	jobCreateResponse,
	jobStatus,
} from "@facet/contract";
import type { IgPublishDone } from "../features/upload/igPublish";
import { useReframeQueue } from "../lib/useReframeQueue";
import { usePreview } from "../lib/usePreview";
import { mockOn } from "../mock/eventBus";
import { startMockJob } from "../mock/jobRunner";
import {
	finalSpec,
	masterSpec,
	targetById,
	type Clip,
	type OutputTarget,
} from "../types";
import {
	MOCK_IG_PUBLISH_DONE,
	MOCK_IG_PUBLISH_ERROR,
	MOCK_IG_PUBLISH_PROGRESS,
	mockInvoke,
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
 *
 * 加えて、`EditSpec`(`reframe_start`/`preview_start` が受け取る `spec` 引数、
 * TS↔Rust 境界の中核型)の契約テストもここに追加する(アーキテクチャレビュー指摘対応)。
 * `masterSpec`/`finalSpec`(`../types.ts`)は実際に `spec` を組み立てる本番コードそのもの、
 * `useReframeQueue`/`usePreview` は `reframe_start`/`preview_start` を叩く本番フックその
 * ものなので、いずれも手打ちの重複フィクスチャではなく実際の実行結果を検証する
 * (`mockInvoke.mock.calls` から invoke に渡った実引数を取り出す)。Rust 側の契約整合性は
 * `apps/desktop/src-tauri/src/commands/edit_spec_contract.rs` でカバーする。
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

// ---- contract boundary: EditSpec(reframe_start/preview_start の spec 引数) -------------
//
// アーキテクチャレビュー指摘対応: EditSpec は手動同期のみで契約テストが無かった
// (`packages/core/src/types.ts` が TS 側の真実の源、`crates/media-core/src/spec.rs` が
// Rust 側の手書き型)。`masterSpec`/`finalSpec`(`../types.ts`)は spec を実際に組み立てる
// 本番コードそのもの、`useReframeQueue`/`usePreview` は `reframe_start`/`preview_start`
// を実際に叩く本番フックそのものを exercise し、`mockInvoke` に渡った実引数を
// `@facet/contract` の `editSpec` で検証する(igPublish 系のテストと同じ「手打ちの
// フィクスチャではなく実際の実行結果を検証する」方針)。

const CONTRACT_TEST_CLIP: Clip = {
	id: "clip-1",
	name: "clip-1",
	trim: { start: 1, end: 5 },
	crop: { x: 0.1, y: 0, width: 0.8, height: 1 },
	aspect: "9:16",
};
const CONTRACT_TEST_SOURCE = { width: 1920, height: 1080 };

/** `targetById` は存在しない id には `undefined` を返す(`../types.ts`)。固定 id のためテスト側で存在を保証する。 */
function contractTestTarget(): OutputTarget {
	const target = targetById("ig-reels");
	if (!target) throw new Error("test fixture: ig-reels output target must exist");
	return target;
}

describe("contract boundary: EditSpec(masterSpec/finalSpec が組み立てる spec)", () => {
	it("masterSpec()(EXPORT 用ビルダー)が組み立てる EditSpec は契約に適合する", () => {
		const spec = masterSpec(CONTRACT_TEST_CLIP, CONTRACT_TEST_SOURCE);
		expect(() => editSpec.parse(spec)).not.toThrow();
	});

	it("finalSpec()(UPLOAD 用ビルダー)が組み立てる EditSpec は契約に適合する", () => {
		const spec = finalSpec(
			CONTRACT_TEST_CLIP,
			CONTRACT_TEST_SOURCE,
			contractTestTarget(),
			"blur-pad",
		);
		expect(() => editSpec.parse(spec)).not.toThrow();
	});

	it("crop 未指定の Clip から組み立てた EditSpec(crop キー自体が無い)も契約に適合する", () => {
		const { crop: _crop, ...clipWithoutCrop } = CONTRACT_TEST_CLIP;
		const spec = masterSpec(clipWithoutCrop, CONTRACT_TEST_SOURCE);
		expect(spec.crop).toBeUndefined();
		expect(() => editSpec.parse(spec)).not.toThrow();
	});
});

describe("contract boundary: EditSpec(reframe_start/preview_start に実際に渡る spec)", () => {
	it("useReframeQueue.run() が reframe_start へ渡す spec は契約に適合する", async () => {
		const spec = masterSpec(CONTRACT_TEST_CLIP, CONTRACT_TEST_SOURCE);
		const { result } = renderHook(() => useReframeQueue());

		act(() => {
			const token = result.current.reserve("clip-1");
			expect(token).not.toBe(false);
			void result.current.run(token as string, "clip-1", "/in.mp4", "/out.mp4", spec);
		});

		await waitFor(() => {
			expect(
				mockInvoke.mock.calls.some(([cmd]) => cmd === "reframe_start"),
			).toBe(true);
		});
		const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "reframe_start");
		const args = call?.[1] as { spec?: unknown } | undefined;
		expect(() => editSpec.parse(args?.spec)).not.toThrow();
	});

	it("usePreview.ensure() が preview_start へ渡す spec は契約に適合する", async () => {
		const spec = finalSpec(
			CONTRACT_TEST_CLIP,
			CONTRACT_TEST_SOURCE,
			contractTestTarget(),
			"crop",
		);
		const { result } = renderHook(() => usePreview());

		act(() => {
			void result.current.ensure("clip-1", "/in.mp4", spec, "sig-1");
		});

		await waitFor(() => {
			expect(
				mockInvoke.mock.calls.some(([cmd]) => cmd === "preview_start"),
			).toBe(true);
		});
		const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "preview_start");
		const args = call?.[1] as { spec?: unknown } | undefined;
		expect(() => editSpec.parse(args?.spec)).not.toThrow();
	});
});
