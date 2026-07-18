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

use super::manifest::{JobCreateResponse, JobManifest};
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
		other => {
			let detail = response.text().await.unwrap_or_default();
			Err(EnqueueError::Rejected(format!("{other}: {detail}")))
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::jobs::manifest::JobManifest;
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
		JobManifest::new(
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
		let manifest = JobManifest::new(
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
