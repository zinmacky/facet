/** @type {import('tailwindcss').Config} */
export default {
	darkMode: "class",
	content: ["./index.html", "./src/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				// 実際の色値は src/index.css のテーマ変数(:root = ライト / .dark = ダーク)
				// で定義する。ここは変数参照のみにして、クラス名を変えずにテーマを切り替える。
				panel: "var(--color-panel)",
				surface: "var(--color-surface)",
				elevated: "var(--color-elevated)",
				line: "var(--color-line)",
				accent: "var(--color-accent)",
				"accent-hover": "var(--color-accent-hover)",
				danger: "var(--color-danger)",
				ok: "var(--color-ok)",
				// Tailwind 既定の neutral をテーマ変数で上書きする(ライトでは反転スケール)。
				neutral: {
					50: "var(--color-neutral-50)",
					100: "var(--color-neutral-100)",
					200: "var(--color-neutral-200)",
					300: "var(--color-neutral-300)",
					400: "var(--color-neutral-400)",
					500: "var(--color-neutral-500)",
					600: "var(--color-neutral-600)",
					700: "var(--color-neutral-700)",
					800: "var(--color-neutral-800)",
					900: "var(--color-neutral-900)",
					950: "var(--color-neutral-950)",
				},
			},
			fontFamily: {
				mono: [
					"ui-monospace",
					"SFMono-Regular",
					"Menlo",
					"Consolas",
					"monospace",
				],
			},
		},
	},
	plugins: [],
};
