import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { ConfirmProvider } from "../components/ui/confirm";
import { PublishGateProvider } from "../features/publish-settings/PublishGateContext";
import { SettingsProvider } from "../lib/settings";

/**
 * `main.tsx` と同じ Provider 構成(SettingsProvider + QueryClientProvider +
 * ConfirmProvider + PublishGateProvider)で render する。`useMutation` や
 * `useConfirm`、`useSettings`、`usePublishGateContext` を使うコンポーネント
 * (ExportScreen/UploadScreen/App)のテストはこれを使う。
 *
 * `PublishGateProvider` を常に含めるのは、`UploadScreen` が
 * `usePublishGateContext()`(§PublishGateContext.tsx)を呼ぶため
 * (Provider 外で呼ぶと例外を投げる設計)。private エディション専用のテスト
 * ヘルパのため実体(`./PublishGateContext`)を直接 import してよい
 * (public 版のバンドルには test/ 配下は含まれない)。
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
				<PublishGateProvider>
					<ConfirmProvider>{ui}</ConfirmProvider>
				</PublishGateProvider>
			</QueryClientProvider>
		</SettingsProvider>,
	);
}
