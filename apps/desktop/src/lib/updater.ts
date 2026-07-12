import { useCallback, useEffect, useRef, useState } from "react";
import {
	check as tauriCheck,
	type DownloadEvent,
	type Update,
} from "@tauri-apps/plugin-updater";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";

/**
 * 自動更新(Phase 4 Wave C)。起動時に `check()` を一度だけ呼び、更新が見つかれば
 * アプリ内バナー(`features/update/UpdateNotification.tsx`)へ状態を渡す。
 *
 * 初回リリース前は latest.json が存在せず 404 になる。pubkey も鍵生成前は
 * `TODO_REPLACE_WITH_UPDATER_PUBKEY`(§tauri.conf.json)のプレースホルダのままで、
 * 実際の更新が見つかった場合の署名検証は失敗しうる。いずれのエラーも
 * **黙って無視する**(ログのみ・UI には一切出さない)— 初回 publish 前や鍵未設定の
 * 状態を「更新確認に失敗した異常系」として利用者に見せないため。
 */

/** 更新の進行状態。"error" は UI に出さない(ログ用途のみ)。 */
export type UpdateStatus =
	| "idle"
	| "available"
	| "downloading"
	| "ready"
	| "error";

export interface UpdateCheckerState {
	status: UpdateStatus;
	/** 見つかった更新のバージョン("available" 以降のみ)。 */
	version?: string;
	/** リリースノート(あれば)。 */
	body?: string;
	/** ダウンロード進捗(バイト数)。合計サイズが取得できない場合 total は undefined。 */
	progress?: { downloaded: number; total?: number };
	/** ダウンロード/インストール失敗時のメッセージ("error" のときのみ)。 */
	error?: string;
	/** ダウンロード+インストールを開始する("available" のときのみ意味がある)。 */
	download: () => void;
	/** 「後で」— 同一 version を 24h 抑制して非表示にする。 */
	dismiss: () => void;
	/** ダウンロード済みの更新を適用してアプリを再起動する("ready" のときのみ意味がある)。 */
	restart: () => void;
}

export interface UpdateCheckerOptions {
	/** `check()` の差し替え(テスト用)。既定は実プラグインの `check`。 */
	check?: () => Promise<Update | null>;
	/** `relaunch()` の差し替え(テスト用)。既定は実プラグインの `relaunch`。 */
	relaunch?: () => Promise<void>;
	/** 現在時刻の差し替え(テスト用、24h 抑制の判定に使う)。既定は `Date.now`。 */
	now?: () => number;
}

const SNOOZE_STORAGE_KEY = "facet.desktop.update.snooze";
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;

interface SnoozeRecord {
	version: string;
	snoozedAt: number;
}

function loadSnooze(): SnoozeRecord | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = window.localStorage.getItem(SNOOZE_STORAGE_KEY);
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		if (
			typeof obj.version === "string" &&
			typeof obj.snoozedAt === "number" &&
			Number.isFinite(obj.snoozedAt)
		) {
			return { version: obj.version, snoozedAt: obj.snoozedAt };
		}
		return null;
	} catch {
		return null;
	}
}

function saveSnooze(record: SnoozeRecord): void {
	try {
		window.localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(record));
	} catch {
		// localStorage が使えない環境では永続化を諦める(セッション内は再通知しない)。
	}
}

/** version が snooze 済みかつ 24h 未経過なら true(= 通知を抑制する)。新 version は常に false。 */
function isSnoozed(version: string, now: number): boolean {
	const snooze = loadSnooze();
	if (!snooze || snooze.version !== version) return false;
	return now - snooze.snoozedAt < SNOOZE_DURATION_MS;
}

/**
 * 起動時に一度だけ更新確認を行うフック。App.tsx から一箇所だけマウントする想定
 * (複数箇所で使うと `check()` が複数回走る)。
 */
export function useUpdateChecker(
	options: UpdateCheckerOptions = {},
): UpdateCheckerState {
	const { check = tauriCheck, relaunch = tauriRelaunch, now = Date.now } =
		options;

	const [status, setStatus] = useState<UpdateStatus>("idle");
	const [version, setVersion] = useState<string>();
	const [body, setBody] = useState<string>();
	const [progress, setProgress] = useState<{
		downloaded: number;
		total?: number;
	}>();
	const [error, setError] = useState<string>();

	// 実プラグインの Update リソース(download/install に使う)。state には入れない
	// (シリアライズ不要・レンダーに影響しないため ref で保持)。
	const updateRef = useRef<Update | null>(null);
	// StrictMode の二重実行や再マウントで check() を二重に走らせないためのガード。
	const checkedRef = useRef(false);

	useEffect(() => {
		if (checkedRef.current) return;
		checkedRef.current = true;

		void (async () => {
			try {
				const update = await check();
				if (!update) return; // 更新なし(204 相当)。
				if (isSnoozed(update.version, now())) return; // 同一 version の 24h 抑制。
				updateRef.current = update;
				setVersion(update.version);
				setBody(update.body);
				setStatus("available");
			} catch (err) {
				// 404(初回 publish 前)・ネットワークエラー・署名検証失敗などはすべて黙殺する。
				// status は内部記録として "error" にするが、UpdateNotification は
				// "idle"/"error" の両方で何も描画しない(UI には一切出さない)。
				const message = err instanceof Error ? err.message : String(err);
				console.error("[updater] check() failed (ignored):", err);
				setStatus("error");
				setError(message);
			}
		})();
	}, [check, now]);

	const download = useCallback(() => {
		const update = updateRef.current;
		if (!update) return;
		setStatus("downloading");
		setProgress({ downloaded: 0 });
		void update
			.downloadAndInstall((event: DownloadEvent) => {
				switch (event.event) {
					case "Started":
						setProgress({ downloaded: 0, total: event.data.contentLength });
						break;
					case "Progress":
						setProgress((prev) => ({
							downloaded: (prev?.downloaded ?? 0) + event.data.chunkLength,
							total: prev?.total,
						}));
						break;
					case "Finished":
						break;
				}
			})
			.then(() => {
				setStatus("ready");
			})
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				setStatus("error");
				setError(message);
			});
	}, []);

	const dismiss = useCallback(() => {
		if (version) saveSnooze({ version, snoozedAt: now() });
		setStatus("idle");
	}, [version, now]);

	const restart = useCallback(() => {
		void relaunch();
	}, [relaunch]);

	return { status, version, body, progress, error, download, dismiss, restart };
}
