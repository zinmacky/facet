//! YouTube OAuth(Installed App フロー)+ トークンの OS キーチェーン連携
//! (docs/desktop-migration-plan.md §6.5・§8 Phase 3・§11-3・§11-4)。
//!
//! ## 設計判断: トークンキャッシュの保管先(実装指示への回答)
//!
//! `yup-oauth2`(`InstalledFlowAuthenticator`)は既定では `persist_tokens_to_disk(path)`
//! でトークンキャッシュを平文ファイルへ保存する。本アプリは秘密値を必ず OS キーチェーンへ
//! 置く方針(§11-3、`credential_store.rs`)のため、これはそのままでは使えない。
//!
//! 調査の結果、`AuthenticatorBuilder` は `with_storage(Box<dyn TokenStorage>)` で
//! 保存先を差し替え可能であり(`persist_tokens_to_disk` はこの薄いラッパ)、
//! `TokenStorage` トレイト(`async fn set`/`async fn get`、`#[async_trait]`)を自前実装
//! すれば任意のバックエンドに載せ替えられる。そこで [`KeychainTokenStorage`] を実装し、
//! `TokenInfo`(access_token/refresh_token/expires_at/id_token を含む、serde 対応)を
//! JSON シリアライズして `credential_store::CredentialStore`(OS キーチェーン)へ保存する。
//! これにより「トークンキャッシュを平文ファイルへ書く」という既定動作を経由せずに済む
//! (ファイルへは一切書き込まない)。
//!
//! アプリは常に単一スコープ([`YOUTUBE_UPLOAD_SCOPE`])のみを要求するため、
//! `TokenStorage::set`/`get` の `scopes` 引数はキー分割に使わず無視し、キーチェーンの
//! 単一エントリ(`KEY_YOUTUBE_OAUTH_TOKEN`)に固定する(yup-oauth2 の既定ディスク実装は
//! スコープ集合をキーの一部にするが、本アプリでは資格情報1組=1アカウントの前提のため
//! 不要な複雑化を避けた)。
//!
//! クライアント資格情報(ユーザー自身の Google Cloud アプリの client_id/client_secret)は
//! [`OauthClient`] として別エントリ(`KEY_YOUTUBE_OAUTH_CLIENT`)に保存する。
//! クライアントを差し替えた場合、旧クライアントに紐づく refresh_token は新クライアントの
//! client_secret では検証できず無効になるため、`delete_client_impl` はトークンキャッシュも
//! 道連れで削除する。

use std::time::Duration;

use google_youtube3::yup_oauth2::{
	self, authenticator::Authenticator, storage::TokenInfo, ApplicationSecret,
	InstalledFlowAuthenticator, InstalledFlowReturnMethod,
};
use serde::{Deserialize, Serialize};

use super::credential_store::{CredentialStore, KeyringStore};
use super::{KEY_YOUTUBE_OAUTH_CLIENT, KEY_YOUTUBE_OAUTH_TOKEN, SERVICE};

/// YouTube アップロードに必要な OAuth スコープ(旧 TS 実装と同じ、§6.5)。
pub const YOUTUBE_UPLOAD_SCOPE: &str = "https://www.googleapis.com/auth/youtube.upload";

/// Google の Installed App フロー既定エンドポイント(`client_secret.json` の
/// `installed.auth_uri`/`installed.token_uri` に対応する固定値)。
const AUTH_URI: &str = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URI: &str = "https://oauth2.googleapis.com/token";

/// 対話認可フロー(ブラウザでの同意)の待ち時間上限。ユーザーがブラウザタブを放置した
/// 場合に待ち続けるのを防ぐ。「Google と接続」の invoke(`connect_impl`)と、publish 前の
/// トークン先行取得(`commands::publish::youtube` — refresh 不能時に yup-oauth2 が
/// 対話フローへフォールバックしブラウザが開くケース)の両方で使う。
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// yup-oauth2 既定の hyper クライアント(`InstalledFlowAuthenticator::builder` が
/// 内部で構築する)が使うコネクタ型。長い型を毎回書かないための別名
/// (rustfmt が折り返す前提のシグネチャを避け、可読性を保つ)。
type HyperConnector = google_youtube3::hyper_rustls::HttpsConnector<
	google_youtube3::hyper_util::client::legacy::connect::HttpConnector,
>;
/// `commands::publish::youtube` が publish 実行時に受け取る認証器の型
/// (`build_authenticator_for_publish` の戻り値)。
pub(crate) type YoutubeAuthenticator = Authenticator<HyperConnector>;

/// OAuth クライアント資格情報(ユーザー自身の Google Cloud アプリ)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct OauthClient {
	pub client_id: String,
	pub client_secret: String,
}

/// 設定 UI へ返す接続状態(実装指示 §1: 「接続済み表示+切断ボタン」)。
/// トークン値そのものは含めない(§11-3 の一般方針)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum YoutubeOauthStatus {
	/// client_id/client_secret 未設定。
	NotConfigured,
	/// client_id/client_secret は設定済みだが未接続(トークン未取得)。
	Configured,
	/// 接続済み(トークンキャッシュあり)。
	Connected,
}

// ---- クライアント資格情報(CredentialStore 抽象越し。テストは MemoryStore で行う) ----

pub(crate) fn set_client_impl(
	store: &dyn CredentialStore,
	client_id: &str,
	client_secret: &str,
) -> Result<(), String> {
	let client_id = client_id.trim();
	let client_secret = client_secret.trim();
	if client_id.is_empty() || client_secret.is_empty() {
		return Err("クライアントIDとクライアントシークレットは必須です。".to_string());
	}
	let client = OauthClient {
		client_id: client_id.to_string(),
		client_secret: client_secret.to_string(),
	};
	let json = serde_json::to_string(&client)
		.map_err(|err| format!("OAuth クライアントのシリアライズに失敗しました: {err}"))?;
	store.set(SERVICE, KEY_YOUTUBE_OAUTH_CLIENT, &json)
}

pub(crate) fn has_client_impl(store: &dyn CredentialStore) -> Result<bool, String> {
	Ok(store.get(SERVICE, KEY_YOUTUBE_OAUTH_CLIENT)?.is_some())
}

pub(crate) fn get_client_impl(store: &dyn CredentialStore) -> Result<Option<OauthClient>, String> {
	let Some(json) = store.get(SERVICE, KEY_YOUTUBE_OAUTH_CLIENT)? else {
		return Ok(None);
	};
	serde_json::from_str(&json)
		.map(Some)
		.map_err(|err| format!("OAuth クライアントの読み取りに失敗しました: {err}"))
}

/// クライアント資格情報とキャッシュ済みトークンの両方を削除する(モジュール冒頭コメント参照)。
pub(crate) fn delete_client_impl(store: &dyn CredentialStore) -> Result<(), String> {
	store.delete(SERVICE, KEY_YOUTUBE_OAUTH_TOKEN)?;
	store.delete(SERVICE, KEY_YOUTUBE_OAUTH_CLIENT)
}

// ---- トークンキャッシュ(CredentialStore 抽象越し。KeychainTokenStorage から使う) ----

pub(crate) fn has_token_impl(store: &dyn CredentialStore) -> Result<bool, String> {
	Ok(store.get(SERVICE, KEY_YOUTUBE_OAUTH_TOKEN)?.is_some())
}

/// 接続を切断する(トークンキャッシュのみ削除。クライアント資格情報は保持するため、
/// 再接続時に client_id/secret を入力し直す必要はない)。
pub(crate) fn disconnect_impl(store: &dyn CredentialStore) -> Result<(), String> {
	store.delete(SERVICE, KEY_YOUTUBE_OAUTH_TOKEN)
}

fn token_set_impl(store: &dyn CredentialStore, token: &TokenInfo) -> Result<(), String> {
	let json = serde_json::to_string(token)
		.map_err(|err| format!("トークンのシリアライズに失敗しました: {err}"))?;
	store.set(SERVICE, KEY_YOUTUBE_OAUTH_TOKEN, &json)
}

fn token_get_impl(store: &dyn CredentialStore) -> Option<TokenInfo> {
	let json = store.get(SERVICE, KEY_YOUTUBE_OAUTH_TOKEN).ok().flatten()?;
	serde_json::from_str(&json).ok()
}

/// yup-oauth2 の `InstalledFlowDelegate` を差し替え、認可 URL を OS 既定ブラウザで
/// 開く(実装指示 §1: 「Google と接続」ボタン → ブラウザが開く)。
///
/// 既定の `DefaultInstalledFlowDelegate` は URL を **stdout に println するだけ**で、
/// GUI アプリではユーザーから見えない(ブラウザが開かず無反応に見える)ため必須の
/// 差し替え。ブラウザ起動には既存依存の `tauri-plugin-opener`(renderer の
/// 「フォルダで表示」等で導入済み)の Rust 側 API を使う — 新規クレート
/// (`webbrowser` 等)を増やさない。
struct BrowserOpeningFlowDelegate;

impl yup_oauth2::authenticator_delegate::InstalledFlowDelegate for BrowserOpeningFlowDelegate {
	fn present_user_url<'a>(
		&'a self,
		url: &'a str,
		_need_code: bool,
	) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>> {
		Box::pin(async move {
			// HTTPRedirect(ループバック)方式のため need_code は常に false — 認可コードは
			// ローカル HTTP サーバが受け取り、この戻り値(String)は使われない。
			tauri_plugin_opener::open_url(url, None::<&str>)
				.map_err(|err| format!("ブラウザを開けませんでした: {err}"))?;
			Ok(String::new())
		})
	}
}

/// yup-oauth2 の `TokenStorage` を OS キーチェーンへブリッジする(モジュール冒頭コメント参照)。
/// 実体は常に [`KeyringStore`] 固定(`commands::publish` 内の他モジュールと同じ分担:
/// ロジック本体は `&dyn CredentialStore` 越しにテストし、この型自体は薄い配線に留める)。
pub(crate) struct KeychainTokenStorage;

#[async_trait::async_trait]
impl yup_oauth2::storage::TokenStorage for KeychainTokenStorage {
	async fn set(
		&self,
		_scopes: &[&str],
		token: TokenInfo,
	) -> Result<(), yup_oauth2::storage::TokenStorageError> {
		token_set_impl(&KeyringStore, &token)
			.map_err(|err| yup_oauth2::storage::TokenStorageError::Other(err.into()))
	}

	async fn get(&self, _scopes: &[&str]) -> Option<TokenInfo> {
		token_get_impl(&KeyringStore)
	}
}

/// [`OauthClient`] から `InstalledFlowAuthenticator` を組み立てる。
async fn build_authenticator(client: &OauthClient) -> Result<YoutubeAuthenticator, String> {
	let secret = ApplicationSecret {
		client_id: client.client_id.clone(),
		client_secret: client.client_secret.clone(),
		auth_uri: AUTH_URI.to_string(),
		token_uri: TOKEN_URI.to_string(),
		// Installed App(ループバックリダイレクト)フローではポートを実行時に選ぶため
		// ここでの値は使われない(HTTPRedirect が動的に "http://localhost:<port>" を使う)。
		redirect_uris: vec!["http://localhost".to_string()],
		..Default::default()
	};

	InstalledFlowAuthenticator::builder(secret, InstalledFlowReturnMethod::HTTPRedirect)
		.with_storage(Box::new(KeychainTokenStorage))
		.flow_delegate(Box::new(BrowserOpeningFlowDelegate))
		.build()
		.await
		.map_err(|err| format!("OAuth 認証器の初期化に失敗しました: {err}"))
}

/// 「Google と接続」ボタンの本体。ブラウザで同意フローを行い、成功すればトークンが
/// [`KeychainTokenStorage`] 経由でキーチェーンへ保存される。既にキャッシュに有効な
/// トークン(または refresh 可能なトークン)があれば、ブラウザは開かず即座に成功する
/// (yup-oauth2 の既定挙動)。
pub(crate) async fn connect_impl(store: &dyn CredentialStore) -> Result<(), String> {
	let client = get_client_impl(store)?.ok_or_else(|| {
		"YouTube の OAuth クライアント(クライアントID/シークレット)が未設定です。設定画面から入力してください。".to_string()
	})?;

	let auth = build_authenticator(&client).await?;
	let scopes = &[YOUTUBE_UPLOAD_SCOPE];

	match tokio::time::timeout(CONNECT_TIMEOUT, auth.token(scopes)).await {
		Ok(Ok(_token)) => Ok(()),
		// yup-oauth2 の `Error` の Display はトークン交換のサーバ応答
		// (`error`/`error_description`)や I/O エラーの説明で、リクエスト側の秘密値
		// (client_secret・トークン)は含まないため、診断のためそのまま添える
		// (§credential_store::sanitize_err の方針との整合はこのコメントで根拠付ける)。
		Ok(Err(err)) => Err(format!("Google との認可に失敗しました: {err}")),
		Err(_) => Err("認可がタイムアウトしました(5分)。もう一度お試しください。".to_string()),
	}
}

/// 現在の接続状態を返す(実装指示 §1: 接続済み表示)。ネットワークには一切触れず、
/// キーチェーンの保存状態のみで判定する(トークンの実際の有効性は publish 実行時に
/// 401 として顕在化する、§youtube.rs 参照)。
pub(crate) fn status_impl(store: &dyn CredentialStore) -> Result<YoutubeOauthStatus, String> {
	if !has_client_impl(store)? {
		return Ok(YoutubeOauthStatus::NotConfigured);
	}
	if has_token_impl(store)? {
		return Ok(YoutubeOauthStatus::Connected);
	}
	Ok(YoutubeOauthStatus::Configured)
}

/// [`connect_impl`] が使う `Authenticator` を publish 実行時にも再構築するための
/// ヘルパ(`commands::publish::youtube` から呼ぶ)。トークンは [`KeychainTokenStorage`]
/// 経由でキャッシュから復元され、期限切れなら refresh_token で自動更新される
/// (yup-oauth2 の既定挙動。再度ブラウザは開かない)。
pub(crate) async fn build_authenticator_for_publish(
	store: &dyn CredentialStore,
) -> Result<YoutubeAuthenticator, String> {
	let client = get_client_impl(store)?.ok_or_else(|| {
		"YouTube の OAuth クライアントが未設定です。設定画面から入力してください。".to_string()
	})?;
	if !has_token_impl(store)? {
		return Err(
			"YouTube に接続されていません。設定画面から「Google と接続」を行ってください。"
				.to_string(),
		);
	}
	build_authenticator(&client).await
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::commands::publish::credential_store::tests::MemoryStore;

	/// `TokenInfo` は `Default` を実装しないため、テスト用の空トークンを組み立てる。
	fn empty_token() -> TokenInfo {
		TokenInfo {
			access_token: None,
			refresh_token: None,
			expires_at: None,
			id_token: None,
		}
	}

	#[test]
	fn set_then_has_then_get_client_roundtrip() {
		let store = MemoryStore::default();
		assert!(!has_client_impl(&store).unwrap());

		set_client_impl(&store, "client-id", "client-secret").unwrap();
		assert!(has_client_impl(&store).unwrap());

		let client = get_client_impl(&store).unwrap().unwrap();
		assert_eq!(client.client_id, "client-id");
		assert_eq!(client.client_secret, "client-secret");
	}

	#[test]
	fn set_client_rejects_blank_fields() {
		let store = MemoryStore::default();
		assert!(set_client_impl(&store, "", "secret").is_err());
		assert!(set_client_impl(&store, "id", "").is_err());
		assert!(set_client_impl(&store, "   ", "   ").is_err());
		assert!(!has_client_impl(&store).unwrap());
	}

	#[test]
	fn delete_client_also_clears_cached_token() {
		let store = MemoryStore::default();
		set_client_impl(&store, "client-id", "client-secret").unwrap();
		token_set_impl(&store, &empty_token()).unwrap();
		assert!(has_client_impl(&store).unwrap());
		assert!(has_token_impl(&store).unwrap());

		delete_client_impl(&store).unwrap();

		assert!(!has_client_impl(&store).unwrap());
		assert!(!has_token_impl(&store).unwrap());
	}

	#[test]
	fn disconnect_clears_token_but_keeps_client() {
		let store = MemoryStore::default();
		set_client_impl(&store, "client-id", "client-secret").unwrap();
		token_set_impl(&store, &empty_token()).unwrap();

		disconnect_impl(&store).unwrap();

		assert!(has_client_impl(&store).unwrap());
		assert!(!has_token_impl(&store).unwrap());
	}

	#[test]
	fn token_set_then_get_roundtrips_via_json() {
		let store = MemoryStore::default();
		let mut token = empty_token();
		token.access_token = Some("access-123".to_string());
		token.refresh_token = Some("refresh-456".to_string());

		token_set_impl(&store, &token).unwrap();
		let restored = token_get_impl(&store).unwrap();
		assert_eq!(restored.access_token, Some("access-123".to_string()));
		assert_eq!(restored.refresh_token, Some("refresh-456".to_string()));
	}

	#[test]
	fn status_transitions_not_configured_to_configured_to_connected() {
		let store = MemoryStore::default();
		assert_eq!(
			status_impl(&store).unwrap(),
			YoutubeOauthStatus::NotConfigured
		);

		set_client_impl(&store, "client-id", "client-secret").unwrap();
		assert_eq!(status_impl(&store).unwrap(), YoutubeOauthStatus::Configured);

		token_set_impl(&store, &empty_token()).unwrap();
		assert_eq!(status_impl(&store).unwrap(), YoutubeOauthStatus::Connected);
	}

	/// 実 Google に対する対話認可の手動確認(既定のブラウザが開き、Google の同意画面で
	/// 承認する必要がある)。実行前に OS キーチェーンへ実クライアントを保存しておくこと
	/// (private ビルドの設定画面から入力するか、本テストの前に `set_client_impl` 相当を
	/// 実キーチェーンに対して行う)。実行:
	/// `cargo test --features publish -- --ignored connect_against_real_google`
	/// 成功すればトークンがキーチェーン(`youtube_oauth_refresh_token`)に保存され、
	/// 2回目以降はブラウザを開かず即座に成功する(トークンキャッシュの検証)。
	#[tokio::test]
	#[ignore = "実 Google に接続しブラウザが開く。手動確認専用(CI では実行しない)"]
	async fn connect_against_real_google_interactive() {
		connect_impl(&KeyringStore).await.unwrap();
		assert!(has_token_impl(&KeyringStore).unwrap());
		assert_eq!(
			status_impl(&KeyringStore).unwrap(),
			YoutubeOauthStatus::Connected
		);
	}
}
