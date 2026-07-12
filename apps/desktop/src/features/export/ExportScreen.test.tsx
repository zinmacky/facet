import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Clip } from "../../types";
import { renderWithProviders } from "../../test/render";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "../../lib/settings";
import {
	DEFAULT_MEDIA_INFO,
	emitMockEvent,
	mockDialogOpen,
	mockEventListenerCount,
	mockInvoke,
	mockIsPermissionGranted,
	mockJoin,
	mockOpenPath,
	mockRequestPermission,
	mockSendNotification,
} from "../../test/tauri-mock";
import { ExportScreen } from "./ExportScreen";

// 設定(useSettings)は localStorage 経由で読み出される。他テストへ影響しないよう、
// このファイル内で設定を注入するテストの前後で必ずクリアする。
beforeEach(() => {
	window.localStorage.clear();
});

const SOURCE = { inputPath: "/in.mp4", probe: DEFAULT_MEDIA_INFO };

function makeClip(id: string, name: string, trimEnd: number): Clip {
	return { id, name, trim: { start: 0, end: trimEnd }, aspect: "free" };
}

/**
 * 実運用(App.tsx)は clips を親(App)が state で持ち、ClipEditor 側の変更で
 * setClips するだけで ExportScreen 自身は再マウントされない。この Harness は
 * その「親から渡される clips が変わる」状況をテスト側から直接再現する
 * (ClipEditor の Timeline/CropOverlay ドラッグ操作は経由しない — ExportScreen 自身の
 * clip 単位無効化ロジックの検証が目的なので、trim/crop の変更手段は問わない)。
 */
function Harness({ initialClips }: { initialClips: Clip[] }) {
	const [clips, setClips] = useState(initialClips);
	const [resetToken, setResetToken] = useState(0);
	return (
		<div>
			<ExportScreen
				active
				source={SOURCE}
				clips={clips}
				resetToken={resetToken}
				onGoToEdit={() => {}}
				onGoToUpload={() => {}}
			/>
			<button
				type="button"
				onClick={() =>
					setClips((prev) =>
						prev.map((c) =>
							c.id === "clip-a" ? { ...c, trim: { start: 1, end: c.trim.end } } : c,
						),
					)
				}
			>
				mutate-clip-a-trim
			</button>
			<button
				type="button"
				onClick={() => setClips((prev) => prev.filter((c) => c.id !== "clip-b"))}
			>
				remove-clip-b
			</button>
			<button
				type="button"
				onClick={() =>
					setClips((prev) => [...prev, makeClip("clip-c", "clipC", 6)])
				}
			>
				add-clip-c
			</button>
			<button type="button" onClick={() => setResetToken((t) => t + 1)}>
				bump-reset-token
			</button>
		</div>
	);
}

function reframeStartCalls() {
	return mockInvoke.mock.calls.filter(([cmd]) => cmd === "reframe_start");
}

async function startExport(user: ReturnType<typeof userEvent.setup>) {
	mockDialogOpen.mockResolvedValueOnce("/out");
	await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
	await waitFor(() => expect(reframeStartCalls()).toHaveLength(2));
}

/** 右側一覧の行(ExportListItem)を clip ファイル名で一意に取得する(中央詳細見出しは button でないため衝突しない)。 */
function listRow(fileName: string): HTMLElement {
	return screen.getByRole("button", { name: new RegExp(`^${fileName}`) });
}

describe("ExportScreen: clip 単位シグネチャ無効化(clipPreviewSig)", () => {
	it("1 clip の trim 変更は自動で再書き出しされず「要再書き出し」になり、再書き出しボタンでその clip だけ再実行される", async () => {
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		const clipB = makeClip("clip-b", "clipB", 8);
		renderWithProviders(<Harness initialClips={[clipA, clipB]} />);

		await startExport(user);
		expect(mockJoin).toHaveBeenCalledWith("/out", "clipA.mp4");
		expect(mockJoin).toHaveBeenCalledWith("/out", "clipB.mp4");

		// 両方のジョブを完了させる(job-1=clipA, job-2=clipB。clips 配列順で起動される)。
		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		emitMockEvent("reframe://done/job-2", { encoder: "h264" });

		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
			expect(within(listRow("clipB.mp4")).getByText("完了")).toBeInTheDocument();
		});

		// clip-a の trim を変更する(App では ClipEditor の Timeline 操作に相当)。
		await user.click(screen.getByRole("button", { name: "mutate-clip-a-trim" }));

		// clip-a の結果は即座に破棄され「要再書き出し」になるが、自動では再実行されない
		// (UX 変更: ユーザーの知らないところでファイルが書き換わる自動再書き出しを廃止した)。
		// clip-b の結果(完了)はそのまま保持される。
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("要再書き出し")).toBeInTheDocument();
		});
		expect(reframeStartCalls()).toHaveLength(2);
		expect(within(listRow("clipB.mp4")).getByText("完了")).toBeInTheDocument();

		// 旧ジョブ(job-1)の reframe_cancel 完了を待ってから、明示的に「再書き出し」ボタンで
		// clip-a だけを再実行する。
		const reExportButton = await screen.findByRole("button", {
			name: "再書き出し: clipA.mp4",
		});
		await waitFor(() => expect(reExportButton).toBeEnabled());
		await user.click(reExportButton);
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(3));

		emitMockEvent("reframe://done/job-3", { encoder: "h264" });
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
		});
		// clip-b は一連の操作を通じて一度も再起動されていない(reframe_start 呼び出しは
		// clip-a 用の 2 回分(初回 job-1 + 明示再書き出し job-3)+ clip-b 用の初回 job-2 の計 3 回のみ)。
		expect(reframeStartCalls()).toHaveLength(3);
	});

	it("clip 削除時はその clip の結果・購読のみ個別に破棄し、他 clip は影響を受けない", async () => {
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		const clipB = makeClip("clip-b", "clipB", 8);
		renderWithProviders(<Harness initialClips={[clipA, clipB]} />);

		await startExport(user);
		// clip-b(job-2)はまだ進行中(完了させない)。購読が張られていることを確認。
		await waitFor(() => expect(mockEventListenerCount("reframe://done/job-2")).toBe(1));

		await user.click(screen.getByRole("button", { name: "remove-clip-b" }));

		// clip-b の結果行が消え、購読も解除される。
		await waitFor(() => expect(screen.queryByText("clipB.mp4")).not.toBeInTheDocument());
		expect(mockEventListenerCount("reframe://done/job-2")).toBe(0);

		// clip-a(job-1)は無関係に進行中のまま(再起動されない = invoke 回数は増えない)。
		expect(reframeStartCalls()).toHaveLength(2);
		expect(mockEventListenerCount("reframe://done/job-1")).toBe(1);

		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
		});
	});
});

describe("ExportScreen: 自動再書き出し廃止(UX 変更1)", () => {
	it("「書き出しを開始」後に追加された clip は自動では書き出されず、明示ボタンで書き出される", async () => {
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		renderWithProviders(<Harness initialClips={[clipA]} />);

		mockDialogOpen.mockResolvedValueOnce("/out");
		await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));

		await user.click(screen.getByRole("button", { name: "add-clip-c" }));

		// 新規追加された clip-c は自動では書き出されない(「未書き出し」表示のまま)。
		await waitFor(() => {
			expect(within(listRow("clipC.mp4")).getByText("未書き出し")).toBeInTheDocument();
		});
		expect(reframeStartCalls()).toHaveLength(1);

		// 明示的に「書き出す」ボタンを押すと起動する。
		await user.click(screen.getByRole("button", { name: "書き出す: clipC.mp4" }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(2));

		emitMockEvent("reframe://done/job-2", { encoder: "h264" });
		await waitFor(() => {
			expect(within(listRow("clipC.mp4")).getByText("完了")).toBeInTheDocument();
		});
	});

	it("再書き出しボタンは旧ジョブの reframe_cancel が完了するまで disabled になる", async () => {
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		renderWithProviders(<Harness initialClips={[clipA]} />);

		mockDialogOpen.mockResolvedValueOnce("/out");
		await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));
		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
		});

		// reframe_cancel の resolve を保留する(旧ジョブのキャンセルが完了するまで、
		// 同じ出力パスへ旧ジョブと新ジョブが同時に書き込む競合を避けるため
		// 再書き出しボタンは disabled のはず)。
		let resolveCancel: (() => void) | undefined;
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "reframe_cancel") {
				return new Promise<void>((resolve) => {
					resolveCancel = () => resolve(undefined);
				});
			}
			return undefined;
		});

		await user.click(screen.getByRole("button", { name: "mutate-clip-a-trim" }));

		const reExportButton = await screen.findByRole("button", {
			name: "再書き出し: clipA.mp4",
		});
		await waitFor(() => expect(reExportButton).toBeDisabled());
		expect(reExportButton).toHaveTextContent("キャンセル待ち…");

		resolveCancel?.();

		await waitFor(() => expect(reExportButton).toBeEnabled());
		expect(reExportButton).toHaveTextContent("再書き出し");
	});

	it("失敗(error)した clip は自動でリトライされず、「再試行」ボタンで再実行できる", async () => {
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		renderWithProviders(<Harness initialClips={[clipA]} />);

		mockDialogOpen.mockResolvedValueOnce("/out");
		await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));

		emitMockEvent("reframe://error/job-1", { message: "OutputBusy" });
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("失敗")).toBeInTheDocument();
		});
		// 以前は clips 変更のたびに error の task も再起動していたが、自動再書き出しの
		// 廃止でその経路も無くなったため、明示的な「再試行」ボタンでのみ復帰できる。
		expect(reframeStartCalls()).toHaveLength(1);

		const retryButton = await screen.findByRole("button", {
			name: "再試行: clipA.mp4",
		});
		await waitFor(() => expect(retryButton).toBeEnabled());
		await user.click(retryButton);
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(2));

		emitMockEvent("reframe://done/job-2", { encoder: "h264" });
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
		});
	});
});

describe("ExportScreen: 書き出しファイル名の重複回避", () => {
	it("同名 clip が複数あっても書き出し先ファイル名は衝突せず、2 件目以降に -2 が付く", async () => {
		const user = userEvent.setup();
		// 2 clip が同じ表示名を持つ(例: 同じ元動画から複製した場合など)。
		const clipA = makeClip("clip-a", "Clip", 10);
		const clipB = makeClip("clip-b", "Clip", 8);
		renderWithProviders(<Harness initialClips={[clipA, clipB]} />);

		await startExport(user);

		// 以前は両方とも `sanitizeFileName(clip.name)}.mp4` = "Clip.mp4" で
		// 書き出し先が衝突し、後発のジョブが先発の出力を上書きしていた(P1 バグ)。
		// 採番ロジック(uniqueBaseNames、UploadScreen の一括書き出しと共有)により
		// 2 件目は "Clip-2.mp4" になる。
		expect(mockJoin).toHaveBeenCalledWith("/out", "Clip.mp4");
		expect(mockJoin).toHaveBeenCalledWith("/out", "Clip-2.mp4");
	});
});

describe("ExportScreen: 設定連携(既定の書き出し先 / 完了後にフォルダを開く)", () => {
	it("defaultExportDir 設定時はダイアログを出さず、設定済みのパスへ直接書き出す", async () => {
		window.localStorage.setItem(
			SETTINGS_STORAGE_KEY,
			JSON.stringify({ ...DEFAULT_SETTINGS, defaultExportDir: "/preset/out" }),
		);
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		renderWithProviders(<Harness initialClips={[clipA]} />);

		await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));

		expect(mockDialogOpen).not.toHaveBeenCalled();
		expect(mockJoin).toHaveBeenCalledWith("/preset/out", "clipA.mp4");
		// スキップされても出力先パスは UI 上に見える。
		expect(screen.getByText("/preset/out")).toBeInTheDocument();
	});

	it("defaultExportDir 未設定時は従来どおりダイアログで書き出し先を選ばせる", async () => {
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		renderWithProviders(<Harness initialClips={[clipA]} />);

		mockDialogOpen.mockResolvedValueOnce("/chosen");
		await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));

		expect(mockDialogOpen).toHaveBeenCalledTimes(1);
		expect(mockJoin).toHaveBeenCalledWith("/chosen", "clipA.mp4");
	});

	it("openFolderAfterExport=true のとき、バッチ内の全ジョブが完了した時点で一度だけフォルダを開く", async () => {
		window.localStorage.setItem(
			SETTINGS_STORAGE_KEY,
			JSON.stringify({ ...DEFAULT_SETTINGS, openFolderAfterExport: true }),
		);
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		const clipB = makeClip("clip-b", "clipB", 8);
		renderWithProviders(<Harness initialClips={[clipA, clipB]} />);

		await startExport(user);

		// 1 件目のみ完了した時点ではまだ開かない(全件完了が条件)。
		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
		});
		expect(mockOpenPath).not.toHaveBeenCalled();

		// 全件完了した時点で一度だけ開く。
		emitMockEvent("reframe://done/job-2", { encoder: "h264" });
		await waitFor(() => expect(mockOpenPath).toHaveBeenCalledTimes(1));
		expect(mockOpenPath).toHaveBeenCalledWith("/out");

		// 完了後の再レンダリング(選択 clip の切り替え等)でも二重に開かれない。
		await user.click(listRow("clipB.mp4"));
		expect(mockOpenPath).toHaveBeenCalledTimes(1);
	});

	it("openFolderAfterExport=false(既定)のときは完了してもフォルダを開かない", async () => {
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		renderWithProviders(<Harness initialClips={[clipA]} />);

		mockDialogOpen.mockResolvedValueOnce("/out");
		await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));

		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
		});
		expect(mockOpenPath).not.toHaveBeenCalled();
	});

	it("notifyOnExportComplete=true のとき、バッチ内の全ジョブが完了した時点で一度だけ通知を送る", async () => {
		window.localStorage.setItem(
			SETTINGS_STORAGE_KEY,
			JSON.stringify({ ...DEFAULT_SETTINGS, notifyOnExportComplete: true }),
		);
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		const clipB = makeClip("clip-b", "clipB", 8);
		renderWithProviders(<Harness initialClips={[clipA, clipB]} />);

		await startExport(user);

		// 1 件目のみ完了した時点ではまだ送らない(全件完了が条件)。
		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
		});
		expect(mockSendNotification).not.toHaveBeenCalled();

		// 全件完了した時点で一度だけ送る。
		emitMockEvent("reframe://done/job-2", { encoder: "h264" });
		await waitFor(() => expect(mockSendNotification).toHaveBeenCalledTimes(1));
		expect(mockSendNotification).toHaveBeenCalledWith({
			title: "書き出しが完了しました",
			body: "2 本の切り抜きを書き出しました。",
		});

		// 完了後の再レンダリング(選択 clip の切り替え等)でも二重に送られない。
		await user.click(listRow("clipB.mp4"));
		expect(mockSendNotification).toHaveBeenCalledTimes(1);
	});

	it("notifyOnExportComplete=false(既定)のときは完了しても通知しない", async () => {
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		renderWithProviders(<Harness initialClips={[clipA]} />);

		mockDialogOpen.mockResolvedValueOnce("/out");
		await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));

		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
		});
		expect(mockSendNotification).not.toHaveBeenCalled();
	});

	it("notifyOnExportComplete=true でも通知権限が拒否されている場合は通知しない", async () => {
		mockIsPermissionGranted.mockResolvedValue(false);
		mockRequestPermission.mockResolvedValue("denied");
		window.localStorage.setItem(
			SETTINGS_STORAGE_KEY,
			JSON.stringify({ ...DEFAULT_SETTINGS, notifyOnExportComplete: true }),
		);
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		renderWithProviders(<Harness initialClips={[clipA]} />);

		mockDialogOpen.mockResolvedValueOnce("/out");
		await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));

		emitMockEvent("reframe://done/job-1", { encoder: "h264" });
		await waitFor(() => {
			expect(within(listRow("clipA.mp4")).getByText("完了")).toBeInTheDocument();
		});
		await waitFor(() => expect(mockRequestPermission).toHaveBeenCalled());
		expect(mockSendNotification).not.toHaveBeenCalled();
	});

	it("settings.encoder が明示指定(h264_amf)のとき reframe_start へ encoder が渡る", async () => {
		window.localStorage.setItem(
			SETTINGS_STORAGE_KEY,
			JSON.stringify({ ...DEFAULT_SETTINGS, encoder: "h264_amf" }),
		);
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		renderWithProviders(<Harness initialClips={[clipA]} />);

		mockDialogOpen.mockResolvedValueOnce("/out");
		await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));

		expect(mockInvoke).toHaveBeenCalledWith(
			"reframe_start",
			expect.objectContaining({ encoder: "h264_amf" }),
		);
	});

	it("settings.encoder が既定(auto)のとき reframe_start に encoder キーを含めない", async () => {
		const user = userEvent.setup();
		const clipA = makeClip("clip-a", "clipA", 10);
		renderWithProviders(<Harness initialClips={[clipA]} />);

		mockDialogOpen.mockResolvedValueOnce("/out");
		await user.click(screen.getByRole("button", { name: /書き出しを開始/ }));
		await waitFor(() => expect(reframeStartCalls()).toHaveLength(1));

		const [, args] = reframeStartCalls()[0] as [string, Record<string, unknown>];
		expect(args.encoder).toBeUndefined();
	});
});
