//! R2(Cloudflare, S3 互換)資格情報の OS キーチェーン連携。
//! `credential_store.rs`(scheduler API トークン)と同じ `CredentialStore` 抽象を使い、
//! ロジック本体([`set_impl`]/[`has_impl`]/[`delete_impl`]/[`get_impl`])を
//! `#[tauri::command]` から分離してテスト容易にする(`mod.rs` 冒頭コメントの方針と同じ)。
//!
//! account_id/access_key_id/secret_access_key/bucket の4フィールドは常に一組で
//! 保存・削除されるため、キーチェーンのエントリを4つに分けず、1つの JSON 値として
//! 保存する(`crate::jobs::sigv4::R2Credentials` を再利用し、シリアライズ形状の
//! 二重管理を避ける)。

use crate::jobs::sigv4::R2Credentials;

use super::credential_store::CredentialStore;
use super::{KEY_R2_CREDENTIALS, SERVICE};

/// R2 のバケット名を省略した場合の既定値(旧 TS 実装 `config.ts` の
/// `R2_BUCKET.default("facet-media")` に対応)。
pub const DEFAULT_BUCKET: &str = "facet-media";

pub(crate) fn set_impl(
	store: &dyn CredentialStore,
	account_id: &str,
	access_key_id: &str,
	secret_access_key: &str,
	bucket: &str,
) -> Result<(), String> {
	let account_id = account_id.trim();
	let access_key_id = access_key_id.trim();
	let secret_access_key = secret_access_key.trim();
	let bucket = bucket.trim();

	if account_id.is_empty() || access_key_id.is_empty() || secret_access_key.is_empty() {
		return Err(
			"R2 のアカウント ID・アクセスキー ID・シークレットアクセスキーは必須です。".to_string(),
		);
	}

	let credentials = R2Credentials {
		account_id: account_id.to_string(),
		access_key_id: access_key_id.to_string(),
		secret_access_key: secret_access_key.to_string(),
		bucket: if bucket.is_empty() {
			DEFAULT_BUCKET.to_string()
		} else {
			bucket.to_string()
		},
	};
	let json = serde_json::to_string(&credentials)
		.map_err(|err| format!("R2 資格情報のシリアライズに失敗しました: {err}"))?;
	store.set(SERVICE, KEY_R2_CREDENTIALS, &json)
}

pub(crate) fn has_impl(store: &dyn CredentialStore) -> Result<bool, String> {
	Ok(store.get(SERVICE, KEY_R2_CREDENTIALS)?.is_some())
}

pub(crate) fn delete_impl(store: &dyn CredentialStore) -> Result<(), String> {
	store.delete(SERVICE, KEY_R2_CREDENTIALS)
}

/// 保存済みの R2 資格情報を取得する(値そのものを返すため、フロントへ渡す
/// invoke コマンドは持たない — `commands::publish::ig` が内部的に使うのみ)。
pub(crate) fn get_impl(store: &dyn CredentialStore) -> Result<Option<R2Credentials>, String> {
	let Some(json) = store.get(SERVICE, KEY_R2_CREDENTIALS)? else {
		return Ok(None);
	};
	serde_json::from_str(&json)
		.map(Some)
		.map_err(|err| format!("R2 資格情報の読み取りに失敗しました: {err}"))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::commands::publish::credential_store::tests::MemoryStore;

	#[test]
	fn set_then_get_roundtrips_all_fields() {
		let store = MemoryStore::default();
		set_impl(&store, "acc", "key", "secret", "my-bucket").unwrap();

		assert!(has_impl(&store).unwrap());
		let creds = get_impl(&store).unwrap().unwrap();
		assert_eq!(creds.account_id, "acc");
		assert_eq!(creds.access_key_id, "key");
		assert_eq!(creds.secret_access_key, "secret");
		assert_eq!(creds.bucket, "my-bucket");
	}

	#[test]
	fn set_falls_back_to_default_bucket_when_blank() {
		let store = MemoryStore::default();
		set_impl(&store, "acc", "key", "secret", "   ").unwrap();
		let creds = get_impl(&store).unwrap().unwrap();
		assert_eq!(creds.bucket, DEFAULT_BUCKET);
	}

	#[test]
	fn set_rejects_missing_required_fields() {
		let store = MemoryStore::default();
		assert!(set_impl(&store, "", "key", "secret", "bucket").is_err());
		assert!(set_impl(&store, "acc", "", "secret", "bucket").is_err());
		assert!(set_impl(&store, "acc", "key", "", "bucket").is_err());
		assert!(!has_impl(&store).unwrap());
	}

	#[test]
	fn has_is_false_before_set_and_after_delete() {
		let store = MemoryStore::default();
		assert!(!has_impl(&store).unwrap());

		set_impl(&store, "acc", "key", "secret", "bucket").unwrap();
		assert!(has_impl(&store).unwrap());

		delete_impl(&store).unwrap();
		assert!(!has_impl(&store).unwrap());
		assert!(get_impl(&store).unwrap().is_none());
	}

	#[test]
	fn delete_without_prior_set_is_idempotent() {
		let store = MemoryStore::default();
		assert!(delete_impl(&store).is_ok());
	}
}
