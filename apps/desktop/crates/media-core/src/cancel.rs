//! パイプライン(`pipeline::reframe`)の実行を外部から中断するための、
//! クローン可能・スレッド安全なキャンセルトークン。
//!
//! `pipeline.rs` はもともと `&dyn Fn() -> bool` クロージャでキャンセル判定を
//! 受け取っていたが、Tauri コマンド側は「コマンドハンドラのスレッド/非同期タスクが
//! トークンを保持し、別のキャンセルコマンドが `cancel()` を呼ぶ」という構図になるため、
//! クロージャの寿命に縛られない値として持ち回れる型が必要になる。[`CancelToken`] は
//! これに応える最小実装で、内部状態は `Arc<AtomicBool>` のみ(`tokio` 等の非同期
//! ランタイムには依存しない — media-core は同期クレートのまま)。
//!
//! ## Tauri 側での想定用法
//!
//! ```ignore
//! // コマンドハンドラ側(reframe 実行スレッド):
//! let token = CancelToken::new();
//! state.jobs.insert(job_id, token.clone()); // ハンドル側で保持
//! std::thread::spawn(move || {
//!     let options = ReframeOptions { cancel: &token, /* ... */ };
//!     let _ = media_core::reframe(&input, &output, options);
//! });
//!
//! // 別コマンド(`cancel_job` 等)から:
//! if let Some(token) = state.jobs.get(&job_id) {
//!     token.cancel();
//! }
//! ```
//!
//! `pipeline::run_pipeline` はループ境界(パケット単位)で
//! [`CancelToken::is_cancelled`] を都度チェックし、`true` を検知した時点で
//! 一時出力ファイルを削除してから `MediaError::Cancelled` を返す(`pipeline.rs`
//! 冒頭コメント参照)。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// クローン可能・スレッド安全なキャンセルフラグ。
///
/// クローンされたすべてのトークンは同一の内部フラグを共有する
/// (`Arc` によるコピーなので、どのクローンから `cancel()` を呼んでも
/// 他のすべてのクローンの [`is_cancelled`](Self::is_cancelled) が `true` を返すようになる)。
#[derive(Debug, Clone)]
pub struct CancelToken {
	cancelled: Arc<AtomicBool>,
}

impl CancelToken {
	/// 未キャンセル状態の新しいトークンを作成する。
	pub fn new() -> Self {
		CancelToken {
			cancelled: Arc::new(AtomicBool::new(false)),
		}
	}

	/// トークン(および共有元を同じくするすべてのクローン)をキャンセル状態にする。
	///
	/// 何度呼んでも安全(冪等)。
	pub fn cancel(&self) {
		self.cancelled.store(true, Ordering::SeqCst);
	}

	/// キャンセル済みかどうかを返す。
	pub fn is_cancelled(&self) -> bool {
		self.cancelled.load(Ordering::SeqCst)
	}
}

impl Default for CancelToken {
	fn default() -> Self {
		Self::new()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn starts_uncancelled() {
		let token = CancelToken::new();
		assert!(!token.is_cancelled());
	}

	#[test]
	fn cancel_sets_flag() {
		let token = CancelToken::new();
		token.cancel();
		assert!(token.is_cancelled());
	}

	#[test]
	fn clones_share_state() {
		let token = CancelToken::new();
		let clone = token.clone();
		assert!(!clone.is_cancelled());

		clone.cancel();

		assert!(token.is_cancelled());
		assert!(clone.is_cancelled());
	}

	#[test]
	fn cancel_is_visible_across_threads() {
		let token = CancelToken::new();
		let worker_token = token.clone();

		let handle = std::thread::spawn(move || {
			while !worker_token.is_cancelled() {
				std::thread::yield_now();
			}
		});

		token.cancel();
		handle.join().expect("worker thread should not panic");

		assert!(token.is_cancelled());
	}

	#[test]
	fn default_starts_uncancelled() {
		let token = CancelToken::default();
		assert!(!token.is_cancelled());
	}
}
