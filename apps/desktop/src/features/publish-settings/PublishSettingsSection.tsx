import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { getErrorMessage } from "../../lib/getErrorMessage";
import {
	deleteSchedulerApiToken,
	setSchedulerApiToken,
} from "./publishSettingsClient";
import { loadSchedulerUrl, saveSchedulerUrl } from "./schedulerUrlStore";
import { usePublishGate, type PublishGateResult } from "./usePublishGate";

/**
 * 設定ダイアログに差し込む「公開連携」セクション(private エディション専用、§entry.ts)。
 *
 * scheduler の URL(秘密ではないため localStorage、§schedulerUrlStore.ts)と API
 * トークン(秘密のため OS キーチェーン、§publishSettingsClient.ts /
 * src-tauri/src/commands/publish/)を設定し、疎通チェックの結果を表示する。
 * 実際の投稿機能(IG/YouTube)は Phase 3 本体(後続 PR)で実装する — ここは設定 UI と
 * 実行時ゲート(usePublishGate)の土台のみ。
 *
 * トークンは type="password" で入力し、保存後は値を再表示しない(保存済みバッジ +
 * 削除ボタンのみ表示する。§実装方針)。
 */
export function PublishSettingsSection() {
	const [schedulerUrl, setSchedulerUrlInput] = useState(() => loadSchedulerUrl());
	const [tokenInput, setTokenInput] = useState("");
	const [savingToken, setSavingToken] = useState(false);
	const [tokenError, setTokenError] = useState<string | null>(null);
	const [deletingToken, setDeletingToken] = useState(false);
	const gate = usePublishGate();

	const handleSaveUrl = () => {
		saveSchedulerUrl(schedulerUrl.trim());
		void gate.recheck();
	};

	const handleSaveToken = async () => {
		const trimmed = tokenInput.trim();
		if (!trimmed) return;
		setSavingToken(true);
		setTokenError(null);
		try {
			await setSchedulerApiToken(trimmed);
			setTokenInput("");
			await gate.recheck();
		} catch (err) {
			setTokenError(getErrorMessage(err));
		} finally {
			setSavingToken(false);
		}
	};

	const handleDeleteToken = async () => {
		setDeletingToken(true);
		setTokenError(null);
		try {
			await deleteSchedulerApiToken();
			await gate.recheck();
		} catch (err) {
			setTokenError(getErrorMessage(err));
		} finally {
			setDeletingToken(false);
		}
	};

	return (
		<section className="flex flex-col gap-3">
			<h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
				公開連携(Private)
			</h3>
			<p className="text-[11px] text-neutral-400">
				scheduler の URL と API トークンを設定し、疎通チェックが成功すると投稿機能が有効になります
				(実際の投稿処理は今後のアップデートで対応予定です)。
			</p>

			<div className="flex flex-col gap-1.5">
				<span className="text-[11px] text-neutral-400">scheduler URL</span>
				<div className="flex items-center gap-2">
					<input
						type="text"
						aria-label="scheduler URL"
						value={schedulerUrl}
						onChange={(e) => setSchedulerUrlInput(e.target.value)}
						placeholder="https://your-scheduler.example.workers.dev"
						className="h-8 min-w-0 flex-1 rounded-md border border-line bg-elevated px-2 font-mono text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
					/>
					<Button
						size="sm"
						variant="secondary"
						aria-label="scheduler URLを保存"
						onClick={handleSaveUrl}
					>
						保存
					</Button>
				</div>
			</div>

			<div className="flex flex-col gap-1.5">
				<span className="text-[11px] text-neutral-400">APIトークン</span>
				{gate.hasToken ? (
					<div className="flex items-center gap-2">
						<span className="rounded-md border border-line bg-elevated px-2 py-1.5 text-[11px] text-neutral-300">
							保存済み
						</span>
						<Button
							size="sm"
							variant="ghost"
							disabled={deletingToken}
							onClick={() => void handleDeleteToken()}
						>
							{deletingToken ? "削除中…" : "削除"}
						</Button>
					</div>
				) : (
					<div className="flex items-center gap-2">
						<input
							type="password"
							aria-label="APIトークン"
							value={tokenInput}
							onChange={(e) => setTokenInput(e.target.value)}
							placeholder="トークンを入力"
							className="h-8 min-w-0 flex-1 rounded-md border border-line bg-elevated px-2 font-mono text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
						/>
						<Button
							size="sm"
							variant="secondary"
							aria-label="APIトークンを保存"
							disabled={savingToken || !tokenInput.trim()}
							onClick={() => void handleSaveToken()}
						>
							{savingToken ? "保存中…" : "保存"}
						</Button>
					</div>
				)}
				{tokenError && <span className="text-[11px] text-danger">{tokenError}</span>}
			</div>

			<div className="flex items-center gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={gate.checking}
					onClick={() => void gate.recheck()}
				>
					{gate.checking ? "疎通チェック中…" : "疎通チェック"}
				</Button>
				<GateStatusText result={gate.lastResult} ready={gate.ready} />
			</div>
		</section>
	);
}

function GateStatusText({
	result,
	ready,
}: {
	result: PublishGateResult | null;
	ready: boolean;
}) {
	if (!result) {
		return <span className="text-[11px] text-neutral-400">未確認</span>;
	}
	if (ready) {
		return <span className="text-[11px] text-emerald-500">接続OK</span>;
	}
	switch (result.status) {
		case "no_url":
			return (
				<span className="text-[11px] text-neutral-400">scheduler URL 未設定</span>
			);
		case "no_token":
			return <span className="text-[11px] text-neutral-400">トークン未設定</span>;
		case "unauthorized":
			return (
				<span className="text-[11px] text-danger">
					認証エラー(トークンが一致しません)
				</span>
			);
		case "service_unavailable":
			return (
				<span className="text-[11px] text-danger">
					scheduler 側が未設定です(503)
				</span>
			);
		case "unreachable":
			return (
				<span className="text-[11px] text-danger">到達不可: {result.detail}</span>
			);
		case "unexpected_status":
			return (
				<span className="text-[11px] text-danger">
					想定外の応答です({result.code})
				</span>
			);
		case "ok":
			// ready=true 側で処理済みなのでここには到達しない想定だが、型の網羅性のため残す。
			return <span className="text-[11px] text-emerald-500">接続OK</span>;
		default:
			return null;
	}
}
