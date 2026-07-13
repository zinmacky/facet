import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
	type ReactNode,
} from "react";
import { hasR2Credentials } from "./publishSettingsClient";
import { usePublishGate, type PublishGateState } from "./usePublishGate";

/**
 * `usePublishGate`(scheduler URL + API トークンの疎通ゲート)+ R2 資格情報の
 * 保存状態を1つのインスタンスに集約して共有する Context。
 *
 * **前 PR(#85)からの申し送り事項の解消**: 以前は `PublishSettingsSection` と
 * `UploadScreen` がそれぞれ独立に `usePublishGate()` を呼んでおり、両方が
 * マウントされている間(設定ダイアログを開いた状態でリフレーム画面にいる等)は
 * `has_scheduler_api_token`/`check_scheduler_connection` が2重に発火していた。
 * 本 Provider を `App.tsx` で1回だけマウントし、両コンポーネントは
 * `usePublishGateContext()` 経由で同じ状態を読むことでこれを解消する。
 *
 * R2 資格情報の状態もここに集約する(IG 投稿の実行時ゲートは
 * 「scheduler 疎通 OK **かつ** R2 資格情報が保存済み」の両方が必要なため、§igReady)。
 */
export interface PublishGateContextValue extends PublishGateState {
	/** R2 資格情報がキーチェーンに保存済みか。 */
	hasR2Credentials: boolean;
	/** R2 資格情報の保存状態を再チェックする(設定画面で保存/削除した直後に呼ぶ)。 */
	recheckR2Credentials: () => Promise<void>;
	/**
	 * IG(Instagram)投稿の実行時ゲート。「scheduler 疎通 OK(`ready`)かつ R2 資格情報
	 * 保存済み(`hasR2Credentials`)」の両方を満たす場合のみ true
	 * (`features/upload/uploadTypes.ts` の `INSTAGRAM_PUBLISH_SUPPORTED` と組み合わせて
	 * 投稿ボタンの活性化条件に使う)。
	 */
	igReady: boolean;
}

const PublishGateContext = createContext<PublishGateContextValue | null>(null);

export function PublishGateProvider({ children }: { children: ReactNode }) {
	const gate = usePublishGate();
	const [hasR2, setHasR2] = useState(false);

	const recheckR2Credentials = useCallback(async () => {
		try {
			setHasR2(await hasR2Credentials());
		} catch {
			// invoke 自体が失敗した場合も安全側(false)に倒す(usePublishGate と同じ方針)。
			setHasR2(false);
		}
	}, []);

	useEffect(() => {
		void recheckR2Credentials();
	}, [recheckR2Credentials]);

	const value: PublishGateContextValue = {
		...gate,
		hasR2Credentials: hasR2,
		recheckR2Credentials,
		igReady: gate.ready && hasR2,
	};

	return (
		<PublishGateContext.Provider value={value}>
			{children}
		</PublishGateContext.Provider>
	);
}

/**
 * `PublishGateProvider` 配下でのみ呼べる。private エディション専用のコンポーネント
 * (`UploadScreen`/`PublishSettingsSection`、いずれも edition alias で public バンドル
 * からは物理的に除外される)からのみ使う想定のため、Provider 外での呼び出しは
 * バグとして即座に気付けるよう例外を投げる(サイレントなフォールバック値は返さない)。
 */
export function usePublishGateContext(): PublishGateContextValue {
	const ctx = useContext(PublishGateContext);
	if (!ctx) {
		throw new Error(
			"usePublishGateContext は PublishGateProvider の内側でのみ使用できます。",
		);
	}
	return ctx;
}
