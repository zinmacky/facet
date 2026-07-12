import { act, renderHook, waitFor } from "@testing-library/react";
import type { Update } from "@tauri-apps/plugin-updater";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdateChecker } from "./updater";

const SNOOZE_KEY = "facet.desktop.update.snooze";

/** `check()` の戻り値として使う最小限の Update スタブ。 */
function makeUpdate(overrides: Partial<Update> = {}): Update {
	return {
		version: "1.2.3",
		body: "リリースノート",
		download: vi.fn().mockResolvedValue(undefined),
		install: vi.fn().mockResolvedValue(undefined),
		downloadAndInstall: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as Update;
}

beforeEach(() => {
	window.localStorage.clear();
});

describe("useUpdateChecker", () => {
	it("check() が更新を返すと status が available になり version/body を保持する", async () => {
		const check = vi.fn().mockResolvedValue(makeUpdate({ version: "2.0.0", body: "note" }));
		const { result } = renderHook(() => useUpdateChecker({ check }));

		await waitFor(() => expect(result.current.status).toBe("available"));
		expect(result.current.version).toBe("2.0.0");
		expect(result.current.body).toBe("note");
		expect(check).toHaveBeenCalledTimes(1);
	});

	it("check() が null を返すと更新なし(idle のまま)", async () => {
		const check = vi.fn().mockResolvedValue(null);
		const { result } = renderHook(() => useUpdateChecker({ check }));

		// 非同期の完了を待つため、状態が変化しないことを一定時間確認する。
		await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
		expect(result.current.status).toBe("idle");
	});

	it("「後で」で dismiss すると localStorage に snooze が保存され status が idle に戻る", async () => {
		const check = vi.fn().mockResolvedValue(makeUpdate({ version: "3.0.0" }));
		const now = vi.fn().mockReturnValue(1_000_000);
		const { result } = renderHook(() => useUpdateChecker({ check, now }));

		await waitFor(() => expect(result.current.status).toBe("available"));

		act(() => {
			result.current.dismiss();
		});

		expect(result.current.status).toBe("idle");
		const stored = JSON.parse(window.localStorage.getItem(SNOOZE_KEY) ?? "null");
		expect(stored).toEqual({ version: "3.0.0", snoozedAt: 1_000_000 });
	});

	it("同一 version を snooze 後、24h 未経過なら再通知されない", async () => {
		window.localStorage.setItem(
			SNOOZE_KEY,
			JSON.stringify({ version: "4.0.0", snoozedAt: 1_000_000 }),
		);
		const check = vi.fn().mockResolvedValue(makeUpdate({ version: "4.0.0" }));
		// 23 時間後(24h 未満)。
		const now = vi.fn().mockReturnValue(1_000_000 + 23 * 60 * 60 * 1000);
		const { result } = renderHook(() => useUpdateChecker({ check, now }));

		await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
		expect(result.current.status).toBe("idle");
	});

	it("同一 version の snooze から 24h 経過すると再通知される", async () => {
		window.localStorage.setItem(
			SNOOZE_KEY,
			JSON.stringify({ version: "5.0.0", snoozedAt: 1_000_000 }),
		);
		const check = vi.fn().mockResolvedValue(makeUpdate({ version: "5.0.0" }));
		// ちょうど 24h + 1ms 後。
		const now = vi.fn().mockReturnValue(1_000_000 + 24 * 60 * 60 * 1000 + 1);
		const { result } = renderHook(() => useUpdateChecker({ check, now }));

		await waitFor(() => expect(result.current.status).toBe("available"));
		expect(result.current.version).toBe("5.0.0");
	});

	it("別バージョンの更新は、旧バージョンの snooze 期間内でも通知される", async () => {
		window.localStorage.setItem(
			SNOOZE_KEY,
			JSON.stringify({ version: "6.0.0", snoozedAt: 1_000_000 }),
		);
		const check = vi.fn().mockResolvedValue(makeUpdate({ version: "7.0.0" }));
		// snooze 直後(24h 未満)だが version が異なる。
		const now = vi.fn().mockReturnValue(1_000_100);
		const { result } = renderHook(() => useUpdateChecker({ check, now }));

		await waitFor(() => expect(result.current.status).toBe("available"));
		expect(result.current.version).toBe("7.0.0");
	});

	it("check() が失敗しても黙殺される(status は error になるが例外は投げない)", async () => {
		const check = vi.fn().mockRejectedValue(new Error("404 Not Found"));
		const { result } = renderHook(() => useUpdateChecker({ check }));

		await waitFor(() => expect(result.current.status).toBe("error"));
		expect(result.current.error).toBe("404 Not Found");
		expect(result.current.version).toBeUndefined();
	});
});
