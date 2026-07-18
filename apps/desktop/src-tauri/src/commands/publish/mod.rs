//! Phase 3(IG/YouTube 公開連携)。`publish` cargo feature が有効なビルド
//! (private エディション。build:mac-private 等)でのみコンパイルされる
//! (§commands/mod.rs の `#[cfg(feature = "publish")]`、docs/desktop-migration-plan.md §6.6)。
//!
//! - [`credential_store`]: OS キーチェーン連携のトレイト分離(テスト容易性のため)。
//! - [`scheduler_check`]: scheduler への2段階疎通チェック(health → Bearer 認証)。
//! - [`r2_credentials`]: R2(S3 互換)資格情報のキーチェーン連携(§6.4)。
//! - [`ig`]: IG(Instagram)本体のコマンド(`ig_publish_start`/`ig_publish_cancel`。
//!   R2 アップロード + POST /jobs、§6.4・§8 Phase 3)。
//! - [`youtube_oauth`]: YouTube OAuth(Installed App フロー)+ トークンのキーチェーン連携
//!   (§6.5・§11-4)。
//! - [`youtube`]: YouTube 本体のコマンド(`youtube_publish_start`/`youtube_publish_cancel`。
//!   resumable upload + publishAt 予約、§6.5・§8 Phase 3)。
//!
//! トークン・資格情報そのものを返す invoke コマンドは存在しない(get 系は「保存済みか」の
//! boolean のみを返す。§実装方針)。set は値を受け取るが、ログ・エラーメッセージに
//! 値を含めない(credential_store.rs の `sanitize_err` 参照)。
//!
//! ## scheduler_url の保存場所についての設計判断(GHSA-j74q-9v5x-87w3 対応)
//!
//! 修正前は scheduler の Bearer トークン送信先(`scheduler_url`)を renderer が
//! invoke 引数として毎回指定できた。WebView が侵害された場合、任意のホストへ
//! トークンを流出させられる(confused deputy)。対策として、送信先は Rust 側の
//! 保存値からのみ導出する構造に変え、renderer からは受け取らない
//! (`ig_publish_start`/`check_scheduler_connection` から `scheduler_url` 引数を削除)。
//!
//! URL 自体は秘密情報ではない(これ単体で scheduler を操作できるわけではない)ため
//! 本来は OS キーチェーンに置く必然性はないが、「トークンの送信先は Rust 側の
//! 信頼できる保存値からのみ導出する」という不変条件を保つために、あえて既存の
//! [`CredentialStore`](キーチェーン)に相乗りする。`r2_credentials` が `bucket` 等の
//! 非秘密フィールドを同じ store に保存している前例と同じ考え方
//! (§r2_credentials.rs)。加えて保存時([`set_scheduler_url_impl`])・使用時
//! (`ig::start_impl`)の双方で `http://` はループバック限定に検証する
//! (§jobs::scheduler_client::parse_scheduler_base)。
//!
//! **残存リスク(意図した設計上のスコープ)**: `set_scheduler_url` は設定画面が使う
//! ため renderer から呼べる invoke コマンドのままである。したがって WebView が完全に
//! 侵害されれば、`set_scheduler_url` → `ig_publish_start` の2手順で https の任意ホスト
//! へトークンを送出する余地は残る。本対策の狙いはこの経路の完全封鎖ではなく、
//! 「呼び出しの都度、引数で送信先を指定できる」直接経路を閉じ、永続化された信頼済み
//! 設定の書き換えを要する形にして blast radius を縮小することにある(平文 http は
//! ループバック限定でさらに絞る)。

mod credential_store;
mod ig;
mod r2_credentials;
mod scheduler_check;
mod youtube;
mod youtube_oauth;

use credential_store::{CredentialStore, KeyringStore};
use scheduler_check::perform_check;

pub use ig::{IgJobStatusOutcome, IgJobsState};
pub use scheduler_check::ConnectionCheckResult;
pub use youtube::YoutubeJobsState;
pub use youtube_oauth::YoutubeOauthStatus;

/// キーチェーンのサービス名前空間。private エディション専用の識別子を使い、他アプリ
/// (や将来の public エディション)の資格情報と衝突しないようにする(§11-3)。
const SERVICE: &str = "com.facet.desktop.private";

/// scheduler の Bearer トークンのキーチェーン内 username。
const KEY_SCHEDULER_API_TOKEN: &str = "scheduler_api_token";

/// scheduler のベース URL のキーチェーン内 username(値自体は秘密ではない。
/// モジュール冒頭コメント「scheduler_url の保存場所についての設計判断」参照)。
const KEY_SCHEDULER_URL: &str = "scheduler_url";

/// R2(S3 互換)資格情報一式(JSON)のキーチェーン内 username(§r2_credentials.rs)。
const KEY_R2_CREDENTIALS: &str = "r2_credentials";

/// YouTube OAuth クライアント(client_id/client_secret, JSON)のキーチェーン内 username
/// (§youtube_oauth.rs)。
const KEY_YOUTUBE_OAUTH_CLIENT: &str = "youtube_oauth_client";

/// YouTube OAuth トークンキャッシュ(`yup_oauth2::storage::TokenInfo` の JSON。
/// access_token/refresh_token/expires_at を含む)のキーチェーン内 username。
/// PR #85 で予約されたキー名(`youtube_oauth_refresh_token`)をそのまま再利用する
/// (当初は「refresh_token 文字列のみ」を想定した名前だったが、yup-oauth2 の
/// `TokenStorage` に委ねる設計上、実際は `TokenInfo` 一式を保存する。
/// §youtube_oauth.rs 冒頭コメントの設計判断)。
const KEY_YOUTUBE_OAUTH_TOKEN: &str = "youtube_oauth_refresh_token";

// ---- コマンドロジック本体(CredentialStore 抽象越し。テストは MemoryStore で行う) ----

fn set_token_impl(store: &dyn CredentialStore, token: &str) -> Result<(), String> {
	let trimmed = token.trim();
	if trimmed.is_empty() {
		return Err("トークンが空です。".to_string());
	}
	// 前後の空白が混入していると Bearer 認証(scheduler_check.rs の `bearer_auth`)が
	// 不可解に失敗する原因になるため、保存する値も trim 済みのものに揃える
	// (フロント側は保存前に trim 済みだが、他の将来の呼び出し元のためにも防御的に行う)。
	store.set(SERVICE, KEY_SCHEDULER_API_TOKEN, trimmed)
}

fn has_token_impl(store: &dyn CredentialStore) -> Result<bool, String> {
	Ok(store.get(SERVICE, KEY_SCHEDULER_API_TOKEN)?.is_some())
}

fn delete_token_impl(store: &dyn CredentialStore) -> Result<(), String> {
	store.delete(SERVICE, KEY_SCHEDULER_API_TOKEN)
}

fn set_scheduler_url_impl(store: &dyn CredentialStore, url: &str) -> Result<(), String> {
	let trimmed = url.trim();
	if trimmed.is_empty() {
		return Err("scheduler_url が空です。".to_string());
	}
	// 保存前に検証する(GHSA-j74q-9v5x-87w3: http はループバック限定、
	// §jobs::scheduler_client::parse_scheduler_base)。不正な値をそもそも保存させない。
	crate::jobs::scheduler_client::parse_scheduler_base(trimmed)?;
	store.set(SERVICE, KEY_SCHEDULER_URL, trimmed)
}

fn get_scheduler_url_impl(store: &dyn CredentialStore) -> Result<Option<String>, String> {
	store.get(SERVICE, KEY_SCHEDULER_URL)
}

fn delete_scheduler_url_impl(store: &dyn CredentialStore) -> Result<(), String> {
	store.delete(SERVICE, KEY_SCHEDULER_URL)
}

// ---- invoke 境界(Tauri コマンド) ----------------------------------------------

/// scheduler の Bearer トークンをキーチェーンへ保存する(既存値は上書き)。
/// 値そのものはログ・エラーメッセージに含めない。
#[tauri::command]
pub fn set_scheduler_api_token(token: String) -> Result<(), String> {
	set_token_impl(&KeyringStore, &token)
}

/// トークンが保存済みかどうかだけを返す(値そのものは返さない)。
#[tauri::command]
pub fn has_scheduler_api_token() -> Result<bool, String> {
	has_token_impl(&KeyringStore)
}

/// 保存済みトークンを削除する(未保存でも成功扱い)。
#[tauri::command]
pub fn delete_scheduler_api_token() -> Result<(), String> {
	delete_token_impl(&KeyringStore)
}

/// scheduler の URL をキーチェーンへ保存する(既存値は上書き)。
/// URL 自体は秘密情報ではないが、送信先を Rust 側の保存値からのみ導出する不変条件を
/// 保つため、あえてキーチェーンへ保存する(モジュール冒頭コメント参照)。保存前に
/// `parse_scheduler_base` で検証する(不正な URL・非ループバックの http は拒否)。
#[tauri::command]
pub fn set_scheduler_url(url: String) -> Result<(), String> {
	set_scheduler_url_impl(&KeyringStore, &url)
}

/// 保存済みの scheduler URL を返す(表示用。URL は秘密情報ではないため値をそのまま返す)。
#[tauri::command]
pub fn get_scheduler_url() -> Result<Option<String>, String> {
	get_scheduler_url_impl(&KeyringStore)
}

/// 保存済みの scheduler URL を削除する(未保存でも成功扱い)。
#[tauri::command]
pub fn delete_scheduler_url() -> Result<(), String> {
	delete_scheduler_url_impl(&KeyringStore)
}

/// scheduler への疎通を2段階(health → Bearer 認証)で確認する。URL・トークンは
/// ここでキーチェーンから読み出すのみで、renderer へは返さない(戻り値は判別可能な
/// enum のみ、§scheduler_check::ConnectionCheckResult)。**引数を取らない** —
/// GHSA-j74q-9v5x-87w3 対応: 以前は renderer が任意の `scheduler_url` を渡せたため、
/// WebView 侵害時に任意ホストへの疎通チェック(≒トークン送信)を誘発できた。
#[tauri::command]
pub async fn check_scheduler_connection() -> Result<ConnectionCheckResult, String> {
	let Some(scheduler_url) = KeyringStore.get(SERVICE, KEY_SCHEDULER_URL)? else {
		return Ok(ConnectionCheckResult::NoUrl);
	};
	let token = KeyringStore.get(SERVICE, KEY_SCHEDULER_API_TOKEN)?;
	Ok(perform_check(&scheduler_url, token.as_deref()).await)
}

/// R2(S3 互換)資格情報をキーチェーンへ保存する(既存値は上書き)。
/// `bucket` が空文字列なら既定値(`r2_credentials::DEFAULT_BUCKET`)を使う。
/// 値そのものはログ・エラーメッセージに含めない。
#[tauri::command]
pub fn set_r2_credentials(
	account_id: String,
	access_key_id: String,
	secret_access_key: String,
	bucket: String,
) -> Result<(), String> {
	r2_credentials::set_impl(
		&KeyringStore,
		&account_id,
		&access_key_id,
		&secret_access_key,
		&bucket,
	)
}

/// R2 資格情報が保存済みかどうかだけを返す(値そのものは返さない)。
#[tauri::command]
pub fn has_r2_credentials() -> Result<bool, String> {
	r2_credentials::has_impl(&KeyringStore)
}

/// 保存済みの R2 資格情報を削除する(未保存でも成功扱い)。
#[tauri::command]
pub fn delete_r2_credentials() -> Result<(), String> {
	r2_credentials::delete_impl(&KeyringStore)
}

/// IG(Instagram)公開ジョブを開始する(ロジック本体は `ig::start_impl`、
/// §ig.rs `start_impl` 冒頭コメント: `#[tauri::command]` をこの薄いラッパに置く理由)。
/// `scheduler_url` 引数は存在しない — `start_impl` がキーチェーンの保存値から読む
/// (GHSA-j74q-9v5x-87w3 対応、モジュール冒頭コメント参照)。
#[tauri::command]
pub async fn ig_publish_start(
	app: tauri::AppHandle,
	jobs: tauri::State<'_, IgJobsState>,
	job_id: ig::JobId,
	input_path: String,
	caption: String,
	publish_at: i64,
) -> Result<(), String> {
	ig::start_impl(app, jobs, job_id, input_path, caption, publish_at).await
}

/// IG 公開ジョブをキャンセルする(ロジック本体は `ig::cancel_impl`)。
#[tauri::command]
pub fn ig_publish_cancel(
	job_id: ig::JobId,
	jobs: tauri::State<'_, IgJobsState>,
) -> Result<(), String> {
	ig::cancel_impl(job_id, jobs)
}

/// `scheduler_job_id` の現在のジョブ状態(scheduler の `GET /jobs/:id` 応答を分類した
/// [`IgJobStatusOutcome`])を返す(ロジック本体は `ig::job_status_impl`。desktop が
/// IG 予約投稿の最終成否を追跡しない問題への対応、§ig.rs `job_status_impl`/
/// `IgJobStatusOutcome` 冒頭コメント)。`ig_publish_start` と同様 `scheduler_url`/
/// トークンはキーチェーンの保存値からのみ導出し、renderer からは受け取らない。
#[tauri::command]
pub async fn ig_job_status(scheduler_job_id: String) -> Result<IgJobStatusOutcome, String> {
	ig::job_status_impl(scheduler_job_id).await
}

/// YouTube の OAuth クライアント(ユーザー自身の Google Cloud アプリの
/// client_id/client_secret)をキーチェーンへ保存する(既存値は上書き)。
/// 値そのものはログ・エラーメッセージに含めない。
#[tauri::command]
pub fn set_youtube_oauth_client(client_id: String, client_secret: String) -> Result<(), String> {
	youtube_oauth::set_client_impl(&KeyringStore, &client_id, &client_secret)
}

/// 保存済みの OAuth クライアントを削除する(キャッシュ済みトークンも道連れで削除する、
/// §youtube_oauth.rs `delete_client_impl` 冒頭コメント)。
#[tauri::command]
pub fn delete_youtube_oauth_client() -> Result<(), String> {
	youtube_oauth::delete_client_impl(&KeyringStore)
}

/// 現在の YouTube 接続状態(未設定/設定済み未接続/接続済み)を返す。
#[tauri::command]
pub fn youtube_oauth_status() -> Result<YoutubeOauthStatus, String> {
	youtube_oauth::status_impl(&KeyringStore)
}

/// 「Google と接続」ボタンの本体。ブラウザで OAuth 同意フローを行い、成功すれば
/// トークンをキーチェーンへ保存する(§youtube_oauth.rs `connect_impl`)。
#[tauri::command]
pub async fn youtube_oauth_connect() -> Result<(), String> {
	youtube_oauth::connect_impl(&KeyringStore).await
}

/// 接続を切断する(トークンキャッシュのみ削除。OAuth クライアントの設定は保持する)。
#[tauri::command]
pub fn youtube_oauth_disconnect() -> Result<(), String> {
	youtube_oauth::disconnect_impl(&KeyringStore)
}

/// YouTube への動画アップロード + `publishAt` 予約公開を開始する(ロジック本体は
/// `youtube::start_impl`、§youtube.rs `start_impl` 冒頭コメント参照)。
/// 引数の多さは invoke 境界(renderer からの引数列)をそのまま写しているため許容する
/// (`ig_publish_start` と同じ constraint。まとめ用の struct を挟むと tauri の
/// camelCase 変換と二重になるため採らない)。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn youtube_publish_start(
	app: tauri::AppHandle,
	jobs: tauri::State<'_, YoutubeJobsState>,
	job_id: youtube::JobId,
	input_path: String,
	title: String,
	description: String,
	publish_at: Option<i64>,
	privacy_status: Option<String>,
) -> Result<(), String> {
	youtube::start_impl(
		app,
		jobs,
		job_id,
		input_path,
		title,
		description,
		publish_at,
		privacy_status,
	)
	.await
}

/// YouTube 公開ジョブをキャンセルする(ロジック本体は `youtube::cancel_impl`)。
#[tauri::command]
pub fn youtube_publish_cancel(
	job_id: youtube::JobId,
	jobs: tauri::State<'_, YoutubeJobsState>,
) -> Result<(), String> {
	youtube::cancel_impl(job_id, jobs)
}

#[cfg(test)]
mod tests {
	use super::*;
	use credential_store::tests::MemoryStore;

	#[test]
	fn set_then_has_then_delete_roundtrip() {
		let store = MemoryStore::default();
		assert!(!has_token_impl(&store).unwrap());

		set_token_impl(&store, "secret-token").unwrap();
		assert!(has_token_impl(&store).unwrap());

		delete_token_impl(&store).unwrap();
		assert!(!has_token_impl(&store).unwrap());
	}

	#[test]
	fn set_rejects_blank_token() {
		let store = MemoryStore::default();
		assert!(set_token_impl(&store, "   ").is_err());
		assert!(!has_token_impl(&store).unwrap());
	}

	#[test]
	fn delete_without_prior_set_is_idempotent() {
		let store = MemoryStore::default();
		assert!(delete_token_impl(&store).is_ok());
	}

	#[test]
	fn set_then_get_then_delete_scheduler_url_roundtrip() {
		let store = MemoryStore::default();
		assert_eq!(get_scheduler_url_impl(&store).unwrap(), None);

		set_scheduler_url_impl(&store, "https://scheduler.example.workers.dev").unwrap();
		assert_eq!(
			get_scheduler_url_impl(&store).unwrap(),
			Some("https://scheduler.example.workers.dev".to_string())
		);

		delete_scheduler_url_impl(&store).unwrap();
		assert_eq!(get_scheduler_url_impl(&store).unwrap(), None);
	}

	#[test]
	fn set_scheduler_url_rejects_blank() {
		let store = MemoryStore::default();
		assert!(set_scheduler_url_impl(&store, "   ").is_err());
		assert_eq!(get_scheduler_url_impl(&store).unwrap(), None);
	}

	#[test]
	fn set_scheduler_url_rejects_non_loopback_http() {
		let store = MemoryStore::default();
		assert!(set_scheduler_url_impl(&store, "http://evil.example.com").is_err());
		assert_eq!(get_scheduler_url_impl(&store).unwrap(), None);
	}

	#[test]
	fn set_scheduler_url_accepts_loopback_http() {
		let store = MemoryStore::default();
		assert!(set_scheduler_url_impl(&store, "http://127.0.0.1:8787").is_ok());
	}
}
