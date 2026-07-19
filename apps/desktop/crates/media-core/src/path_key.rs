//! パス比較のための正規化ヘルパ。
//!
//! 以下の 2 箇所が、大文字小文字を区別しないファイルシステム(macOS の APFS /
//! Windows の NTFS)や `..` を含む相対パス表記の違いを吸収して「同一ファイルを
//! 指しているか」を判定する必要があり、同じ正規化規則を共有する:
//!
//! - `pipeline::JobPathRegistry`(クロスジョブの入出力パス競合検知。同一プロセス内で
//!   実行中の他ジョブの入力/出力とパスが交差していないかをキーの一致で判定する)。
//! - `src-tauri/src/commands/reframe.rs` の `output_targets_input`(同一ジョブの
//!   出力が入力と同じファイルを指していないかを判定する。データ損失バグ対策)。
//!
//! 元々は `reframe.rs` にのみ存在したが(PR #127)、`media-core` 側にも同じ正規化が
//! 必要になったため(本モジュール追加時の PR)、`media-core`(Tauri 非依存)へ移設し、
//! 両方から参照する一本化された実装とした。

use std::fs;
use std::path::{Path, PathBuf};

/// `path` を `fs::canonicalize` する。`path` 自体が存在しなくても、親ディレクトリが
/// 実在すれば「親ディレクトリの実体パス + ファイル名」で組み立てて返す(これから
/// 書き出す出力パスのように、まだ存在しないファイルも比較できるようにするため)。
/// 親ディレクトリも実在しない、またはファイル名を取り出せない場合は `Err` を返す
/// (呼び出し側は素のパス比較へフォールバックする)。
pub fn canonicalize_existing_or_missing(path: &Path) -> std::io::Result<PathBuf> {
	if let Ok(canonical) = fs::canonicalize(path) {
		return Ok(canonical);
	}
	let file_name = path.file_name().ok_or_else(|| {
		std::io::Error::new(
			std::io::ErrorKind::InvalidInput,
			format!("ファイル名を取り出せません: {}", path.display()),
		)
	})?;
	let parent = match path.parent() {
		Some(parent) if !parent.as_os_str().is_empty() => parent,
		_ => Path::new("."),
	};
	let canonical_parent = fs::canonicalize(parent)?;
	Ok(canonical_parent.join(file_name))
}

/// レジストリのキーや比較用に `path` を正規化する。
/// [`canonicalize_existing_or_missing`] が失敗した場合(親ディレクトリも存在しない等)
/// は、素のパスをそのままキーとして使う(誤検知で正当な書き出しをブロックしないための
/// 保守的フォールバック。完全一致以外の綴り違いは見逃しうるが、既存挙動からの後退は
/// ない)。
pub fn normalize_path_key(path: &Path) -> PathBuf {
	canonicalize_existing_or_missing(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::time::{SystemTime, UNIX_EPOCH};

	fn unique_test_dir(name: &str) -> PathBuf {
		let nanos = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map(|d| d.as_nanos())
			.unwrap_or(0);
		let dir = std::env::temp_dir().join(format!("facet-path-key-test-{name}-{nanos}"));
		fs::create_dir_all(&dir).expect("create unique test dir");
		dir
	}

	#[test]
	fn canonicalize_existing_or_missing_resolves_existing_file() {
		let dir = unique_test_dir("existing");
		let path = dir.join("video.mp4");
		fs::write(&path, b"dummy").expect("write dummy file");

		let canonical = canonicalize_existing_or_missing(&path).expect("should canonicalize");
		assert_eq!(canonical, fs::canonicalize(&path).unwrap());

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn canonicalize_existing_or_missing_resolves_missing_file_via_parent() {
		let dir = unique_test_dir("missing");
		let path = dir.join("not-yet-created.mp4");

		let canonical = canonicalize_existing_or_missing(&path).expect("should canonicalize");
		assert_eq!(
			canonical,
			fs::canonicalize(&dir).unwrap().join("not-yet-created.mp4")
		);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn canonicalize_existing_or_missing_errs_when_parent_missing() {
		let dir = unique_test_dir("no-parent");
		let path = dir.join("does-not-exist").join("video.mp4");

		assert!(canonicalize_existing_or_missing(&path).is_err());

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn normalize_path_key_falls_back_to_raw_path_when_canonicalize_fails() {
		let path = Path::new("/definitely/does/not/exist/video.mp4");
		assert_eq!(normalize_path_key(path), path.to_path_buf());
	}
}
