//! Phase 3(IG/YouTube 公開連携)の土台。`publish` cargo feature が有効なビルド
//! (private エディション。build:mac-private 等)でのみコンパイルされる
//! (§commands/mod.rs の `#[cfg(feature = "publish")]`、docs/desktop-migration-plan.md §6.6)。
//!
//! このモジュールが持つのは「資格情報設定 + OS キーチェーン + 実行時ゲート」
//! (v2.4 §11-3・§6.6)のみ。IG(R2 アップロード + POST /jobs)・YouTube(OAuth +
//! アップロード)本体のコマンドは Phase 3 本体(後続 PR)でここに追加する。
//!
//! - [`credential_store`]: OS キーチェーン連携のトレイト分離(テスト容易性のため)。
//! - [`scheduler_check`]: scheduler への2段階疎通チェック(health → Bearer 認証)。
//!
//! トークン値そのものを返す invoke コマンドは存在しない(get 系は「保存済みか」の
//! boolean のみを返す。§実装方針)。set は値を受け取るが、ログ・エラーメッセージに
//! 値を含めない(credential_store.rs の `sanitize_err` 参照)。

mod credential_store;
mod scheduler_check;

use credential_store::{CredentialStore, KeyringStore};
use scheduler_check::perform_check;
pub use scheduler_check::ConnectionCheckResult;

/// キーチェーンのサービス名前空間。private エディション専用の識別子を使い、他アプリ
/// (や将来の public エディション)の資格情報と衝突しないようにする(§11-3)。
const SERVICE: &str = "com.facet.desktop.private";

/// scheduler の Bearer トークンのキーチェーン内 username。
const KEY_SCHEDULER_API_TOKEN: &str = "scheduler_api_token";

// YouTube OAuth 実装(Phase 3 本体、後続 PR)で使う予定のキー名。今はまだ未使用のため
// 定数だけ予約し、実際の set/get コマンドは追加しない。
#[allow(dead_code)]
const KEY_YOUTUBE_OAUTH_REFRESH_TOKEN: &str = "youtube_oauth_refresh_token";

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

/// scheduler への疎通を2段階(health → Bearer 認証)で確認する。
/// トークン値はここでキーチェーンから読み出すのみで、renderer へは返さない
/// (戻り値は判別可能な enum のみ、§scheduler_check::ConnectionCheckResult)。
#[tauri::command]
pub async fn check_scheduler_connection(
	scheduler_url: String,
) -> Result<ConnectionCheckResult, String> {
	let token = KeyringStore.get(SERVICE, KEY_SCHEDULER_API_TOKEN)?;
	Ok(perform_check(&scheduler_url, token.as_deref()).await)
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
}
