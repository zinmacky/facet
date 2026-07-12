/**
 * `reframe_start`/`preview_start` の jobId 採番(`lib/tauri.ts` の `startReframe`/
 * `startPreview` が使う)。`crypto.randomUUID()` を薄くラップしているだけだが、専用の
 * モジュールへ切り出すことで、テスト側が `vi.mock("./jobId", …)` でジョブ ID の採番
 * だけを決定的な値(`job-1`, `job-2`, …)に差し替えられるようにする。
 *
 * `App.tsx`/`features/upload/uploadTypes.ts` 等が clip/post/output の id 生成に使う
 * `crypto.randomUUID()` は本モジュールを経由しないため、ジョブ ID の採番をモックしても
 * それらの id 生成には影響しない(採番元を分離していないと、テストで
 * `crypto.randomUUID` をグローバルに差し替えた際に clip/post/output の id が
 * `job-N` になってしまい、ジョブ ID の連番と衝突する)。
 */
export function newJobId(): string {
	return crypto.randomUUID();
}
