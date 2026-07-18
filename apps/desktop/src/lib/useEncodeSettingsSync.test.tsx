import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsProvider, useSettings } from "./settings";
import { useEncodeSettingsSync } from "./useEncodeSettingsSync";

const { setMaxConcurrentEncodes } = vi.hoisted(() => ({
	setMaxConcurrentEncodes: vi.fn(),
}));

vi.mock("./tauri", () => ({
	setMaxConcurrentEncodes,
}));

function wrapper({ children }: { children: ReactNode }) {
	return <SettingsProvider>{children}</SettingsProvider>;
}

function useHarness() {
	useEncodeSettingsSync();
	return useSettings();
}

beforeEach(() => {
	window.localStorage.clear();
	setMaxConcurrentEncodes.mockReset();
});

describe("useEncodeSettingsSync", () => {
	it("マウント時に現在の maxConcurrentEncodes で invoke する", async () => {
		setMaxConcurrentEncodes.mockResolvedValue(undefined);
		const { result } = renderHook(useHarness, { wrapper });

		await waitFor(() =>
			expect(setMaxConcurrentEncodes).toHaveBeenCalledWith(
				result.current.settings.maxConcurrentEncodes,
			),
		);
	});

	it("値の変更のたびに invoke する", async () => {
		setMaxConcurrentEncodes.mockResolvedValue(undefined);
		const { result } = renderHook(useHarness, { wrapper });

		await waitFor(() => expect(setMaxConcurrentEncodes).toHaveBeenCalledTimes(1));

		act(() => {
			result.current.updateSettings({ maxConcurrentEncodes: 4 });
		});

		await waitFor(() => expect(setMaxConcurrentEncodes).toHaveBeenCalledTimes(2));
		expect(setMaxConcurrentEncodes).toHaveBeenLastCalledWith(4);
	});

	it("invoke が reject しても console.warn に留め、unhandled rejection にならない", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const err = new Error("invoke failed");
		setMaxConcurrentEncodes.mockRejectedValue(err);

		const { result } = renderHook(useHarness, { wrapper });

		await waitFor(() => expect(warnSpy).toHaveBeenCalled());
		const [message, cause] = warnSpy.mock.calls[0] ?? [];
		expect(message).toContain(String(result.current.settings.maxConcurrentEncodes));
		expect(cause).toBe(err);

		warnSpy.mockRestore();
	});
});
