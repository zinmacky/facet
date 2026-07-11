import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { ConfirmProvider } from "./components/ui/confirm";
import "./index.css";

// 編集ツールなので過剰な自動 refetch は不要。明示操作で invalidate する方針。
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			retry: 1,
		},
	},
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root が見つかりません");

createRoot(rootEl).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<ConfirmProvider>
				<App />
			</ConfirmProvider>
		</QueryClientProvider>
	</StrictMode>,
);
