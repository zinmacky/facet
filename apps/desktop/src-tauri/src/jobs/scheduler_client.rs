//! `POST /jobs`(scheduler へのジョブ登録)。旧 TS 実装(削除済み)
//! (`apps/studio/server/src/services/scheduler-client.ts` の後半)+
//! `packages/contract` の `jobManifest`/`jobCreateResponse` に対応する。
//!
//! Bearer トークン認証は `commands::publish::scheduler_check` が疎通チェックで
//! 使っているものと同じ scheduler(PR #83 でマージ済み)を相手にする。エラー分類も
//! 同モジュールの `ConnectionCheckResult` と同じ考え方(401=トークン不正、
//! 503=scheduler 未設定)を踏襲する。

use reqwest::{Client, StatusCode, Url};
use thiserror::Error;

use super::manifest::{JobCreateResponse, JobManifest};

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
}

/// `base`(scheduler のベース URL)+ `/jobs` の URL を組み立てる。
/// `commands::publish::scheduler_check::join_path` と同じ考え方の小さな純関数だが、
/// `jobs` はビジネスロジック層・`commands` は invoke 境界層という層分けを保つため、
/// 依存方向を逆転させないよう独立に持つ(§`jobs` モジュール冒頭コメント参照)。
fn join_jobs_url(base: &str) -> Result<Url, String> {
	let mut url =
		Url::parse(base.trim()).map_err(|_| "scheduler_url が不正な URL です。".to_string())?;
	if !matches!(url.scheme(), "http" | "https") {
		return Err("scheduler_url は http/https のみ対応です。".to_string());
	}
	let base_path = url.path().trim_end_matches('/');
	url.set_path(&format!("{base_path}/jobs"));
	Ok(url)
}

/// `manifest` を scheduler へ登録する。冪等性は `manifest.idempotency_key` により
/// scheduler 側(`apps/scheduler/src/routes/jobs.ts`)が担保する(同一キーの再送は
/// 既存ジョブをそのまま返す)。
pub async fn enqueue_job(
	client: &Client,
	scheduler_url: &str,
	token: &str,
	manifest: &JobManifest,
) -> Result<JobCreateResponse, EnqueueError> {
	let url = join_jobs_url(scheduler_url).map_err(EnqueueError::Network)?;

	let response = client
		.post(url)
		.bearer_auth(token)
		.json(manifest)
		.send()
		.await
		.map_err(|err| EnqueueError::Network(err.to_string()))?;

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

	#[tokio::test]
	async fn enqueue_job_returns_response_on_201() {
		let base = spawn_mock_server(
			"HTTP/1.1 201 Created",
			r#"{"id":"job-1","status":"pending"}"#,
		);
		let client = Client::new();
		let resp = enqueue_job(&client, &base, "valid-token", &sample_manifest())
			.await
			.unwrap();
		assert_eq!(resp.id, "job-1");
		assert_eq!(resp.status, "pending");
	}

	#[tokio::test]
	async fn enqueue_job_returns_response_on_200_idempotent_replay() {
		let base = spawn_mock_server("HTTP/1.1 200 OK", r#"{"id":"job-1","status":"pending"}"#);
		let client = Client::new();
		let resp = enqueue_job(&client, &base, "valid-token", &sample_manifest())
			.await
			.unwrap();
		assert_eq!(resp.id, "job-1");
	}

	#[tokio::test]
	async fn enqueue_job_unauthorized_on_401() {
		let base = spawn_mock_server("HTTP/1.1 401 Unauthorized", "{}");
		let client = Client::new();
		let err = enqueue_job(&client, &base, "wrong-token", &sample_manifest())
			.await
			.unwrap_err();
		assert!(matches!(err, EnqueueError::Unauthorized));
	}

	#[tokio::test]
	async fn enqueue_job_service_unavailable_on_503() {
		let base = spawn_mock_server("HTTP/1.1 503 Service Unavailable", "{}");
		let client = Client::new();
		let err = enqueue_job(&client, &base, "any-token", &sample_manifest())
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
		let err = enqueue_job(&client, &base, "any-token", &sample_manifest())
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
		)
		.await
		.unwrap_err();
		assert!(matches!(err, EnqueueError::Network(_)));
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
		let first = enqueue_job(&client, &scheduler_url, &token, &manifest)
			.await
			.expect("first enqueue should succeed");
		let second = enqueue_job(&client, &scheduler_url, &token, &manifest)
			.await
			.expect("idempotent replay should succeed");
		assert_eq!(
			first.id, second.id,
			"同じ idempotencyKey は同じジョブを返す"
		);
	}
}
