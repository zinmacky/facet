/**
 * scheduler の URL の永続化(localStorage)。
 *
 * URL 自体は秘密情報ではない(Bearer トークンと違い、これ単体で scheduler を
 * 操作できるわけではない)ため OS キーチェーンには置かず、`lib/settings.tsx` と
 * 同じ localStorage パターンに素直に乗せる(§docs/desktop-migration-plan.md §11-3、
 * 保管場所の設計判断は最終報告に明記)。
 *
 * `lib/settings.tsx` の `AppSettings` へは追加しない — この設定は public エディションの
 * バンドルから物理除外する対象(features/publish-settings/、virtual:publish-settings-entry)
 * であり、`AppSettings` は public/private 共通でロードされる共有モジュールのため、
 * 概念上もファイル構成上もここに閉じておく。
 */

const STORAGE_KEY = "facet.desktop.private.schedulerUrl";

/** 保存済みの scheduler URL。未設定・取得不可なら空文字列。 */
export function loadSchedulerUrl(): string {
	if (typeof window === "undefined") return "";
	try {
		return window.localStorage.getItem(STORAGE_KEY) ?? "";
	} catch {
		return "";
	}
}

/** scheduler URL を保存する。空文字列は「未設定」として扱い、キー自体を削除する。 */
export function saveSchedulerUrl(url: string): void {
	try {
		if (url) {
			window.localStorage.setItem(STORAGE_KEY, url);
		} else {
			window.localStorage.removeItem(STORAGE_KEY);
		}
	} catch {
		// localStorage が使えない環境では永続化を諦める(settings.tsx と同じ方針)。
	}
}
