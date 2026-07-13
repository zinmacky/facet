//! OS キーチェーン連携のトレイト分離(v2.4, docs/desktop-migration-plan.md §11-3)。
//!
//! `CredentialStore` を挟むことで、本体(mod.rs)のコマンドロジック(空トークン拒否・
//! 冪等 delete 等)を実 OS キーチェーンに触れずにテストできる(`MemoryStore`、
//! 下記 `#[cfg(test)]`)。実体である `KeyringStore` 自体の往復テストは、CI(ubuntu)に
//! Secret Service(D-Bus)が存在せず不安定なため `#[ignore]` で隔離する
//! (手元 or 実機で `cargo test --features publish -- --ignored` を使う)。

/// 資格情報ストアの抽象。service/username の組で 1 つの値を保持する。
/// `Send + Sync` を要求するのは、`&dyn CredentialStore` を async な Tauri コマンド
/// (`youtube_oauth_connect` / `youtube_publish_start`)の await 境界をまたいで保持する
/// ため(tauri の `generate_handler!` は Future に `Send` を要求する)。
pub trait CredentialStore: Send + Sync {
	/// 値を保存する(既存値があれば上書き)。
	fn set(&self, service: &str, username: &str, value: &str) -> Result<(), String>;
	/// 値を取得する。未保存(NoEntry 相当)なら `Ok(None)`。
	fn get(&self, service: &str, username: &str) -> Result<Option<String>, String>;
	/// 値を削除する。未保存でも `Ok(())`(冪等)。
	fn delete(&self, service: &str, username: &str) -> Result<(), String>;
}

/// 実体。macOS は Keychain Services、Windows は Credential Manager、
/// *nix は Secret Service を `keyring` クレート(既定 feature "v1")が選択する。
pub struct KeyringStore;

impl CredentialStore for KeyringStore {
	fn set(&self, service: &str, username: &str, value: &str) -> Result<(), String> {
		let entry = keyring::Entry::new(service, username).map_err(sanitize_err)?;
		entry.set_password(value).map_err(sanitize_err)
	}

	fn get(&self, service: &str, username: &str) -> Result<Option<String>, String> {
		let entry = keyring::Entry::new(service, username).map_err(sanitize_err)?;
		match entry.get_password() {
			Ok(value) => Ok(Some(value)),
			Err(keyring::Error::NoEntry) => Ok(None),
			Err(err) => Err(sanitize_err(err)),
		}
	}

	fn delete(&self, service: &str, username: &str) -> Result<(), String> {
		let entry = keyring::Entry::new(service, username).map_err(sanitize_err)?;
		match entry.delete_credential() {
			Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
			Err(err) => Err(sanitize_err(err)),
		}
	}
}

/// `keyring::Error` を安全な(値を含まない)固定文言へ変換する。
///
/// `BadEncoding`/`BadDataFormat` は保存されていた生バイト列を保持しているため、
/// `Debug`/`Display` をそのまま renderer 側のエラーメッセージへ流さない
/// (トークン値の漏洩防止。エラーメッセージにも秘密値を含めない方針、§実装指示)。
/// `keyring::Error` は `#[non_exhaustive]` なのでワイルドカードアームが必須。
fn sanitize_err(err: keyring::Error) -> String {
	match err {
		keyring::Error::NoEntry => "資格情報が保存されていません。".to_string(),
		keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_) => {
			"OS のキーチェーンにアクセスできませんでした。".to_string()
		}
		_ => "キーチェーン操作に失敗しました。".to_string(),
	}
}

#[cfg(test)]
pub(crate) mod tests {
	use super::*;
	use std::collections::HashMap;
	use std::sync::Mutex;

	/// テスト用のインメモリ実装。実 OS キーチェーンには一切触れない。
	#[derive(Default)]
	pub(crate) struct MemoryStore(Mutex<HashMap<(String, String), String>>);

	impl CredentialStore for MemoryStore {
		fn set(&self, service: &str, username: &str, value: &str) -> Result<(), String> {
			self.0.lock().unwrap().insert(
				(service.to_string(), username.to_string()),
				value.to_string(),
			);
			Ok(())
		}

		fn get(&self, service: &str, username: &str) -> Result<Option<String>, String> {
			Ok(self
				.0
				.lock()
				.unwrap()
				.get(&(service.to_string(), username.to_string()))
				.cloned())
		}

		fn delete(&self, service: &str, username: &str) -> Result<(), String> {
			self.0
				.lock()
				.unwrap()
				.remove(&(service.to_string(), username.to_string()));
			Ok(())
		}
	}

	#[test]
	fn memory_store_roundtrip() {
		let store = MemoryStore::default();
		assert_eq!(store.get("svc", "user").unwrap(), None);

		store.set("svc", "user", "value1").unwrap();
		assert_eq!(
			store.get("svc", "user").unwrap(),
			Some("value1".to_string())
		);

		store.set("svc", "user", "value2").unwrap();
		assert_eq!(
			store.get("svc", "user").unwrap(),
			Some("value2".to_string())
		);

		store.delete("svc", "user").unwrap();
		assert_eq!(store.get("svc", "user").unwrap(), None);

		// 未保存の delete は冪等(エラーにならない)。
		store.delete("svc", "user").unwrap();
	}

	/// 実 OS キーチェーンに実際に書き込む往復テスト。CI(ubuntu)には Secret Service
	/// (D-Bus セッション + gnome-keyring 等)が無く不安定なため CI では実行しない。
	/// 手元(macOS Keychain)・Windows 実機(Credential Manager)で
	/// `cargo test --features publish -- --ignored` により手動確認する
	/// (Windows 実機での動作確認は未検証 — 最終報告参照)。
	#[test]
	#[ignore = "実 OS キーチェーンに書き込む。CI や sandbox では実行しない"]
	fn keyring_store_roundtrip_against_real_os_keychain() {
		let store = KeyringStore;
		let service = "com.facet.desktop.private.test";
		let username = "credential-store-roundtrip-test";

		store.set(service, username, "dummy-token").unwrap();
		assert_eq!(
			store.get(service, username).unwrap(),
			Some("dummy-token".to_string())
		);

		store.delete(service, username).unwrap();
		assert_eq!(store.get(service, username).unwrap(), None);
	}
}
