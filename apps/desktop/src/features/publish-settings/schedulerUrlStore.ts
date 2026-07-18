/**
 * scheduler の URL の永続化。
 *
 * 旧実装は localStorage に保存し、renderer が invoke 引数として都度 Rust 側へ渡していた。
 * この構造は WebView が侵害された場合、Bearer トークンの送信先(scheduler_url)を
 * 任意ホストへ差し替えられてしまう(confused deputy, GHSA-j74q-9v5x-87w3)。
 *
 * 対策として、送信先は Rust 側の保存値(OS キーチェーン、
 * `src-tauri/src/commands/publish/mod.rs` の `KEY_SCHEDULER_URL`)からのみ導出する
 * 構造に変えた。renderer は invoke 経由でしか読み書きしない
 * (`set_scheduler_url`/`get_scheduler_url`/`delete_scheduler_url`)。URL 自体は秘密
 * 情報ではないため、値をそのまま取得する API を用意してよい(トークンとは異なる扱い、
 * §publishSettingsClient.ts)。
 */

import { invoke } from "@tauri-apps/api/core";

/** 旧実装(localStorage)のキー。移行専用に残す(下記 `getSchedulerUrl` 参照)。 */
const LEGACY_STORAGE_KEY = "facet.desktop.private.schedulerUrl";

/**
 * 保存済みの scheduler URL を返す。未設定・取得不可なら空文字列。
 *
 * **一回性の移行**: Rust 側が未設定 かつ 旧 localStorage キーに値が残っている場合、
 * その値を `set_scheduler_url` で保存しようと試みる。保存に成功すれば localStorage の
 * キーを削除してその値を返す。保存が失敗した(不正 URL 等)場合もキーだけは削除し
 * (無効な値を保持し続けても意味がないため)、空文字列を返す。
 *
 * 移行はゲートの初回チェック前に必ず走る — `usePublishGate.recheck()` が疎通チェックの
 * 前にこの関数を await するため、設定ダイアログを開かない既存ユーザーでもアプリ起動時に
 * 移行される(§usePublishGate.ts)。多重呼び出しされても2回目以降は旧キーが消えている
 * ため no-op で安全。
 */
export async function getSchedulerUrl(): Promise<string> {
	const stored = await invoke<string | null>("get_scheduler_url");
	if (stored) return stored;

	const legacy = readLegacyUrl();
	if (!legacy) return "";
	try {
		await invoke<void>("set_scheduler_url", { url: legacy });
		removeLegacyUrl();
		return legacy;
	} catch {
		removeLegacyUrl();
		return "";
	}
}

/** scheduler URL を保存する。空文字列は「未設定」として扱い、保存済み値を削除する。 */
export async function setSchedulerUrl(url: string): Promise<void> {
	if (url) {
		await invoke<void>("set_scheduler_url", { url });
	} else {
		await invoke<void>("delete_scheduler_url");
	}
}

function readLegacyUrl(): string {
	if (typeof window === "undefined") return "";
	try {
		return window.localStorage.getItem(LEGACY_STORAGE_KEY) ?? "";
	} catch {
		return "";
	}
}

function removeLegacyUrl(): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.removeItem(LEGACY_STORAGE_KEY);
	} catch {
		// localStorage が使えない環境では何もしない。
	}
}
