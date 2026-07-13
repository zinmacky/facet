import { useCallback, useEffect, useState } from "react";
import {
	checkSchedulerConnection,
	hasSchedulerApiToken,
	type ConnectionCheckResult,
} from "./publishSettingsClient";
import { loadSchedulerUrl } from "./schedulerUrlStore";

/**
 * `ConnectionCheckResult` に、フロント側のみで判定できる「URL 未設定」を加えた
 * 表示用の結果型。Rust 側には URL を渡していない(=疎通チェック自体を実行していない)
 * ケースを区別するため。
 */
export type PublishGateResult = ConnectionCheckResult | { status: "no_url" };

export interface PublishGateState {
	/** 「設定が保存済み(URL + トークン)かつ疎通チェック成功」のときのみ true。 */
	ready: boolean;
	/** 疎通チェック実行中。 */
	checking: boolean;
	/** トークンがキーチェーンに保存済みか。 */
	hasToken: boolean;
	/** 直近のチェック結果(初回チェック完了前は null)。 */
	lastResult: PublishGateResult | null;
	/** 設定を保存した直後などに手動で再チェックする。 */
	recheck: () => Promise<void>;
}

/**
 * 実行時ゲート(docs/desktop-migration-plan.md §6.6・§11-3)。
 *
 * 「設定(scheduler URL + API トークン)が保存済みかつ疎通チェック成功」の場合のみ
 * `ready: true` を返す。直接呼ばず `PublishGateContext`(`usePublishGateContext`)経由で
 * 使うこと — 以前は `PublishSettingsSection` と `UploadScreen` が独立にこのフックを
 * 呼んでいたため疎通チェックが二重発火していた(§PublishGateContext.tsx 冒頭コメント)。
 * IG 投稿の実行時ゲートは、これに加えて R2 資格情報の保存状態も必要
 * (`PublishGateContext.igReady`)。
 *
 * マウント時に自動で一度チェックする(設定 UI を開いていない間もアプリ起動直後の
 * 状態を把握できるようにする)。
 */
export function usePublishGate(): PublishGateState {
	const [ready, setReady] = useState(false);
	const [checking, setChecking] = useState(false);
	const [hasToken, setHasToken] = useState(false);
	const [lastResult, setLastResult] = useState<PublishGateResult | null>(null);

	const recheck = useCallback(async () => {
		setChecking(true);
		try {
			const tokenSaved = await hasSchedulerApiToken();
			setHasToken(tokenSaved);

			const url = loadSchedulerUrl();
			if (!url) {
				setReady(false);
				setLastResult({ status: "no_url" });
				return;
			}
			if (!tokenSaved) {
				setReady(false);
				setLastResult({ status: "no_token" });
				return;
			}

			const result = await checkSchedulerConnection(url);
			setLastResult(result);
			setReady(result.status === "ok");
		} catch {
			// invoke 自体が失敗した(Tauri 実行環境外・予期しない例外等)場合も、
			// ゲートは安全側(false)に倒す。
			setReady(false);
			setLastResult({
				status: "unreachable",
				detail: "疎通チェックに失敗しました。",
			});
		} finally {
			setChecking(false);
		}
	}, []);

	useEffect(() => {
		void recheck();
	}, [recheck]);

	return { ready, checking, hasToken, lastResult, recheck };
}
