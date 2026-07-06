import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dev proxy: フロントは自分のオリジンにだけ話し、studio server は /api・/files 経由で叩く。
// これで CORS を避けつつ、本番ビルドでも同一パス前提のコードを共有できる。
const SERVER_ORIGIN = "http://localhost:5178";

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5179,
		proxy: {
			// /api/* → server の /*(プレフィックスを剥がす)
			"/api": {
				target: SERVER_ORIGIN,
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api/, ""),
			},
			// /files/* はローカルのメディア配信。SSE も含むため ws は不要だが素通しする。
			"/files": {
				target: SERVER_ORIGIN,
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/files/, "/files"),
			},
		},
	},
});
