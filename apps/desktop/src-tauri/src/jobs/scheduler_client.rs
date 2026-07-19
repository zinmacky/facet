//! `POST /jobs`(scheduler へのジョブ登録)。旧 TS 実装(削除済み)
//! (`apps/studio/server/src/services/scheduler-client.ts` の後半)+
//! `packages/contract` の `jobManifest`/`jobCreateResponse` に対応する。
//!
//! Bearer トークン認証は `commands::publish::scheduler_check` が疎通チェックで
//! 使っているものと同じ scheduler(PR #83 でマージ済み)を相手にする。エラー分類も
//! 同モジュールの `ConnectionCheckResult` と同じ考え方(401=トークン不正、
//! 503=scheduler 未設定)を踏襲する。

use std::time::Duration;

use media_core::CancelToken;
use reqwest::{Client, StatusCode, Url};
use thiserror::Error;
use url::Host;

use super::manifest::{JobCreateResponse, JobManifest, JobRecord};
use super::r2_upload::wait_for_cancel;

/// `enqueue_job` の 1 リクエストあたりの上限時間。scheduler が無応答でも
/// これを超えたら Network エラーとして打ち切る。共有 `reqwest::Client` には
/// タイムアウトを設定しない(R2 アップロードは長時間かつ協調キャンセルで別管理の
/// ため)ので、enqueue だけリクエスト単位で縛る。無指定だと scheduler の無応答で
/// `run_ig_publish` タスクが完走せず、`JobGuard` も走らずジョブがキャンセル不能の
/// まま残る(GHSA-q37v-7xpp-x229)。`scheduler_check::REQUEST_TIMEOUT`(10s)より
/// 緩め: enqueue は R2 アップロード後の一発 POST で Workers のコールドスタートを
/// 含みうる。
pub const ENQUEUE_TIMEOUT: Duration = Duration::from_secs(30);

/// `fetch_job`(`GET /jobs/:id`)の1リクエストあたりの上限時間。desktop が IG 予約投稿の
/// 最終成否を追跡しない問題(アーキテクチャレビュー指摘)への対応で追加した。
/// `commands::publish::scheduler_check::REQUEST_TIMEOUT`(疎通チェック、10秒)と同じ値に
/// 揃える — こちらも `enqueue_job` のような長時間処理(R2 アップロード後の一発 POST)では
/// なく、単発の軽い GET のため。
pub const FETCH_JOB_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Error)]
pub enum EnqueueError {
	/// Bearer トークンが scheduler 側と一致しない(401)。
	#[error("scheduler の API トークンが無効です。")]
	Unauthorized,
	/// scheduler 側で `SCHEDULER_API_TOKEN` が未設定(503, fail-closed)。
	#[error("scheduler が未設定です(503)。")]
	ServiceUnavailable,
	/// manifest が scheduler 側のバリデーションで拒否された(400 等)。通常は
	/// Rust 側の contract 実装が正しければ発生しないが、scheduler 側の仕様変更に
	/// 備えて区別する。
	#[error("scheduler にジョブ登録を拒否されました: {0}")]
	Rejected(String),
	/// 接続不可・タイムアウト・応答の解析失敗等。
	#[error("scheduler への通信に失敗しました: {0}")]
	Network(String),
	/// `ig_publish_cancel` によるキャンセル(`jobs::r2_upload::upload_file` と同じ
	/// `tokio::select!` でのレース、GHSA-q37v-7xpp-x229 残作業対応)。
	#[error("キャンセルされました")]
	Cancelled,
}

/// [`fetch_job`] のエラー分類。[`EnqueueError`] と同じ考え方(401/503/network)に
/// 加え、`GET /jobs/:id` 固有の 404(ジョブ未存在)を持つ。`enqueue_job` と異なり
/// キャンセル対象になる長時間処理ではないため `Cancelled` は無い。
#[derive(Debug, Error)]
pub enum FetchJobError {
	/// Bearer トークンが scheduler 側と一致しない(401)。
	#[error("scheduler の API トークンが無効です。")]
	Unauthorized,
	/// scheduler 側で `SCHEDULER_API_TOKEN` が未設定(503, fail-closed)。
	#[error("scheduler が未設定です(503)。")]
	ServiceUnavailable,
	/// 指定した job_id のジョブが scheduler 側に存在しない(404)。
	#[error("指定されたジョブが見つかりません。")]
	NotFound,
	/// 接続不可・タイムアウト・応答の解析失敗・想定外のステータスコード等。
	#[error("scheduler への通信に失敗しました: {0}")]
	Network(String),
}

/// `base`(scheduler のベース URL)を http/https の絶対 URL として検証する。
///
/// GHSA-j74q-9v5x-87w3(confused deputy)対策: 送信先は Rust 側の保存値(キーチェーン)
/// からのみ導出する構造にした上で、さらにここで `http://` をループバック
/// (`127.0.0.1`/`::1`/`localhost`)限定にする。WebView が侵害され任意のホストを
/// 指定できたとしても、TLS を伴わない `http://` で外部ホストへ Bearer トークンが
/// 流出することを防ぐ(`https://` は任意ホストを許可する — 経路上の盗聴は TLS が防ぐ)。
pub fn parse_scheduler_base(base: &str) -> Result<Url, String> {
	let url =
		Url::parse(base.trim()).map_err(|_| "scheduler_url が不正な URL です。".to_string())?;
	match url.scheme() {
		"https" => Ok(url),
		"http" => {
			let is_loopback = match url.host() {
				Some(Host::Ipv4(addr)) => addr.is_loopback(),
				Some(Host::Ipv6(addr)) => addr.is_loopback(),
				Some(Host::Domain(domain)) => domain == "localhost",
				None => false,
			};
			if is_loopback {
				Ok(url)
			} else {
				Err("http:// はループバック(localhost)のみ許可されます。リモートの scheduler には https:// を使ってください。".to_string())
			}
		}
		_ => Err("scheduler_url は http/https のみ対応です。".to_string()),
	}
}

/// `base`(scheduler のベース URL)+ `/jobs` の URL を組み立てる。
/// `commands::publish::scheduler_check::join_path` と同じ考え方の小さな純関数だが、
/// `jobs` はビジネスロジック層・`commands` は invoke 境界層という層分けを保つため、
/// 依存方向を逆転させないよう独立に持つ(§`jobs` モジュール冒頭コメント参照)。
fn join_jobs_url(base: &str) -> Result<Url, String> {
	let mut url = parse_scheduler_base(base)?;
	let base_path = url.path().trim_end_matches('/');
	url.set_path(&format!("{base_path}/jobs"));
	Ok(url)
}

/// `manifest` を scheduler へ登録する。冪等性は `manifest.idempotency_key` により
/// scheduler 側(`apps/scheduler/src/routes/jobs.ts`)が担保する(同一キーの再送は
/// 既存ジョブをそのまま返す)。
///
/// `cancel` は `ig_publish_cancel` からのキャンセルを、リクエスト送信中(`send()` の
/// `.await`)にも反映させるために使う(GHSA-q37v-7xpp-x229 残作業対応)。旧実装は
/// このフェーズを素の `await` で待っていたため、`ENQUEUE_TIMEOUT`(30秒)いっぱいまで
/// キャンセルが反映されなかった。`jobs::r2_upload::upload_file` と同じ流儀で
/// `wait_for_cancel`(`CancelToken` を短間隔でポーリング)を `tokio::select!` の対抗馬に
/// 置く。ただし、レースするのはリクエスト送信フェーズのみで、成功応答の JSON
/// パース(`response.json()`)はレースしない(`upload_file` が `classify_response` を
/// レースしないのと同じ考え方 — 応答受信後の後処理は短時間で確実に終わる)。
///
/// **注意(半端な状態):** リクエストが scheduler に届いた「後」にキャンセルされた場合、
/// クライアント側は `Cancelled` を返すが、scheduler 側には既にジョブが登録されている
/// 可能性がある。`manifest.idempotency_key` は `job_id` から決定的に導出される
/// (`commands::publish::ig::derive_idempotency_key`)ため、呼び出し側が同じ job_id で
/// 再試行しても scheduler 側の冪等性により同一ジョブへ束ねられ、二重公開はしない。
pub async fn enqueue_job(
	client: &Client,
	scheduler_url: &str,
	token: &str,
	manifest: &JobManifest,
	timeout: Duration,
	cancel: &CancelToken,
) -> Result<JobCreateResponse, EnqueueError> {
	let url = join_jobs_url(scheduler_url).map_err(EnqueueError::Network)?;

	if cancel.is_cancelled() {
		return Err(EnqueueError::Cancelled);
	}

	let request = client
		.post(url)
		.bearer_auth(token)
		.json(manifest)
		.timeout(timeout)
		.send();

	let response = tokio::select! {
		() = wait_for_cancel(cancel) => Err(EnqueueError::Cancelled),
		result = request => result.map_err(|err| {
			if err.is_timeout() {
				EnqueueError::Network(format!(
					"scheduler が {} 秒以内に応答しませんでした。",
					timeout.as_secs()
				))
			} else {
				EnqueueError::Network(err.to_string())
			}
		}),
	}?;

	match response.status() {
		StatusCode::OK | StatusCode::CREATED => response
			.json::<JobCreateResponse>()
			.await
			.map_err(|err| EnqueueError::Network(format!("応答の解析に失敗しました: {err}"))),
		StatusCode::UNAUTHORIZED => Err(EnqueueError::Unauthorized),
		StatusCode::SERVICE_UNAVAILABLE => Err(EnqueueError::ServiceUnavailable),
		// 429(レート制限)は「再送しても同じ結果になる」恒久エラーではなく、時間を
		// 置けば成功しうる一時的な状態 — 下の `is_client_error` 一括処理(4xx→`Rejected`)
		// に含めると PR #128 が 5xx について修正したのと同じ「一時的な失敗が恒久エラーとして
		// ユーザーに表示される」バグになる(scheduler 側のレート制限が「拒否されました」と
		// 誤って伝わる)。`EnqueueError::ServiceUnavailable` は
		// `IgPublishRuntimeError::EnqueueServiceUnavailable`(「scheduler が未設定です」という
		// 設定不備向けの文言)に対応するため意味的に合わない。5xx と同じ再試行可能な
		// `Network`(`IgPublishRuntimeError::Network`、「通信に失敗しました」)に分類する。
		StatusCode::TOO_MANY_REQUESTS => {
			let detail = response.text().await.unwrap_or_default();
			Err(EnqueueError::Network(format!(
				"scheduler のレート制限に達しました: {detail}"
			)))
		}
		// 4xx(401・429 を除く)は manifest 自体が scheduler 側のバリデーションで拒否された
		// ケース — 再送しても同じ結果になるため恒久的な `Rejected` のまま。
		other if other.is_client_error() => {
			let detail = response.text().await.unwrap_or_default();
			Err(EnqueueError::Rejected(format!("{other}: {detail}")))
		}
		// 5xx(Cloudflare のゲートウェイエラー等)やその他の想定外ステータスは
		// scheduler 側の一時的な不調である可能性が高く、同じファイルの `fetch_job`
		// (281行目付近)の「想定外ステータス」フォールバックと同じく再試行可能な
		// `Network` に分類する(以前は恒久エラーの `Rejected` として扱っていたため、
		// 一時的な 502/504 でもリトライされずユーザーに「拒否された」と誤って
		// 伝わっていた)。
		other => {
			let detail = response.text().await.unwrap_or_default();
			Err(EnqueueError::Network(format!(
				"scheduler が予期しないステータスを返しました: {other}: {detail}"
			)))
		}
	}
}

/// `base`(scheduler のベース URL)+ `/jobs/<job_id>` の URL を組み立てる。
/// `join_jobs_url` と同じ考え方の純関数だが、`job_id` は renderer から invoke 引数
/// として渡ってくる値(`commands::publish::ig::job_status_impl` 参照)のため、パス
/// セグメントを混入させて意図しないパスへ誘導できないよう検証する(scheduler_url
/// 自体は既にキーチェーンの保存値のみを使う設計 — GHSA-j74q-9v5x-87w3 対応 —
/// のため、ここでの懸念は送信先ホストではなくパスのみ)。
///
/// 許可文字の allowlist(英数字・`-`・`_`)で検証する — scheduler が発行する job_id は
/// 実際には UUID 形式のみのため許容範囲を絞れる。`/` のみを拒否する denylist だと、
/// `.`/`..` のような dot セグメントが `Url::set_path` の正規化で意図しないパスへ
/// 畳まれる余地が残る(code review 指摘)ため、より狭い allowlist にした。
fn join_job_url(base: &str, job_id: &str) -> Result<Url, String> {
	let is_valid_job_id = !job_id.is_empty()
		&& job_id
			.chars()
			.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
	if !is_valid_job_id {
		return Err("job_id が不正です。".to_string());
	}
	let mut url = parse_scheduler_base(base)?;
	let base_path = url.path().trim_end_matches('/');
	url.set_path(&format!("{base_path}/jobs/{job_id}"));
	Ok(url)
}

/// `job_id`(scheduler が発行したジョブ ID。`JobCreateResponse.id`/`IgPublishDone.scheduler_job_id`)
/// の現在の状態を scheduler から取得する(`GET /jobs/:id`)。desktop が IG 予約投稿の
/// 最終成否を追跡しない問題(アーキテクチャレビュー指摘)への対応で追加した。
///
/// `enqueue_job` と異なり `CancelToken` を取らない — 呼び出し元
/// (`commands::publish::ig::job_status_impl`)は実行中ジョブの一部ではなく、
/// ポーリング/手動更新のたびに単発で呼ばれる軽い GET のため、協調キャンセルの対象に
/// なる長時間処理ではない。
pub async fn fetch_job(
	client: &Client,
	scheduler_url: &str,
	token: &str,
	job_id: &str,
	timeout: Duration,
) -> Result<JobRecord, FetchJobError> {
	let url = join_job_url(scheduler_url, job_id).map_err(FetchJobError::Network)?;

	let response = client
		.get(url)
		.bearer_auth(token)
		.timeout(timeout)
		.send()
		.await
		.map_err(|err| {
			if err.is_timeout() {
				FetchJobError::Network(format!(
					"scheduler が {} 秒以内に応答しませんでした。",
					timeout.as_secs()
				))
			} else {
				FetchJobError::Network(err.to_string())
			}
		})?;

	match response.status() {
		StatusCode::OK => response
			.json::<JobRecord>()
			.await
			.map_err(|err| FetchJobError::Network(format!("応答の解析に失敗しました: {err}"))),
		StatusCode::UNAUTHORIZED => Err(FetchJobError::Unauthorized),
		StatusCode::SERVICE_UNAVAILABLE => Err(FetchJobError::ServiceUnavailable),
		StatusCode::NOT_FOUND => Err(FetchJobError::NotFound),
		other => Err(FetchJobError::Network(format!(
			"想定外のステータスです: {other}"
		))),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::jobs::manifest;
	use std::io::{Read, Write};
	use std::net::TcpListener;

	// ---- parse_scheduler_base(純粋関数、ネットワーク不要) --------------------------
	// GHSA-j74q-9v5x-87w3: http はループバックのみ許可、https は任意ホスト許可。

	#[test]
	fn parse_scheduler_base_allows_http_ipv4_loopback() {
		assert!(parse_scheduler_base("http://127.0.0.1:8787").is_ok());
	}

	#[test]
	fn parse_scheduler_base_allows_http_localhost() {
		assert!(parse_scheduler_base("http://localhost:8787").is_ok());
	}

	#[test]
	fn parse_scheduler_base_allows_http_ipv6_loopback() {
		assert!(parse_scheduler_base("http://[::1]:8787").is_ok());
	}

	#[test]
	fn parse_scheduler_base_rejects_http_remote_host() {
		assert!(parse_scheduler_base("http://evil.example.com").is_err());
	}

	#[test]
	fn parse_scheduler_base_allows_https_remote_host() {
		assert!(parse_scheduler_base("https://evil.example.com").is_ok());
	}

	// ---- join_jobs_url(純粋関数、ネットワーク不要) ---------------------------------

	#[test]
	fn join_jobs_url_appends_jobs_segment() {
		let url = join_jobs_url("https://scheduler.example.workers.dev").unwrap();
		assert_eq!(url.as_str(), "https://scheduler.example.workers.dev/jobs");
	}

	#[test]
	fn join_jobs_url_normalizes_trailing_slash() {
		let url = join_jobs_url("https://scheduler.example.workers.dev/").unwrap();
		assert_eq!(url.as_str(), "https://scheduler.example.workers.dev/jobs");
	}

	#[test]
	fn join_jobs_url_rejects_invalid_url() {
		assert!(join_jobs_url("not a url").is_err());
	}

	// ---- enqueue_job(loopback 上の最小 HTTP サーバでモック) -----------------------
	// `scheduler_check.rs` の `spawn_mock_server` と同じ流儀: リクエスト本文は読み捨て、
	// 固定のレスポンスを1本返す使い捨てサーバ。

	fn spawn_mock_server(status_line: &'static str, body: &'static str) -> String {
		let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
		let addr = listener.local_addr().unwrap();
		std::thread::spawn(move || {
			if let Ok((mut stream, _)) = listener.accept() {
				let mut buf = [0u8; 4096];
				let _ = stream.read(&mut buf);
				let _ = stream.write_all(
					format!(
						"{status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
						body.len()
					)
					.as_bytes(),
				);
			}
		});
		format!("http://{addr}")
	}

	fn sample_manifest() -> JobManifest {
		manifest::new_job_manifest(
			"11111111-2222-3333-4444-555555555555".to_string(),
			"posts/2026-07-10/uuid.mp4".to_string(),
			"caption".to_string(),
			1_783_686_896_000,
		)
	}

	/// 応答を返さないサーバ(接続だけ受けて握ったまま)。タイムアウト検証用。
	fn spawn_stalling_server() -> String {
		let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
		let addr = listener.local_addr().unwrap();
		std::thread::spawn(move || {
			// accept した stream を drop せず保持し続けることで、クライアント側を
			// レスポンス待ちのまま吊るす。
			if let Ok((stream, _)) = listener.accept() {
				std::thread::sleep(Duration::from_secs(5));
				drop(stream);
			}
		});
		format!("http://{addr}")
	}

	/// 通常のモックテストで使う短いタイムアウト(本番既定は `ENQUEUE_TIMEOUT`)。
	const TEST_TIMEOUT: Duration = Duration::from_secs(5);

	#[tokio::test]
	async fn enqueue_job_returns_response_on_201() {
		let base = spawn_mock_server(
			"HTTP/1.1 201 Created",
			r#"{"id":"job-1","status":"pending"}"#,
		);
		let client = Client::new();
		let resp = enqueue_job(
			&client,
			&base,
			"valid-token",
			&sample_manifest(),
			TEST_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.unwrap();
		assert_eq!(resp.id, "job-1");
		assert_eq!(resp.status, "pending");
	}

	#[tokio::test]
	async fn enqueue_job_returns_response_on_200_idempotent_replay() {
		let base = spawn_mock_server("HTTP/1.1 200 OK", r#"{"id":"job-1","status":"pending"}"#);
		let client = Client::new();
		let resp = enqueue_job(
			&client,
			&base,
			"valid-token",
			&sample_manifest(),
			TEST_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.unwrap();
		assert_eq!(resp.id, "job-1");
	}

	#[tokio::test]
	async fn enqueue_job_unauthorized_on_401() {
		let base = spawn_mock_server("HTTP/1.1 401 Unauthorized", "{}");
		let client = Client::new();
		let err = enqueue_job(
			&client,
			&base,
			"wrong-token",
			&sample_manifest(),
			TEST_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.unwrap_err();
		assert!(matches!(err, EnqueueError::Unauthorized));
	}

	#[tokio::test]
	async fn enqueue_job_service_unavailable_on_503() {
		let base = spawn_mock_server("HTTP/1.1 503 Service Unavailable", "{}");
		let client = Client::new();
		let err = enqueue_job(
			&client,
			&base,
			"any-token",
			&sample_manifest(),
			TEST_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.unwrap_err();
		assert!(matches!(err, EnqueueError::ServiceUnavailable));
	}

	#[tokio::test]
	async fn enqueue_job_rejected_on_400() {
		let base = spawn_mock_server(
			"HTTP/1.1 400 Bad Request",
			r#"{"error":"invalid job manifest"}"#,
		);
		let client = Client::new();
		let err = enqueue_job(
			&client,
			&base,
			"any-token",
			&sample_manifest(),
			TEST_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.unwrap_err();
		assert!(matches!(err, EnqueueError::Rejected(_)));
	}

	#[tokio::test]
	async fn enqueue_job_rejected_on_422() {
		let base = spawn_mock_server(
			"HTTP/1.1 422 Unprocessable Entity",
			r#"{"error":"invalid job manifest"}"#,
		);
		let client = Client::new();
		let err = enqueue_job(
			&client,
			&base,
			"any-token",
			&sample_manifest(),
			TEST_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.unwrap_err();
		assert!(matches!(err, EnqueueError::Rejected(_)));
	}

	// 429(レート制限)は他の 4xx と異なり `Rejected`(恒久エラー)ではなく再試行可能な
	// `Network` に分類する(本 PR の対象: 429 が 401 以外の 4xx 一括処理に紛れ込み、
	// 「拒否されました」という恒久エラー文言でユーザーに誤って伝わっていた。5xx について
	// 同種の問題を修正した PR #128 と同じ考え方)。
	#[tokio::test]
	async fn enqueue_job_network_error_on_429() {
		let base = spawn_mock_server(
			"HTTP/1.1 429 Too Many Requests",
			r#"{"error":"rate limited"}"#,
		);
		let client = Client::new();
		let err = enqueue_job(
			&client,
			&base,
			"any-token",
			&sample_manifest(),
			TEST_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.unwrap_err();
		assert!(matches!(err, EnqueueError::Network(_)));
	}

	// 5xx は scheduler 側の一時的な不調(Cloudflare のゲートウェイエラー等)である
	// 可能性が高く、`Rejected`(恒久エラー)ではなく再試行可能な `Network` に分類する
	// (レビュー指摘: 以前は 500/502/504 も `Rejected` となり、一時的な障害でも
	// リトライされずユーザーに「拒否された」と誤って伝わっていた)。
	#[tokio::test]
	async fn enqueue_job_network_error_on_500() {
		let base = spawn_mock_server("HTTP/1.1 500 Internal Server Error", "{}");
		let client = Client::new();
		let err = enqueue_job(
			&client,
			&base,
			"any-token",
			&sample_manifest(),
			TEST_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.unwrap_err();
		assert!(matches!(err, EnqueueError::Network(_)));
	}

	#[tokio::test]
	async fn enqueue_job_network_error_on_502() {
		let base = spawn_mock_server("HTTP/1.1 502 Bad Gateway", "{}");
		let client = Client::new();
		let err = enqueue_job(
			&client,
			&base,
			"any-token",
			&sample_manifest(),
			TEST_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.unwrap_err();
		assert!(matches!(err, EnqueueError::Network(_)));
	}

	#[tokio::test]
	async fn enqueue_job_network_error_on_504() {
		let base = spawn_mock_server("HTTP/1.1 504 Gateway Timeout", "{}");
		let client = Client::new();
		let err = enqueue_job(
			&client,
			&base,
			"any-token",
			&sample_manifest(),
			TEST_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.unwrap_err();
		assert!(matches!(err, EnqueueError::Network(_)));
	}

	#[tokio::test]
	async fn enqueue_job_network_error_on_connection_refused() {
		let client = Client::new();
		let err = enqueue_job(
			&client,
			"http://127.0.0.1:1",
			"any-token",
			&sample_manifest(),
			TEST_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.unwrap_err();
		assert!(matches!(err, EnqueueError::Network(_)));
	}

	#[tokio::test]
	async fn enqueue_job_times_out_when_server_never_responds() {
		let base = spawn_stalling_server();
		let client = Client::new();
		// 無応答サーバに短いタイムアウトで当て、無期限にハングせず打ち切ることを確認する。
		let err = enqueue_job(
			&client,
			&base,
			"any-token",
			&sample_manifest(),
			Duration::from_millis(300),
			&CancelToken::new(),
		)
		.await
		.unwrap_err();
		// タイムアウトは Network に分類され、秒数付きのメッセージになる。
		match err {
			EnqueueError::Network(msg) => assert!(msg.contains("応答しませんでした")),
			other => panic!("expected Network timeout error, got {other:?}"),
		}
	}

	/// enqueue リクエスト送信中(応答待ち)に `cancel()` された場合、`ENQUEUE_TIMEOUT`
	/// (本番既定30秒)を待たず速やかに `Cancelled` を返すことの回帰テスト
	/// (GHSA-q37v-7xpp-x229 残作業: enqueue 実行中の協調キャンセル。修正前は素の `await`
	/// で待っていたため、キャンセルがタイムアウトまで反映されなかった)。応答しない
	/// モックサーバ + 長めのタイムアウトを使い、キャンセルがタイムアウトより先に
	/// 効くことを確認する。
	#[tokio::test]
	async fn enqueue_job_cancelled_during_request_returns_promptly() {
		let base = spawn_stalling_server();
		let client = Client::new();
		let cancel = CancelToken::new();

		// 送信開始直後に別タスクからキャンセルする(`ig_publish_cancel` 相当)。
		let cancel_for_task = cancel.clone();
		tokio::spawn(async move {
			tokio::time::sleep(Duration::from_millis(50)).await;
			cancel_for_task.cancel();
		});

		let started = std::time::Instant::now();
		let err = enqueue_job(
			&client,
			&base,
			"any-token",
			&sample_manifest(),
			Duration::from_secs(5),
			&cancel,
		)
		.await
		.unwrap_err();
		let elapsed = started.elapsed();

		assert!(matches!(err, EnqueueError::Cancelled));
		// タイムアウト(5秒)よりずっと早く(キャンセル発火から
		// CANCEL_POLL_INTERVAL 数回分)打ち切られることを確認する。
		assert!(
			elapsed < Duration::from_secs(2),
			"cancel should short-circuit well before the 5s timeout, took {elapsed:?}"
		);
	}

	// ---- fetch_job(loopback 上の最小 HTTP サーバでモック) --------------------------
	// desktop が IG 予約投稿の最終成否を追跡しない問題(アーキテクチャレビュー指摘)への
	// 対応で追加。`enqueue_job` のテストと同じ流儀(`spawn_mock_server`/`spawn_stalling_server`
	// を再利用)。

	/// `GET /jobs/:id` が返す `JobRecord` の JSON フィクスチャ(status: "published")。
	/// `spawn_mock_server` が `body: &'static str` を要求するため、`format!` を使わず
	/// リテラルとして持つ。
	const SAMPLE_JOB_RECORD_PUBLISHED_JSON: &str = r#"{"id":"job-1","idempotencyKey":"11111111-2222-3333-4444-555555555555","platform":"instagram","r2Key":"posts/2026-07-10/uuid.mp4","mediaType":"REELS","caption":"caption","publishAt":1783686896000,"status":"published","igContainerId":null,"igMediaId":null,"attempts":0,"lastError":null,"createdAt":1783686896000,"updatedAt":1783686896000}"#;

	#[tokio::test]
	async fn fetch_job_returns_record_on_200() {
		let base = spawn_mock_server("HTTP/1.1 200 OK", SAMPLE_JOB_RECORD_PUBLISHED_JSON);
		let client = Client::new();
		let record = fetch_job(&client, &base, "valid-token", "job-1", TEST_TIMEOUT)
			.await
			.unwrap();
		assert_eq!(record.id, "job-1");
		assert_eq!(record.status, "published");
	}

	#[tokio::test]
	async fn fetch_job_unauthorized_on_401() {
		let base = spawn_mock_server("HTTP/1.1 401 Unauthorized", "{}");
		let client = Client::new();
		let err = fetch_job(&client, &base, "wrong-token", "job-1", TEST_TIMEOUT)
			.await
			.unwrap_err();
		assert!(matches!(err, FetchJobError::Unauthorized));
	}

	#[tokio::test]
	async fn fetch_job_service_unavailable_on_503() {
		let base = spawn_mock_server("HTTP/1.1 503 Service Unavailable", "{}");
		let client = Client::new();
		let err = fetch_job(&client, &base, "any-token", "job-1", TEST_TIMEOUT)
			.await
			.unwrap_err();
		assert!(matches!(err, FetchJobError::ServiceUnavailable));
	}

	#[tokio::test]
	async fn fetch_job_not_found_on_404() {
		let base = spawn_mock_server("HTTP/1.1 404 Not Found", r#"{"error":"job not found"}"#);
		let client = Client::new();
		let err = fetch_job(&client, &base, "any-token", "job-1", TEST_TIMEOUT)
			.await
			.unwrap_err();
		assert!(matches!(err, FetchJobError::NotFound));
	}

	#[tokio::test]
	async fn fetch_job_network_error_on_connection_refused() {
		let client = Client::new();
		let err = fetch_job(
			&client,
			"http://127.0.0.1:1",
			"any-token",
			"job-1",
			TEST_TIMEOUT,
		)
		.await
		.unwrap_err();
		assert!(matches!(err, FetchJobError::Network(_)));
	}

	#[tokio::test]
	async fn fetch_job_times_out_when_server_never_responds() {
		let base = spawn_stalling_server();
		let client = Client::new();
		let err = fetch_job(
			&client,
			&base,
			"any-token",
			"job-1",
			Duration::from_millis(300),
		)
		.await
		.unwrap_err();
		match err {
			FetchJobError::Network(msg) => assert!(msg.contains("応答しませんでした")),
			other => panic!("expected Network timeout error, got {other:?}"),
		}
	}

	#[tokio::test]
	async fn fetch_job_rejects_job_id_with_path_separator() {
		// job_id は invoke 引数として renderer から渡ってくる値のため、パス区切りの
		// 混入で意図しないパスへ誘導できないことを固定する(join_job_url 冒頭コメント参照)。
		// サーバを起動しないため、接続自体が発生していないことも併せて確認する
		// (実在しないアドレスでも到達前にエラーになる)。
		let client = Client::new();
		let err = fetch_job(
			&client,
			"http://127.0.0.1:1",
			"any-token",
			"../health",
			TEST_TIMEOUT,
		)
		.await
		.unwrap_err();
		match err {
			FetchJobError::Network(msg) => assert!(msg.contains("job_id が不正です")),
			other => panic!("expected Network(job_id validation) error, got {other:?}"),
		}
	}

	#[tokio::test]
	async fn fetch_job_rejects_job_id_with_bare_dot_segments() {
		// allowlist(英数字・-・_)により、`/` を含まない `.`/`..` も拒否されることを
		// 固定する(denylist だと `Url::set_path` の正規化で意図しないパスへ畳まれる
		// 余地が残る、という code review 指摘への対応)。
		let client = Client::new();
		for job_id in ["..", "."] {
			let err = fetch_job(
				&client,
				"http://127.0.0.1:1",
				"any-token",
				job_id,
				TEST_TIMEOUT,
			)
			.await
			.unwrap_err();
			match err {
				FetchJobError::Network(msg) => assert!(msg.contains("job_id が不正です")),
				other => panic!(
					"expected Network(job_id validation) error for {job_id:?}, got {other:?}"
				),
			}
		}
	}

	#[tokio::test]
	async fn fetch_job_network_error_on_unexpected_status() {
		let base = spawn_mock_server("HTTP/1.1 500 Internal Server Error", "{}");
		let client = Client::new();
		let err = fetch_job(&client, &base, "any-token", "job-1", TEST_TIMEOUT)
			.await
			.unwrap_err();
		assert!(matches!(err, FetchJobError::Network(_)));
	}

	#[tokio::test]
	async fn fetch_job_network_error_on_malformed_json_body() {
		let base = spawn_mock_server("HTTP/1.1 200 OK", "not json");
		let client = Client::new();
		let err = fetch_job(&client, &base, "any-token", "job-1", TEST_TIMEOUT)
			.await
			.unwrap_err();
		match err {
			FetchJobError::Network(msg) => assert!(msg.contains("応答の解析に失敗しました")),
			other => panic!("expected Network(parse failure) error, got {other:?}"),
		}
	}

	/// 実 scheduler(Cloudflare Workers)へ実際にジョブ登録する実機テスト
	/// (CI・サンドボックスでは実行しない)。手動確認手順:
	///
	/// ```sh
	/// export FACET_TEST_SCHEDULER_URL=<デプロイ済み scheduler の URL>
	/// export FACET_TEST_SCHEDULER_TOKEN=<SCHEDULER_API_TOKEN と同じ値>
	/// cargo test --features publish real_scheduler_enqueue -- --ignored
	/// ```
	///
	/// 同じ idempotencyKey での再実行が同じジョブ ID を返す(冪等)ことも確認する。
	/// 実行後、D1 の jobs テーブル(または `GET /jobs/:id`)でレコードを確認し、
	/// 不要なら削除する(publish_at は 1 年後にしてあるため cron 発火前に削除できる)。
	#[tokio::test]
	#[ignore = "実 scheduler にジョブ登録する。URL とトークンを環境変数で渡して手動実行する(doc コメント参照)"]
	async fn real_scheduler_enqueue_is_idempotent() {
		let scheduler_url =
			std::env::var("FACET_TEST_SCHEDULER_URL").expect("set FACET_TEST_SCHEDULER_*");
		let token = std::env::var("FACET_TEST_SCHEDULER_TOKEN").unwrap();

		// publish_at は 1 年後(cron が発火する前に手動削除できる余裕を持たせる)。
		let publish_at = (std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_millis() as i64)
			+ 365 * 24 * 60 * 60 * 1000;
		let manifest = manifest::new_job_manifest(
			uuid::Uuid::new_v4().to_string(),
			"posts/manual-test/does-not-exist.mp4".to_string(),
			"real scheduler enqueue test".to_string(),
			publish_at,
		);

		let client = Client::new();
		let first = enqueue_job(
			&client,
			&scheduler_url,
			&token,
			&manifest,
			ENQUEUE_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.expect("first enqueue should succeed");
		let second = enqueue_job(
			&client,
			&scheduler_url,
			&token,
			&manifest,
			ENQUEUE_TIMEOUT,
			&CancelToken::new(),
		)
		.await
		.expect("idempotent replay should succeed");
		assert_eq!(
			first.id, second.id,
			"同じ idempotencyKey は同じジョブを返す"
		);
	}
}
