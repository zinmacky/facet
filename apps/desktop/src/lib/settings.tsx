import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

/** テーマの選択値。"system" は OS 設定(prefers-color-scheme)に追従する。 */
export type ThemePreference = "system" | "light" | "dark";

/** アプリ全体の設定。localStorage へ JSON で永続化する。 */
export type AppSettings = {
	theme: ThemePreference;
	/** null = 書き出しの都度ダイアログで選択(従来動作) */
	defaultExportDir: string | null;
	/** 書き出し完了後に出力フォルダを自動で開く */
	openFolderAfterExport: boolean;
	/** 書き出し完了時に OS のデスクトップ通知を送る */
	notifyOnExportComplete: boolean;
};

export const DEFAULT_SETTINGS: AppSettings = {
	theme: "dark", // 既定はダーク(現状の見た目を維持)
	defaultExportDir: null,
	openFolderAfterExport: false,
	notifyOnExportComplete: false,
};

export const SETTINGS_STORAGE_KEY = "facet.desktop.settings";

/**
 * テーマ選択値を実際の表示テーマへ解決する。
 * index.html の FOUC 防止スクリプトと同じロジック(対で保守する)。
 */
export function resolveTheme(
	pref: ThemePreference,
	systemPrefersDark: boolean,
): "light" | "dark" {
	if (pref === "system") return systemPrefersDark ? "dark" : "light";
	return pref;
}

function isThemePreference(value: unknown): value is ThemePreference {
	return value === "system" || value === "light" || value === "dark";
}

/**
 * localStorage から設定を読み出す。値が無い/壊れている場合は DEFAULT_SETTINGS。
 * 部分的な保存値(古いバージョンで保存された等)や不正なフィールドは、
 * フィールド単位で既定値へフォールバックする。
 */
export function loadSettings(): AppSettings {
	if (typeof window === "undefined") return DEFAULT_SETTINGS;
	try {
		const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
		if (raw === null) return DEFAULT_SETTINGS;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return DEFAULT_SETTINGS;
		const obj = parsed as Record<string, unknown>;
		return {
			theme: isThemePreference(obj.theme) ? obj.theme : DEFAULT_SETTINGS.theme,
			defaultExportDir:
				typeof obj.defaultExportDir === "string"
					? obj.defaultExportDir
					: DEFAULT_SETTINGS.defaultExportDir,
			openFolderAfterExport:
				typeof obj.openFolderAfterExport === "boolean"
					? obj.openFolderAfterExport
					: DEFAULT_SETTINGS.openFolderAfterExport,
			notifyOnExportComplete:
				typeof obj.notifyOnExportComplete === "boolean"
					? obj.notifyOnExportComplete
					: DEFAULT_SETTINGS.notifyOnExportComplete,
		};
	} catch {
		// JSON.parse 失敗や localStorage アクセス不可はすべて既定値扱い
		return DEFAULT_SETTINGS;
	}
}

function saveSettings(settings: AppSettings): void {
	try {
		window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// localStorage が使えない環境では永続化を諦める(その場の動作は継続)
	}
}

interface SettingsContextValue {
	settings: AppSettings;
	updateSettings: (patch: Partial<AppSettings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

/** 設定の参照と部分更新。Provider 配下でのみ利用可。 */
export function useSettings(): SettingsContextValue {
	const ctx = useContext(SettingsContext);
	if (!ctx)
		throw new Error("useSettings は SettingsProvider の配下で使ってください。");
	return ctx;
}

/**
 * 設定の単一ソース。localStorage への永続化と、テーマの DOM への適用
 * (html 要素の `.dark` クラス付け外し)を担う。
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
	const [settings, setSettings] = useState<AppSettings>(loadSettings);

	const updateSettings = useCallback((patch: Partial<AppSettings>) => {
		setSettings((prev) => ({ ...prev, ...patch }));
	}, []);

	// 永続化は effect で行う(setState 更新関数を純粋に保つ)。初回マウント時にも
	// 走るため、壊れた保存値・部分的な保存値がマージ結果で正規化される副次効果がある。
	useEffect(() => {
		saveSettings(settings);
	}, [settings]);

	// テーマ適用: 解決結果に応じて html の `.dark` クラスを付け外しする。
	// "system" 選択中のみ OS 設定の変更(matchMedia change)を購読して追従する。
	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = () => {
			const resolved = resolveTheme(settings.theme, media.matches);
			document.documentElement.classList.toggle("dark", resolved === "dark");
		};
		apply();
		if (settings.theme !== "system") return;
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [settings.theme]);

	const value = useMemo(
		() => ({ settings, updateSettings }),
		[settings, updateSettings],
	);

	return (
		<SettingsContext.Provider value={value}>
			{children}
		</SettingsContext.Provider>
	);
}
