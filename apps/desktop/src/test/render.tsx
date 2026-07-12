import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { ConfirmProvider } from "../components/ui/confirm";
import { SettingsProvider } from "../lib/settings";

/**
 * `main.tsx` と同じ Provider 構成(SettingsProvider + QueryClientProvider +
 * ConfirmProvider)で render する。`useMutation` や `useConfirm`、`useSettings` を
 * 使うコンポーネント(ExportScreen/UploadScreen/App)のテストはこれを使う。
 */
export function renderWithProviders(ui: ReactElement): RenderResult {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<SettingsProvider>
			<QueryClientProvider client={queryClient}>
				<ConfirmProvider>{ui}</ConfirmProvider>
			</QueryClientProvider>
		</SettingsProvider>,
	);
}
