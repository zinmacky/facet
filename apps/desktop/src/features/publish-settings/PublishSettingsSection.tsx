import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { getErrorMessage } from "../../lib/getErrorMessage";
import { usePublishGateContext } from "./PublishGateContext";
import {
	deleteR2Credentials,
	deleteSchedulerApiToken,
	setR2Credentials,
	setSchedulerApiToken,
} from "./publishSettingsClient";
import { loadSchedulerUrl, saveSchedulerUrl } from "./schedulerUrlStore";
import type { PublishGateResult } from "./usePublishGate";

/** R2 バケット名の既定値(Rust 側 `r2_credentials::DEFAULT_BUCKET` と同じ値)。 */
const DEFAULT_R2_BUCKET = "facet-media";

/**
 * 設定ダイアログに差し込む「公開連携」セクション(private エディション専用、§entry.ts)。
 *
 * scheduler の URL(秘密ではないため localStorage、§schedulerUrlStore.ts)・API
 * トークン・R2(Cloudflare, S3 互換)資格情報(いずれも秘密のため OS キーチェーン、
 * §publishSettingsClient.ts / src-tauri/src/commands/publish/)を設定し、疎通チェックの
 * 結果を表示する。「scheduler 疎通 OK かつ R2 資格情報保存済み」で IG 投稿が有効になる
 * (`PublishGateContext.igReady`、`features/upload/usePublishExtras.tsx` 参照)。
 *
 * トークン・シークレットは type="password" で入力し、保存後は値を再表示しない
 * (保存済みバッジ + 削除ボタンのみ表示する。§実装方針)。
 */
export function PublishSettingsSection() {
	const [schedulerUrl, setSchedulerUrlInput] = useState(() => loadSchedulerUrl());
	const [tokenInput, setTokenInput] = useState("");
	const [savingToken, setSavingToken] = useState(false);
	const [tokenError, setTokenError] = useState<string | null>(null);
	const [deletingToken, setDeletingToken] = useState(false);
	const gate = usePublishGateContext();

	// R2 資格情報フォーム(4フィールドまとめて保存/削除、§r2_credentials.rs)。
	const [r2AccountId, setR2AccountId] = useState("");
	const [r2AccessKeyId, setR2AccessKeyId] = useState("");
	const [r2SecretAccessKey, setR2SecretAccessKey] = useState("");
	const [r2Bucket, setR2Bucket] = useState(DEFAULT_R2_BUCKET);
	const [savingR2, setSavingR2] = useState(false);
	const [r2Error, setR2Error] = useState<string | null>(null);
	const [deletingR2, setDeletingR2] = useState(false);

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

	const handleSaveR2 = async () => {
		setSavingR2(true);
		setR2Error(null);
		try {
			await setR2Credentials({
				accountId: r2AccountId.trim(),
				accessKeyId: r2AccessKeyId.trim(),
				secretAccessKey: r2SecretAccessKey.trim(),
				bucket: r2Bucket.trim(),
			});
			setR2AccountId("");
			setR2AccessKeyId("");
			setR2SecretAccessKey("");
			setR2Bucket(DEFAULT_R2_BUCKET);
			await gate.recheckR2Credentials();
		} catch (err) {
			setR2Error(getErrorMessage(err));
		} finally {
			setSavingR2(false);
		}
	};

	const handleDeleteR2 = async () => {
		setDeletingR2(true);
		setR2Error(null);
		try {
			await deleteR2Credentials();
			await gate.recheckR2Credentials();
		} catch (err) {
			setR2Error(getErrorMessage(err));
		} finally {
			setDeletingR2(false);
		}
	};

	return (
		<section className="flex flex-col gap-3">
			<h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
				公開連携(Private)
			</h3>
			<p className="text-[11px] text-neutral-400">
				scheduler の URL・API トークン・R2 資格情報を設定し、疎通チェックが成功すると
				Instagram への投稿が有効になります。
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

			<div className="flex flex-col gap-1.5 border-t border-line pt-3">
				<span className="text-[11px] text-neutral-400">
					R2(Cloudflare)資格情報
				</span>
				{gate.hasR2Credentials ? (
					<div className="flex items-center gap-2">
						<span className="rounded-md border border-line bg-elevated px-2 py-1.5 text-[11px] text-neutral-300">
							保存済み
						</span>
						<Button
							size="sm"
							variant="ghost"
							disabled={deletingR2}
							onClick={() => void handleDeleteR2()}
						>
							{deletingR2 ? "削除中…" : "削除"}
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						<input
							type="text"
							aria-label="R2アカウントID"
							value={r2AccountId}
							onChange={(e) => setR2AccountId(e.target.value)}
							placeholder="アカウント ID"
							className="h-8 rounded-md border border-line bg-elevated px-2 font-mono text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
						/>
						<input
							type="text"
							aria-label="R2アクセスキーID"
							value={r2AccessKeyId}
							onChange={(e) => setR2AccessKeyId(e.target.value)}
							placeholder="アクセスキー ID"
							className="h-8 rounded-md border border-line bg-elevated px-2 font-mono text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
						/>
						<input
							type="password"
							aria-label="R2シークレットアクセスキー"
							value={r2SecretAccessKey}
							onChange={(e) => setR2SecretAccessKey(e.target.value)}
							placeholder="シークレットアクセスキー"
							className="h-8 rounded-md border border-line bg-elevated px-2 font-mono text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
						/>
						<input
							type="text"
							aria-label="R2バケット名"
							value={r2Bucket}
							onChange={(e) => setR2Bucket(e.target.value)}
							placeholder={DEFAULT_R2_BUCKET}
							className="h-8 rounded-md border border-line bg-elevated px-2 font-mono text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
						/>
						<div className="flex justify-end">
							<Button
								size="sm"
								variant="secondary"
								aria-label="R2資格情報を保存"
								disabled={
									savingR2 ||
									!r2AccountId.trim() ||
									!r2AccessKeyId.trim() ||
									!r2SecretAccessKey.trim()
								}
								onClick={() => void handleSaveR2()}
							>
								{savingR2 ? "保存中…" : "保存"}
							</Button>
						</div>
					</div>
				)}
				{r2Error && <span className="text-[11px] text-danger">{r2Error}</span>}
			</div>

			<p className="text-[11px] text-neutral-400">
				Instagram への投稿:{" "}
				{gate.igReady ? (
					<span className="text-emerald-500">有効</span>
				) : (
					<span>
						未設定(scheduler の疎通確認と R2 資格情報の両方が必要です)
					</span>
				)}
			</p>
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
