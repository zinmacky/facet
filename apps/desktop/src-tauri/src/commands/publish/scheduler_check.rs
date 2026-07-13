//! scheduler への疎通チェック(docs/desktop-migration-plan.md §6.6・§11-3)。
//!
//! apps/scheduler(PR #83 でマージ済み)の実装に合わせ、2段階で確認する:
//!   1. `GET {url}/health` — 無認証。到達性のみを見る(常に 200 を返す実装)。
//!   2. `GET {url}/` — Bearer トークン付き。トークン一致で 200、不一致/欠如で 401、
//!      scheduler 側で `SCHEDULER_API_TOKEN` 自体が未設定なら 503(fail-closed)。
//!
//! URL 構築・レスポンス分類は同期的な純粋関数(`build_health_url` / `build_root_url` /
//! `classify_*`)として切り出し、ネットワークを使わずに単体テストできるようにする。
//! `perform_check` はこれらを組み合わせて実際に reqwest で HTTP を叩く非同期関数で、
//! テストではループバック上の最小 HTTP サーバ(`#[cfg(test)]`)を相手にする。

use reqwest::{Client, StatusCode};
use serde::Serialize;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// renderer へ返す疎通チェック結果。値そのもの(トークン等)は一切含めない。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ConnectionCheckResult {
	/// 疎通 OK(health 到達 + Bearer 認証つきで 200)。
	Ok,
	/// ローカルに scheduler_api_token が保存されていない(疎通チェック自体を行わなかった)。
	NoToken,
	/// health エンドポイントに到達できない(ネットワークエラー・タイムアウト・非 200 応答)。
	Unreachable { detail: String },
	/// Bearer トークンが scheduler 側と一致しない(401)。
	Unauthorized,
	/// scheduler 側で `SCHEDULER_API_TOKEN` が未設定(503, fail-closed)。
	ServiceUnavailable,
	/// 上記以外の想定外ステータスコード。
	UnexpectedStatus { code: u16 },
}

/// `base` + `/health`(無認証の到達性確認エンドポイント)の URL を組み立てる。
pub fn build_health_url(base: &str) -> Result<reqwest::Url, String> {
	join_path(base, "health")
}

/// `base` + `/`(Bearer 認証必須の保護エンドポイント)の URL を組み立てる。
pub fn build_root_url(base: &str) -> Result<reqwest::Url, String> {
	join_path(base, "")
}

/// `base` を http/https の絶対 URL として検証し、末尾に `segment` を足す。
/// `Url::join` は相対解決の都合上、末尾セグメントの扱いが直感に反する場合があるため、
/// パス文字列を直接組み立てる。
fn join_path(base: &str, segment: &str) -> Result<reqwest::Url, String> {
	let mut url = reqwest::Url::parse(base.trim())
		.map_err(|_| "scheduler_url が不正な URL です。".to_string())?;
	if !matches!(url.scheme(), "http" | "https") {
		return Err("scheduler_url は http/https のみ対応です。".to_string());
	}
	let base_path = url.path().trim_end_matches('/');
	url.set_path(&format!("{base_path}/{segment}"));
	Ok(url)
}

/// health(無認証)応答の分類。200 のみ到達成功とみなす。
fn classify_health_status(status: StatusCode) -> Result<(), ConnectionCheckResult> {
	if status == StatusCode::OK {
		Ok(())
	} else {
		Err(ConnectionCheckResult::Unreachable {
			detail: format!("health エンドポイントが {status} を返しました。"),
		})
	}
}

/// Bearer 認証つき保護エンドポイント応答の分類。
fn classify_authed_status(status: StatusCode) -> ConnectionCheckResult {
	match status {
		StatusCode::OK => ConnectionCheckResult::Ok,
		StatusCode::UNAUTHORIZED => ConnectionCheckResult::Unauthorized,
		StatusCode::SERVICE_UNAVAILABLE => ConnectionCheckResult::ServiceUnavailable,
		other => ConnectionCheckResult::UnexpectedStatus {
			code: other.as_u16(),
		},
	}
}

/// 2段階疎通チェックの本体。`token` が `None` の場合は `NoToken` を返す
/// (呼び出し側のコマンドがキーチェーンからトークンを読み、無ければここへ渡す前に
/// 早期リターンしてもよいが、防御的にここでも扱う)。
pub async fn perform_check(scheduler_url: &str, token: Option<&str>) -> ConnectionCheckResult {
	let Some(token) = token else {
		return ConnectionCheckResult::NoToken;
	};

	let health_url = match build_health_url(scheduler_url) {
		Ok(u) => u,
		Err(detail) => return ConnectionCheckResult::Unreachable { detail },
	};
	let root_url = match build_root_url(scheduler_url) {
		Ok(u) => u,
		Err(detail) => return ConnectionCheckResult::Unreachable { detail },
	};

	let client = match Client::builder().timeout(REQUEST_TIMEOUT).build() {
		Ok(c) => c,
		Err(e) => {
			return ConnectionCheckResult::Unreachable {
				detail: format!("HTTP クライアントの初期化に失敗しました: {e}"),
			};
		}
	};

	// 1段階目: health(無認証、到達性のみ確認)。
	let health_resp = match client.get(health_url).send().await {
		Ok(r) => r,
		Err(e) => {
			return ConnectionCheckResult::Unreachable {
				detail: format!("scheduler に到達できません: {e}"),
			};
		}
	};
	if let Err(result) = classify_health_status(health_resp.status()) {
		return result;
	}

	// 2段階目: Bearer トークン付きで保護エンドポイントを叩く。
	let authed_resp = match client.get(root_url).bearer_auth(token).send().await {
		Ok(r) => r,
		Err(e) => {
			return ConnectionCheckResult::Unreachable {
				detail: format!("認証確認リクエストに失敗しました: {e}"),
			};
		}
	};
	classify_authed_status(authed_resp.status())
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::{Read, Write};
	use std::net::TcpListener;

	// ---- URL 構築(純粋関数、ネットワーク不要) ------------------------------------

	#[test]
	fn build_health_url_appends_health_segment() {
		let url = build_health_url("https://scheduler.example.workers.dev").unwrap();
		assert_eq!(url.as_str(), "https://scheduler.example.workers.dev/health");
	}

	#[test]
	fn build_root_url_normalizes_trailing_slash() {
		let url = build_root_url("https://scheduler.example.workers.dev/").unwrap();
		assert_eq!(url.as_str(), "https://scheduler.example.workers.dev/");
	}

	#[test]
	fn build_health_url_rejects_non_http_scheme() {
		assert!(build_health_url("ftp://scheduler.example.com").is_err());
	}

	#[test]
	fn build_health_url_rejects_invalid_url() {
		assert!(build_health_url("not a url").is_err());
	}

	// ---- レスポンス分類(純粋関数、ネットワーク不要) --------------------------------

	#[test]
	fn classify_authed_status_maps_known_codes() {
		assert_eq!(
			classify_authed_status(StatusCode::OK),
			ConnectionCheckResult::Ok
		);
		assert_eq!(
			classify_authed_status(StatusCode::UNAUTHORIZED),
			ConnectionCheckResult::Unauthorized
		);
		assert_eq!(
			classify_authed_status(StatusCode::SERVICE_UNAVAILABLE),
			ConnectionCheckResult::ServiceUnavailable
		);
		assert_eq!(
			classify_authed_status(StatusCode::NOT_FOUND),
			ConnectionCheckResult::UnexpectedStatus { code: 404 }
		);
	}

	// ---- perform_check(loopback 上の最小 HTTP サーバでモック) -----------------------

	/// 1接続につき1リクエストを処理する使い捨てサーバを立てる。`status_lines` の順に
	/// リクエストを1本ずつ処理し、対応するステータス行を返す(body は空)。
	/// `perform_check` は health → authed の順に最大2リクエストを送るため、
	/// 呼び出し側は必要な本数だけ渡す。
	///
	/// 重要: `status_lines` の本数はテスト対象の呼び出しが実際に送るリクエスト本数と
	/// 一致させること。少なすぎるとサーバが早期に終了し後続リクエストは
	/// connection refused になる(想定と異なる `Unreachable` で気付ける)。
	/// 多すぎるとサーバスレッドが来ないリクエストを待ち続けるが、テスト自体は
	/// スレッドを待たないためハングはしない(プロセス終了まで残るだけ)。
	fn spawn_mock_server(status_lines: Vec<&'static str>) -> String {
		let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
		let addr = listener.local_addr().unwrap();
		std::thread::spawn(move || {
			for status_line in status_lines {
				if let Ok((mut stream, _)) = listener.accept() {
					let mut buf = [0u8; 1024];
					let _ = stream.read(&mut buf); // リクエスト内容は使わないので読み捨てる
					let _ = stream.write_all(
						format!("{status_line}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
							.as_bytes(),
					);
				}
			}
		});
		format!("http://{addr}")
	}

	#[tokio::test]
	async fn perform_check_returns_no_token_without_any_request_when_token_absent() {
		// トークンが無い時点で即 NoToken を返し、URL には一切アクセスしない
		// (存在しないアドレスを渡しても失敗しないことで、ネットワークを叩いていないことを示す)。
		let result = perform_check("http://127.0.0.1:1", None).await;
		assert_eq!(result, ConnectionCheckResult::NoToken);
	}

	#[tokio::test]
	async fn perform_check_ok_when_both_stages_return_200() {
		let base = spawn_mock_server(vec!["HTTP/1.1 200 OK", "HTTP/1.1 200 OK"]);
		let result = perform_check(&base, Some("valid-token")).await;
		assert_eq!(result, ConnectionCheckResult::Ok);
	}

	#[tokio::test]
	async fn perform_check_unauthorized_when_authed_stage_returns_401() {
		let base = spawn_mock_server(vec!["HTTP/1.1 200 OK", "HTTP/1.1 401 Unauthorized"]);
		let result = perform_check(&base, Some("wrong-token")).await;
		assert_eq!(result, ConnectionCheckResult::Unauthorized);
	}

	#[tokio::test]
	async fn perform_check_service_unavailable_when_authed_stage_returns_503() {
		let base = spawn_mock_server(vec!["HTTP/1.1 200 OK", "HTTP/1.1 503 Service Unavailable"]);
		let result = perform_check(&base, Some("any-token")).await;
		assert_eq!(result, ConnectionCheckResult::ServiceUnavailable);
	}

	#[tokio::test]
	async fn perform_check_unreachable_when_health_stage_returns_non_200() {
		let base = spawn_mock_server(vec!["HTTP/1.1 404 Not Found"]);
		let result = perform_check(&base, Some("any-token")).await;
		assert!(matches!(result, ConnectionCheckResult::Unreachable { .. }));
	}

	#[tokio::test]
	async fn perform_check_unreachable_when_connection_refused() {
		// bind せずクライアントとして接続だけ試みる(未使用ポート想定)。
		let result = perform_check("http://127.0.0.1:1", Some("any-token")).await;
		assert!(matches!(result, ConnectionCheckResult::Unreachable { .. }));
	}
}
