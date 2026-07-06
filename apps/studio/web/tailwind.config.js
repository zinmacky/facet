/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ダークな編集ツール調のニュートラル + アクセント
        panel: "#131417",
        surface: "#1a1c21",
        elevated: "#22252c",
        line: "#2c3038",
        accent: "#5b8cff",
        "accent-hover": "#77a0ff",
        danger: "#f0616d",
        ok: "#3ec38a",
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
