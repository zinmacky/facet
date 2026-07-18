import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { renderWithProviders } from "./test/render";
import { emitMockEvent, mockDialogOpen, mockInvoke } from "./test/tauri-mock";

function reframeStartCalls() {
	return mockInvoke.mock.calls.filter(([cmd]) => cmd === "reframe_start");
}

/** ヘッダの StepIndicator(`<nav aria-label="編集ステップ">`)へスコープした操作。 */
function stepNav() {
	return within(screen.getByRole("navigation", { name: "編集ステップ" }));
}

async function goToStep(user: ReturnType<typeof userEvent.setup>, label: string) {
	await user.click(stepNav().getByRole("button", { name: new RegExp(label) }));
}

/**
 * OutputCard に差し込まれる OutputPublishSection の「投稿設定」折りたたみ
 * (メタデータ入力欄)を開く。PostDetail に差し込まれる PostScheduleSection 側にも
 * 同名を含む別の折りたたみ(「投稿設定(予約日時・一括投稿)」)があるため、
 * "予約日時" を含まない方をこちらの対象として区別する。
 */
async function expandOutputSettings(user: ReturnType<typeof userEvent.setup>) {
	const toggle = await waitFor(() => {
		const found = screen
			.getAllByRole("button")
			.find(
				(el) =>
					/投稿設定/.test(el.textContent ?? "") && !/予約日時/.test(el.textContent ?? ""),
			);
		if (!found) throw new Error("output settings disclosure toggle not found");
		return found;
	});
	await user.click(toggle);
}

/**
 * PostDetail に差し込まれる PostScheduleSection 側の「投稿設定(予約日時・一括投稿)」
 * 折りたたみを開く。「この投稿をすべて投稿」ボタン(publishPostMutation 経由。
 * OutputPublishSection 単体の「投稿」ボタンと異なり isPending = busy に反映される)を
 * 露出させるために使う。
 */
async function expandPostScheduleSettings(user: ReturnType<typeof userEvent.setup>) {
	const toggle = await waitFor(() => {
		const found = screen
			.getAllByRole("button")
			.find(
				(el) => /投稿設定/.test(el.textContent ?? "") && /予約日時/.test(el.textContent ?? ""),
			);
		if (!found) throw new Error("post schedule disclosure toggle not found");
		return found;
	});
	await user.click(toggle);
}

/** 「元動画を選択」→ probe 成功 → 1本目の clip 自動作成、までを行う。 */
async function pickSource(user: ReturnType<typeof userEvent.setup>, path: string) {
	mockDialogOpen.mockResolvedValueOnce(path);
	await user.click(screen.getByRole("button", { name: "元動画を選択" }));
	await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("probe", { path }));
}

/**
 * ウィザードの状態保持(PR #33 のリグレッション固定)。
 * 3画面(edit/export/upload)は常時マウントされたまま CSS スライドで切り替わるため、
 * 画面往復では ExportScreen の results / UploadScreen の posts・入力値は消えない。
 * 新しい元動画を選択したとき(resetToken 増分)だけ明示的に破棄される。
 */
describe("App: ウィザードの状態保持", () => {
	it("export の結果・upload の入力値は画面往復で保持され、新しい元動画選択でのみ破棄される", async () => {
		const user = userEvent.setup();
		renderWithProviders(<App />);

		await pickSource(user, "/video1.mp4");

		// edit → export(1 clip があるので前進できる)。
		await user.click(screen.getByRole("button", { name: /確認へ進む/ }));
		expect(stepNav().getByRole("button", { name: /確認/ })).toHaveAttribute(
			"aria-current",
			"step",
		);

		// 書き出しを開始し、1 clip 分のジョブを完了させる。
		mockDialogOpen.mockResolvedValueOnce("/out");
		await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));
		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		await waitFor(() => expect(screen.getByText("完了")).toBeInTheDocument());

		// export → upload。既定 Post(1 出力: yt-shorts/crop)が自動生成される。
		await goToStep(user, "リフレーム");
		await expandOutputSettings(user);
		const titleField = await screen.findByLabelText<HTMLInputElement>("タイトル", {
			selector: "input",
		});
		await user.type(titleField, "テストタイトル");
		expect(titleField).toHaveValue("テストタイトル");

		// upload → export → edit → export → upload と往復しても、結果・入力値は消えない。
		await goToStep(user, "確認");
		expect(screen.getByText("完了")).toBeInTheDocument();
		await goToStep(user, "編集");
		await goToStep(user, "確認");
		expect(screen.getByText("完了")).toBeInTheDocument();
		await goToStep(user, "リフレーム");
		expect(
			await screen.findByLabelText<HTMLInputElement>("タイトル", { selector: "input" }),
		).toHaveValue("テストタイトル");
		// 往復のあいだ、書き出しジョブは再起動されていない(1 回のみ)。
		expect(reframeStartCalls()).toHaveLength(1);

		// 新しい元動画を選択する(resetToken 増分)と、export の結果・upload の入力値は
		// 明示的に破棄される。
		await goToStep(user, "編集");
		await pickSource(user, "/video2.mp4");

		await goToStep(user, "確認");
		expect(screen.queryByText("完了")).not.toBeInTheDocument();
		await goToStep(user, "リフレーム");
		// resetToken で posts が作り直されたため Output も新規インスタンス
		// (折りたたみの開閉状態はリセットされている)。改めて開く。
		await expandOutputSettings(user);
		const freshTitleField = await screen.findByLabelText<HTMLInputElement>("タイトル", {
			selector: "input",
		});
		expect(freshTitleField).toHaveValue("");
	});
});

/**
 * stepLocked(リフレーム画面で投稿処理中)のリグレッション固定テスト。
 * 以前は pickMutation.onSuccess が stepLocked を無視しており、ヘッダの
 * 「元動画を選択」ボタンも投稿処理中は常に有効なままだった。投稿処理中に新しい
 * 元動画を選ぶと、書き出し前提の state(source/clips/選択中 clip)が丸ごと
 * 破棄されてしまう(stepLocked が本来防ぐはずの離脱と同じ実害)。
 */
describe("App: 投稿処理中(stepLocked)はヘッダの元動画選択を禁止する", () => {
	it("投稿中はヘッダの「元動画を選択」ボタンが disabled になり、クリックしても何も起きない", async () => {
		const user = userEvent.setup();
		// YouTube OAuth 接続済み。既定 Post の Output は yt-shorts(YouTube)なので
		// これだけで投稿ボタンを有効化できる(IG のような R2/scheduler 設定は不要)。
		await mockInvoke("set_youtube_oauth_client", {
			clientId: "client-id",
			clientSecret: "client-secret",
		});
		await mockInvoke("youtube_oauth_connect");

		renderWithProviders(<App />);
		await pickSource(user, "/video1.mp4");
		// canGoUpload は clips.length > 0 のみが条件なので、export を経由せず直接遷移できる。
		await goToStep(user, "リフレーム");

		await expandOutputSettings(user);
		const titleField = await screen.findByLabelText<HTMLInputElement>("タイトル", {
			selector: "input",
		});
		await user.type(titleField, "テストタイトル");

		// 「この投稿をすべて投稿」(publishPostMutation 経由)をクリックする。
		// OutputPublishSection 単体の「投稿」ボタンは publishOutput を直接 fire-and-forget
		// 呼び出すだけで isPending(busy)には反映されないため、stepLocked を
		// 再現するにはこちら(post 単位の一括投稿)を使う必要がある。
		await expandPostScheduleSettings(user);
		const publishButton = await screen.findByRole("button", {
			name: "この投稿をすべて投稿",
		});
		await waitFor(() => expect(publishButton).toBeEnabled());
		await user.click(publishButton);

		// 投稿レンダリング(publish 品質の preview_start)が発火するところまで進める。
		// done イベントを送らないことで publishPostMutation を isPending のまま止め、
		// uploadBusy(= stepLocked)を true に保つ。
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith(
				"preview_start",
				expect.objectContaining({ quality: "publish" }),
			),
		);

		// stepLocked: 他ステップへの遷移ボタンは既存の StepIndicator 側の保護で無効化される
		// (onBusyChange の反映は effect 経由のため、commit を待つ必要がある)。
		await waitFor(() =>
			expect(stepNav().getByRole("button", { name: /確認/ })).toBeDisabled(),
		);

		// 本題: ヘッダの「元動画を選択」ボタンも無効化されている。
		const pickButton = screen.getByRole("button", { name: "元動画を選択" });
		expect(pickButton).toBeDisabled();

		// disabled なボタンは click してもブラウザ/jsdom 側で onClick 自体が発火しない
		// ため、これは「disabled 属性が付いている」ことの確認であり、
		// pickMutation.onSuccess 内の stepLocked ガード自体の直接確認ではない
		// (そちらは disabled を回避してでも mutate() が呼ばれた場合の保険で、
		// UI からは再現できない)。ここでは選択ダイアログが開かず、画面/入力値も
		// 維持されることだけを確認する。
		mockDialogOpen.mockClear();
		await user.click(pickButton);
		expect(mockDialogOpen).not.toHaveBeenCalled();
		expect(screen.getByRole("heading", { name: "リフレーム" })).toBeInTheDocument();
		expect(titleField).toHaveValue("テストタイトル");
	});
});

/**
 * a11y: ステップ遷移時、遷移先パネルの見出しへフォーカスが移ることの固定テスト。
 * 各パネルは sr-only の見出し(`wizard-panel-heading-${step}`)を持ち、
 * goToStep 経由の遷移のたびにそこへフォーカスする(初回マウント時は除く)。
 */
describe("App: ステップ遷移時のフォーカス移動(a11y)", () => {
	it("edit → export → upload と遷移するたびに遷移先パネルの見出しへフォーカスする", async () => {
		const user = userEvent.setup();
		renderWithProviders(<App />);

		await pickSource(user, "/video1.mp4");

		await user.click(screen.getByRole("button", { name: /確認へ進む/ }));
		expect(screen.getByRole("heading", { name: "確認" })).toHaveFocus();

		await goToStep(user, "リフレーム");
		expect(screen.getByRole("heading", { name: "リフレーム" })).toHaveFocus();

		await goToStep(user, "編集");
		expect(screen.getByRole("heading", { name: "編集" })).toHaveFocus();
	});
});

describe("App: 同時エンコード数の同期(useEncodeSettingsSync)", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	it("初回マウント時に既定値(2)で set_max_concurrent_encodes が invoke される", async () => {
		renderWithProviders(<App />);

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("set_max_concurrent_encodes", {
				max: 2,
			}),
		);
	});

	it("設定ダイアログで同時エンコード数を変更すると set_max_concurrent_encodes が再 invoke される", async () => {
		const user = userEvent.setup();
		renderWithProviders(<App />);

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("set_max_concurrent_encodes", {
				max: 2,
			}),
		);

		await user.click(screen.getByRole("button", { name: "設定" }));
		await user.click(screen.getByRole("button", { name: "4" }));

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("set_max_concurrent_encodes", {
				max: 4,
			}),
		);
	});
});

describe("App: 設定ダイアログ", () => {
	it("ヘッダの歯車ボタンから設定ダイアログを開閉できる", async () => {
		const user = userEvent.setup();
		renderWithProviders(<App />);

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "設定" }));
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "設定" })).toBeInTheDocument();

		// Modal のヘッダ✕ボタン・オーバーレイの双方が aria-label="閉じる" を持つため、
		// 曖昧さを避けて Esc(Modal 共通のクローズ手段)で閉じる。
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});

/**
 * private 版は updater の更新チェックを実行しない(edition 出し分け。別 identifier で
 * 共存インストールされ作者が手動リビルドで更新する運用、docs/desktop-migration-plan.md
 * §6.6)。public 版で実行することは App.public-edition.test.tsx で確認している。
 */
describe("App: private エディション(既定)は updater を起動しない", () => {
	it("マウント後もしばらく待って updater 関連の invoke/エラーログが一切発生しない", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		renderWithProviders(<App />);

		// 「呼ばれない」ことの確認なので一定時間経過を待ってから判定する。
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(consoleError).not.toHaveBeenCalledWith(
			"[updater] check() failed (ignored):",
			expect.anything(),
		);
		expect(
			mockInvoke.mock.calls.some(([cmd]) => cmd.startsWith("plugin:updater")),
		).toBe(false);
		consoleError.mockRestore();
	});
});
