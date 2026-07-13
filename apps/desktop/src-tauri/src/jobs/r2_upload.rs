//! R2 の presigned PUT URL(`crate::jobs::sigv4::presigned_put_url`)へ実際にファイルを
//! アップロードする。単一の `PUT`(マルチパートなし)で足りる — IG のファイルサイズ上限
//! (300MB, §12.1)は R2/S3 の単一 PUT 上限(5GB)を大きく下回るため、旧 TS 実装
//! (`scheduler-client.ts`)と同じく単一 PUT で十分(実装指示 §1 参照)。
//!
//! 進捗は `tokio_util::io::ReaderStream` の各チャンクを覗く形で計測し、呼び出し側
//! (`commands::publish::ig`)が Tauri イベントとして emit する(既存の reframe 進捗
//! イベントのパターンに倣う。`commands/reframe.rs` 冒頭コメント参照)。
//!
//! キャンセルは `media_core::CancelToken` を使い、アップロード中の HTTP リクエスト
//! (`tokio::select!` でレース)を中断する形で実現する
//! (バイトストリーム内部にキャンセルチェックを挟む必要はない — アップロード
//! リクエスト自体を `select!` で早期に drop すれば、下層の TCP 接続も切断される)。

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::TryStreamExt;
use media_core::CancelToken;
use reqwest::{Client, Url};
use thiserror::Error;
use tokio_util::io::ReaderStream;

/// キャンセル監視のポーリング間隔。`media_core::CancelToken` は同期的な
/// `Arc<AtomicBool>` のため、非同期側からは短い間隔でポーリングする
/// (`commands::publish::scheduler_check` の HTTP タイムアウト(10秒)より
/// 十分短い値にし、キャンセル操作からの体感遅延を小さく保つ)。
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Debug, Error)]
pub enum R2UploadError {
	#[error("アップロード対象ファイルの読み取りに失敗しました: {0}")]
	Io(String),
	#[error("R2 へのアップロードに失敗しました ({status}): {detail}")]
	Http { status: u16, detail: String },
	#[error("R2 への通信に失敗しました: {0}")]
	Network(String),
	#[error("キャンセルされました")]
	Cancelled,
}

/// `cancel` がキャンセル済みになるまで待つ(`tokio::select!` の対抗馬として使う)。
async fn wait_for_cancel(cancel: &CancelToken) {
	loop {
		if cancel.is_cancelled() {
			return;
		}
		tokio::time::sleep(CANCEL_POLL_INTERVAL).await;
	}
}

/// `path` のファイルを `url`(presigned PUT URL)へアップロードする。
///
/// `on_progress` は `(送信済みバイト数, 総バイト数)` を受け取るコールバック。
/// `ReaderStream` の既定チャンクサイズ(数KB〜数十KB)ごとに呼ばれるため、呼び出し側で
/// イベント発火頻度を間引くこと(`commands::publish::ig` 側で実施、モジュール冒頭コメント
/// 参照)。`FnMut` を受け取る(呼び出し側が直近の発火状態を可変にローカルで持てるように
/// する — ストリームは単一の消費者から順次ポーリングされるだけなので並行呼び出しは
/// 起きない、`Sync` までは要求しない)。
pub async fn upload_file(
	client: &Client,
	url: Url,
	path: &Path,
	cancel: &CancelToken,
	mut on_progress: impl FnMut(u64, u64) + Send + 'static,
) -> Result<(), R2UploadError> {
	if cancel.is_cancelled() {
		return Err(R2UploadError::Cancelled);
	}

	let metadata = tokio::fs::metadata(path)
		.await
		.map_err(|err| R2UploadError::Io(err.to_string()))?;
	let total = metadata.len();

	let file = tokio::fs::File::open(path)
		.await
		.map_err(|err| R2UploadError::Io(err.to_string()))?;

	let sent = Arc::new(AtomicU64::new(0));
	let stream = ReaderStream::new(file).inspect_ok(move |chunk| {
		let now = sent.fetch_add(chunk.len() as u64, Ordering::Relaxed) + chunk.len() as u64;
		on_progress(now, total);
	});
	let body = reqwest::Body::wrap_stream(stream);

	let request = client
		.put(url)
		.header(reqwest::header::CONTENT_TYPE, "video/mp4")
		.header(reqwest::header::CONTENT_LENGTH, total.to_string())
		.body(body)
		.send();

	tokio::select! {
		() = wait_for_cancel(cancel) => Err(R2UploadError::Cancelled),
		result = request => {
			// 重要: `reqwest::Error` の `Display` は末尾に `for url (<URL>)` を付与する。
			// この URL は presigned URL(クエリに `X-Amz-Signature` と、`X-Amz-Credential`
			// 経由でアクセスキー ID を含む)のため、そのまま文字列化すると renderer へ
			// 送るエラーメッセージに署名付き URL 全体が漏洩する。`without_url()` で
			// URL を落としてから文字列化する(資格情報をエラーメッセージに含めない方針、
			// `commands/publish/credential_store.rs` の sanitize と同じ考え方)。
			let response = result
				.map_err(|err| R2UploadError::Network(err.without_url().to_string()))?;
			classify_response(response).await
		}
	}
}

async fn classify_response(response: reqwest::Response) -> Result<(), R2UploadError> {
	if response.status().is_success() {
		return Ok(());
	}
	let status = response.status();
	let detail = response.text().await.unwrap_or_default();
	Err(R2UploadError::Http {
		status: status.as_u16(),
		detail,
	})
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Write;
	use std::net::TcpListener;

	/// 1接続だけ処理する使い捨てローカルサーバ。`status_line` を返し、body は捨てる
	/// (`scheduler_check.rs` の `spawn_mock_server` と同じ流儀。PUT のリクエスト全体を
	/// 読み切ってからレスポンスを返す — reqwest がレスポンスを待つ前に接続を閉じると
	/// ハングやエラーの原因になるため)。
	fn spawn_mock_put_server(status_line: &'static str) -> String {
		let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
		let addr = listener.local_addr().unwrap();
		std::thread::spawn(move || {
			if let Ok((mut stream, _)) = listener.accept() {
				// Content-Length を読み切ってからでないと reqwest 側が送信完了と
				// 認識せず、レスポンスの受信もブロックされたままになる。
				use std::io::Read;
				let mut buf = Vec::new();
				let mut chunk = [0u8; 4096];
				// ヘッダ + body をまとめて読む(テスト用の小さいペイロードなので雑に読み切る)。
				loop {
					match stream.read(&mut chunk) {
						Ok(0) => break,
						Ok(n) => {
							buf.extend_from_slice(&chunk[..n]);
							// 簡易的な完了判定: body 開始(\r\n\r\n)を検出し、かつ
							// Content-Length ぶん読めていれば打ち切る。
							if let Some(header_end) =
								find_subslice(&buf, b"\r\n\r\n").map(|i| i + 4)
							{
								if let Some(len) = parse_content_length(&buf[..header_end]) {
									if buf.len() >= header_end + len {
										break;
									}
									continue;
								}
								break;
							}
						}
						Err(_) => break,
					}
				}
				let _ = stream.write_all(
					format!("{status_line}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
						.as_bytes(),
				);
			}
		});
		format!("http://{addr}")
	}

	fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
		haystack
			.windows(needle.len())
			.position(|window| window == needle)
	}

	fn parse_content_length(header: &[u8]) -> Option<usize> {
		let text = String::from_utf8_lossy(header).to_lowercase();
		for line in text.lines() {
			if let Some(rest) = line.strip_prefix("content-length:") {
				return rest.trim().parse().ok();
			}
		}
		None
	}

	fn write_temp_file(name: &str, contents: &[u8]) -> std::path::PathBuf {
		let dir = std::env::temp_dir().join(format!(
			"facet-desktop-r2-upload-test-{name}-{}",
			std::process::id()
		));
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join("input.mp4");
		std::fs::write(&path, contents).unwrap();
		path
	}

	#[tokio::test]
	async fn upload_file_succeeds_on_200() {
		let base = spawn_mock_put_server("HTTP/1.1 200 OK");
		let path = write_temp_file("succeeds", b"hello world, this is test video bytes");
		let client = Client::new();
		let url: Url = format!("{base}/bucket/key.mp4").parse().unwrap();
		let cancel = CancelToken::new();

		let result = upload_file(&client, url, &path, &cancel, |_, _| {}).await;
		assert!(result.is_ok(), "expected success, got {result:?}");
	}

	#[tokio::test]
	async fn upload_file_reports_http_error_on_non_2xx() {
		let base = spawn_mock_put_server("HTTP/1.1 403 Forbidden");
		let path = write_temp_file("http-error", b"some bytes");
		let client = Client::new();
		let url: Url = format!("{base}/bucket/key.mp4").parse().unwrap();
		let cancel = CancelToken::new();

		let err = upload_file(&client, url, &path, &cancel, |_, _| {})
			.await
			.unwrap_err();
		assert!(matches!(err, R2UploadError::Http { status: 403, .. }));
	}

	#[tokio::test]
	async fn upload_file_returns_cancelled_when_already_cancelled() {
		let path = write_temp_file("pre-cancelled", b"bytes");
		let client = Client::new();
		// 存在しないアドレス(接続すら発生しない想定)でも、事前キャンセルなら
		// ネットワークに触れず即座に Cancelled を返す。
		let url: Url = "http://127.0.0.1:1/bucket/key.mp4".parse().unwrap();
		let cancel = CancelToken::new();
		cancel.cancel();

		let err = upload_file(&client, url, &path, &cancel, |_, _| {})
			.await
			.unwrap_err();
		assert!(matches!(err, R2UploadError::Cancelled));
	}

	#[tokio::test]
	async fn upload_file_reports_network_error_on_connection_refused() {
		let path = write_temp_file("network-error", b"bytes");
		let client = Client::new();
		let url: Url = "http://127.0.0.1:1/bucket/key.mp4".parse().unwrap();
		let cancel = CancelToken::new();

		let err = upload_file(&client, url, &path, &cancel, |_, _| {})
			.await
			.unwrap_err();
		assert!(matches!(err, R2UploadError::Network(_)));
	}

	/// ネットワークエラーのメッセージに presigned URL(署名・資格情報を含むクエリ)が
	/// 漏れないことの回帰テスト(`upload_file` 内の `without_url()`、
	/// reqwest の `Display for Error` は既定で `for url (<URL>)` を付与するため)。
	#[tokio::test]
	async fn upload_file_network_error_does_not_leak_presigned_url() {
		let path = write_temp_file("no-url-leak", b"bytes");
		let client = Client::new();
		let url: Url = "http://127.0.0.1:1/bucket/key.mp4?X-Amz-Signature=super-secret-signature"
			.parse()
			.unwrap();
		let cancel = CancelToken::new();

		let err = upload_file(&client, url, &path, &cancel, |_, _| {})
			.await
			.unwrap_err();
		let message = err.to_string();
		assert!(
			!message.contains("X-Amz-Signature") && !message.contains("super-secret-signature"),
			"エラーメッセージに presigned URL が含まれてはならない: {message}"
		);
	}

	/// 実 R2 バケットへ実際にアップロードする実機テスト(CI・サンドボックスでは
	/// 実行しない)。手動確認手順:
	///
	/// ```sh
	/// export FACET_TEST_R2_ACCOUNT_ID=<Cloudflare アカウント ID>
	/// export FACET_TEST_R2_ACCESS_KEY_ID=<R2 API トークンのアクセスキー ID>
	/// export FACET_TEST_R2_SECRET_ACCESS_KEY=<同シークレット>
	/// export FACET_TEST_R2_BUCKET=<検証用バケット名>
	/// cargo test --features publish real_r2_upload -- --ignored
	/// ```
	///
	/// 成功後、R2 ダッシュボード(またはお使いの S3 クライアント)で
	/// `posts/manual-test/upload-check.mp4` が作成されていることを確認し、削除する。
	#[tokio::test]
	#[ignore = "実 R2 に書き込む。資格情報を環境変数で渡して手動実行する(doc コメント参照)"]
	async fn real_r2_upload_roundtrip() {
		let account_id = std::env::var("FACET_TEST_R2_ACCOUNT_ID").expect("set FACET_TEST_R2_*");
		let access_key_id = std::env::var("FACET_TEST_R2_ACCESS_KEY_ID").unwrap();
		let secret_access_key = std::env::var("FACET_TEST_R2_SECRET_ACCESS_KEY").unwrap();
		let bucket = std::env::var("FACET_TEST_R2_BUCKET").unwrap();

		let credentials = crate::jobs::sigv4::R2Credentials {
			account_id,
			access_key_id,
			secret_access_key,
			bucket,
		};
		let url = crate::jobs::sigv4::presigned_put_url(
			&credentials,
			"posts/manual-test/upload-check.mp4",
		)
		.expect("presign should succeed");

		let path = write_temp_file("real-r2", b"facet desktop real R2 upload check");
		let client = Client::new();
		let cancel = CancelToken::new();
		upload_file(&client, url, &path, &cancel, |sent, total| {
			eprintln!("progress: {sent}/{total}");
		})
		.await
		.expect("upload to real R2 should succeed");
	}
}
