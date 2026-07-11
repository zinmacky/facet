import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { ConfirmProvider } from "../components/ui/confirm";

/**
 * `main.tsx` と同じ Provider 構成(QueryClientProvider + ConfirmProvider)で render する。
 * `useMutation` や `useConfirm` を使うコンポーネント(ExportScreen/UploadScreen/App)の
 * テストはこれを使う。
 */
export function renderWithProviders(ui: ReactElement): RenderResult {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<ConfirmProvider>{ui}</ConfirmProvider>
		</QueryClientProvider>,
	);
}
