import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip } from "../../types";
import { renderWithProviders } from "../../test/render";
import { DEFAULT_MEDIA_INFO } from "../../test/tauri-mock";
// public ビルドが実際に使うモジュール(entry.public.ts)を直接 import する
// (§ReframeScreen.public.test.tsx 冒頭コメント参照)。publish 系(usePublishExtras)を
// 経由しないため、下の mock が対象とする `usePreview()` 呼び出しは ReframeScreen.tsx の
// 1 箇所だけになり、レースの分離がしやすい。
import { UploadScreen } from "./entry.public";

/**
 * `usePreview.ensure()` の呼び出しを完全に制御するための mock。
 * 実際の cancel-and-restart(進行中の ensure() が新しい呼び出しに置き換えられ、
 * PreviewSupersededError で reject される、§usePreview.ts)を、ボタンの
 * disabled 状態(rendering 中は再クリックできない、§OutputCard.tsx)に妨げられず
 * 決定論的に再現するため、`states` は常に空の Map を返す(rendering フラグを
 * 立てない)フェイク実装にする。`PreviewSupersededError` 自体は `importOriginal`
 * 経由で実物をそのまま使う(ReframeScreen.tsx 側の `instanceof` 判定と
 * 同一クラスである必要があるため)。
 */
const { pendingByKey, lastKeyRef } = vi.hoisted(() => ({
	pendingByKey: new Map<
		string,
		{ resolve: (path: string) => void; reject: (err: unknown) => void }
	>(),
	lastKeyRef: { current: undefined as string | undefined },
}));

vi.mock("../../lib/usePreview", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/usePreview")>();
	return {
		...actual,
		usePreview: () => ({
			states: new Map(),
			ensure: (key: string) => {
				lastKeyRef.current = key;
				return new Promise<string>((resolve, reject) => {
					// 同一 key への先行 ensure() が残っていれば、実物の usePreview.ts と同じく
					// PreviewSupersededError で明示的に reject して置き換える(cancel-and-restart)。
					const prior = pendingByKey.get(key);
					if (prior) prior.reject(new actual.PreviewSupersededError());
					pendingByKey.set(key, { resolve, reject });
				});
			},
			trigger: () => {},
			cancel: () => {},
			remove: () => {},
			reset: () => {},
		}),
	};
});

const SOURCE = { inputPath: "/in.mp4", probe: DEFAULT_MEDIA_INFO };
const CLIP: Clip = {
	id: "clip-1",
	name: "ClipOne",
	trim: { start: 0, end: 5 },
	aspect: "free",
};

function renderScreen() {
	return renderWithProviders(
		<UploadScreen
			active
			source={SOURCE}
			clips={[CLIP]}
			resetToken={0}
			onGoToExport={() => {}}
		/>,
	);
}

/** マイクロタスクキューを確実に空にする(setTimeout 0 のマクロタスクまで進める)。 */
async function flushMicrotasks() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function settlePending(action: "resolve" | "reject", value: unknown) {
	const key = lastKeyRef.current;
	if (!key) throw new Error("ensure() がまだ呼ばれていません(テスト側の準備ミス)");
	const entry = pendingByKey.get(key);
	if (!entry) throw new Error(`pending な ensure() が見つかりません: key=${key}`);
	pendingByKey.delete(key);
	if (action === "resolve") entry.resolve(value as string);
	else entry.reject(value);
}

describe("ReframeScreen: previewErrors のバナー(cancel-and-restart の扱い)", () => {
	// テスト間で pendingByKey/lastKeyRef(module 上位の hoisted state)が残らないようにする。
	// 前のテストがアサーション失敗で早期終了した場合でも、後続テストへ pending が
	// 漏れ出さないための保険(各 it() は新しい output.id を持つ新規コンポーネントを
	// render するため、通常は自然にクリーンな状態で始まるが、テスト自体の堅牢性のため)。
	beforeEach(() => {
		pendingByKey.clear();
		lastKeyRef.current = undefined;
	});

	it("cancel-and-restart(PreviewSupersededError)による reject は previewErrors のエラーバナーに表示されない", async () => {
		const user = userEvent.setup();
		renderScreen();
		await waitFor(() =>
			expect(screen.getByLabelText("出力ターゲット")).toBeInTheDocument(),
		);

		// 1 回目のクリック(ensure() #1、まだ確定しない)。
		await user.click(screen.getByRole("button", { name: "プレビュー生成" }));
		await waitFor(() => expect(pendingByKey.size).toBe(1));

		// #1 がまだ pending のうちに 2 回目をクリックする(cancel-and-restart の再現)。
		// mock 側の states は常に空のため rendering:true にならず、ボタンは disabled に
		// ならない(§冒頭コメント)。
		await user.click(screen.getByRole("button", { name: "プレビュー生成" }));

		// この時点で #1 は PreviewSupersededError で reject 済み(mock の ensure() 実装)。
		// previewOutput 側の catch がそれを処理し終えるまでマイクロタスクを空にする。
		await flushMicrotasks();

		// 「置き換えられただけ」であり失敗ではないため、previewErrors のエラー表示は
		// 一切現れない(#2 がまだ pending でも、#1 の reject 単体で表示されないことの確認)。
		expect(screen.queryByText(/エラー:/)).not.toBeInTheDocument();

		// #2(現在進行中の呼び出し)を成功で確定させても、引き続きエラー表示は現れない。
		act(() => {
			settlePending("resolve", "/cache/fresh.mp4");
		});
		await flushMicrotasks();
		expect(screen.queryByText(/エラー:/)).not.toBeInTheDocument();
	});

	it("previewErrors の既存のエラー表示は、後続の ensure() が成功すると消える(P2: 再試行成功後も赤いバナーが残り続ける問題の修正)", async () => {
		const user = userEvent.setup();
		renderScreen();
		await waitFor(() =>
			expect(screen.getByLabelText("出力ターゲット")).toBeInTheDocument(),
		);

		// 1 回目: 本物のエラーで失敗させ、previewErrors のバナーが表示されることを確認する
		// (この後の「消える」確認の前提)。
		await user.click(screen.getByRole("button", { name: "プレビュー生成" }));
		await waitFor(() => expect(pendingByKey.size).toBe(1));
		act(() => {
			settlePending("reject", new Error("レンダリングに失敗しました(テスト用)"));
		});
		await waitFor(() =>
			expect(
				screen.getByText("エラー: レンダリングに失敗しました(テスト用)"),
			).toBeInTheDocument(),
		);

		// 2 回目: 撮り直して成功させる。previewOutput は成功時に、その output.id の
		// previewErrors エントリを明示的に削除する(§ReframeScreen.tsx previewOutput の
		// `.then()` 節)。
		await user.click(screen.getByRole("button", { name: "プレビュー生成" }));
		await waitFor(() => expect(pendingByKey.size).toBe(1));
		act(() => {
			settlePending("resolve", "/cache/retry-success.mp4");
		});

		await waitFor(() => expect(screen.queryByText(/エラー:/)).not.toBeInTheDocument());
	});
});
