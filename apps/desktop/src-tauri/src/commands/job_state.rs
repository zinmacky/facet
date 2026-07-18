//! 実行中ジョブの [`CancelToken`] を保持する State の共通実装。
//!
//! ## 統一した経緯(アーキテクチャレビュー指摘対応)
//!
//! `reframe`/`preview` 共有の `JobsState`(旧 `commands::reframe::JobsState`)、
//! `commands::publish::ig::IgJobsState`、`commands::publish::youtube::YoutubeJobsState` の
//! 3つは `Mutex<HashMap<JobId, CancelToken>>` を core とする実質同一の実装をそれぞれ
//! 個別に持っていた。IG 実装時点では「2つ目の実装が現れてから共有する」(YAGNI)方針に
//! 従い意図的に独立させていたが(旧 `ig.rs` 冒頭コメント参照)、YouTube が3つ目の実装
//! として追加された時点でその判断基準は既に超えていた。
//!
//! さらに実害が生じていた: GHSA-6cx9-j28r-f866 対応で IG 実装にのみ `try_register`
//! (`HashMap::entry` による TOCTOU 安全な「未登録なら登録、登録済みなら拒否」)が
//! 入ったが、重複実装のため reframe/preview・YouTube には**修正が伝播しなかった**
//! (素の `register` = 無条件上書きのままだった)。この「修正が広がらない」実害を踏まえ、
//! 3実装の共通部分を本モジュールへ統一する。
//!
//! ## ジョブ ID 空間の分離は維持する
//!
//! reframe/preview・IG・YouTube はそれぞれ独立したジョブ ID 空間を持つ(異なる
//! 呼び出し元が同じ `job_id` を偶然使っても互いに干渉しない設計。旧 `ig.rs`/`youtube.rs`
//! 冒頭コメントの判断を維持する)。Tauri の `State<T>` は型ごとにインスタンスを管理する
//! ため、統一後も各ドメイン(`reframe`/`ig`/`youtube`)は本モジュールの [`JobsState`] を
//! ラップした専用の newtype(例: `reframe::JobsState`, `publish::ig::IgJobsState`)を
//! それぞれ定義し、個別に `tauri::Builder::manage` へ登録する。trait やジェネリクスは
//! 導入しない(シンプルさ優先。newtype + `Deref` で委譲するだけの薄いラップに留める)。
//!
//! ## `try_register` を唯一の登録 API にした理由
//!
//! 統一前は素の `register`(既存トークンを無条件に上書き)を使う経路が reframe/preview・
//! YouTube に残っていた。renderer は毎回 `crypto.randomUUID()` で新規採番するため実運用上
//! の衝突はほぼ起きないが、「同じ job_id での二重開始を API レベルで拒否できる」設計の
//! 方が壊れにくい(IG で先行導入済みの安全側の挙動に統一する)。そのため `register` は
//! 廃止し、[`JobsState::try_register`](JobsState::try_register)(登録できたら `true`、
//! 既に実行中なら何もせず `false`)のみを公開する。

use std::collections::HashMap;
use std::sync::Mutex;

use media_core::CancelToken;

/// 呼び出し元(renderer)が採番するジョブ ID(reframe/preview・IG・YouTube 共通の型。
/// 各ドメインモジュールはこの型を `pub type JobId = ...;` として再輸出する)。
pub(crate) type JobId = String;

/// 実行中ジョブの [`CancelToken`] を保持する State の共通実装。
///
/// `Mutex` は libav/HTTP 等の重い処理とは無関係な単純な map 操作にのみ使うため、
/// 非同期 Mutex(`tokio::sync::Mutex`)ではなく `std::sync::Mutex` で十分(ロック区間は
/// ごく短く、await をまたがない)。
// `pub`: `commands::reframe::JobsState` 等の各ドメイン newtype が `pub` で
// `std::ops::Deref<Target = JobsState>` を実装するため、`Target` に置ける型も
// newtype 自身と同程度以上の可視性が必要(private-in-public エラー回避)。
// 実際に crate 外から使われることはない(`lib.rs` の `mod commands;` が非 `pub` の
// ため、`commands` 以下は crate 内にしか到達しない)。
#[derive(Default)]
pub struct JobsState(Mutex<HashMap<JobId, CancelToken>>);

impl JobsState {
	/// `Mutex` がポイズンされていても(他スレッドの panic 後でも)復旧してロックを取る。
	/// `unwrap`/`expect` を使わずに済ませるための薄いラッパ。
	fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<JobId, CancelToken>> {
		self.0
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
	}

	/// `job_id` が未登録なら `token` を登録して `true` を返す。既に登録済み(=同じ
	/// job_id のジョブが実行中)なら何もせず `false` を返す(GHSA-6cx9-j28r-f866 対応:
	/// 同一 job_id の並行開始を防ぐ)。「未登録か確認してから登録する」の2手順に分けると、
	/// その間に別呼び出しが割り込んで二重登録できてしまう(TOCTOU)ため、
	/// `HashMap::entry` で1回のロック区間内にアトミックに行う。唯一の登録 API
	/// (モジュール冒頭コメント参照。素の「無条件上書き」の `register` は廃止した)。
	pub(crate) fn try_register(&self, job_id: JobId, token: CancelToken) -> bool {
		match self.lock().entry(job_id) {
			std::collections::hash_map::Entry::Occupied(_) => false,
			std::collections::hash_map::Entry::Vacant(entry) => {
				entry.insert(token);
				true
			}
		}
	}

	/// `job_id` に紐づく [`CancelToken`] の clone を返す(`Arc` 共有なので安価)。
	pub(crate) fn get(&self, job_id: &str) -> Option<CancelToken> {
		self.lock().get(job_id).cloned()
	}

	/// `job_id` の [`CancelToken`] に `cancel()` を呼ぶ。未登録(既に完了済み含む)なら
	/// `Err` を返す。
	pub(crate) fn cancel(&self, job_id: &str) -> Result<(), String> {
		match self.lock().get(job_id) {
			Some(token) => {
				token.cancel();
				Ok(())
			}
			None => Err(format!(
				"未知のジョブです(既に完了した可能性があります): {job_id}"
			)),
		}
	}

	/// ジョブ完了時にエントリを削除する。
	pub(crate) fn remove(&self, job_id: &str) {
		self.lock().remove(job_id);
	}
}

/// [`JobsState`] に登録したジョブの終了時に必ず `remove` を呼ぶ RAII ガード
/// (reframe/preview・IG・YouTube で共通。以前はドメインごとに同じ形のガードを個別定義
/// していた — モジュール冒頭コメント「統一した経緯」参照)。
pub(crate) struct JobGuard<'a> {
	jobs: &'a JobsState,
	job_id: &'a str,
}

impl<'a> JobGuard<'a> {
	/// `jobs`(各ドメインの newtype でよい。`Deref<Target = JobsState>` 経由で自動的に
	/// 型変換される)に対して `job_id` の RAII ガードを作る。
	pub(crate) fn new(jobs: &'a JobsState, job_id: &'a str) -> Self {
		Self { jobs, job_id }
	}
}

impl Drop for JobGuard<'_> {
	fn drop(&mut self) {
		self.jobs.remove(self.job_id);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	// --- 登録 -> キャンセル -> トークンが cancelled になることの確認 -----------------

	#[test]
	fn try_register_then_cancel_marks_token_cancelled() {
		let jobs = JobsState::default();
		let token = CancelToken::new();
		let job_id = "job-a".to_string();
		assert!(jobs.try_register(job_id.clone(), token.clone()));

		assert!(!token.is_cancelled(), "登録直後はキャンセルされていない");

		jobs.cancel(&job_id)
			.expect("registered job must be cancellable");

		assert!(
			token.is_cancelled(),
			"cancel 後は元のトークンも cancelled になる"
		);
		let stored = jobs
			.get(&job_id)
			.expect("job should still be present until removed");
		assert!(
			stored.is_cancelled(),
			"State 経由で取得したクローンも cancelled"
		);
	}

	#[test]
	fn try_register_rejects_duplicate_job_id() {
		// GHSA-6cx9-j28r-f866: 同じ job_id が既に登録済みなら2回目の try_register は
		// 拒否される(旧 IG 実装のみが持っていた安全側の挙動を共通実装に統一した)。
		let jobs = JobsState::default();
		let token_a = CancelToken::new();
		let token_b = CancelToken::new();

		assert!(jobs.try_register("job-1".to_string(), token_a));
		assert!(!jobs.try_register("job-1".to_string(), token_b));

		// remove 後は同じ job_id を再登録できる(完了済みジョブの再試行は妨げない)。
		jobs.remove("job-1");
		assert!(jobs.try_register("job-1".to_string(), CancelToken::new()));
	}

	#[test]
	fn cancel_unknown_job_returns_error() {
		let jobs = JobsState::default();
		let result = jobs.cancel("no-such-job");
		assert!(result.is_err());
	}

	#[test]
	fn remove_makes_job_and_get_disappear() {
		let jobs = JobsState::default();
		let token = CancelToken::new();
		let job_id = "job-a".to_string();
		jobs.try_register(job_id.clone(), token);

		jobs.remove(&job_id);

		assert!(jobs.get(&job_id).is_none());
		assert!(
			jobs.cancel(&job_id).is_err(),
			"削除後は cancel も未知のジョブ扱い"
		);
	}

	#[test]
	fn multiple_jobs_are_independent() {
		let jobs = JobsState::default();
		let token_a = CancelToken::new();
		let token_b = CancelToken::new();
		let job_a = "job-a".to_string();
		let job_b = "job-b".to_string();
		jobs.try_register(job_a.clone(), token_a.clone());
		jobs.try_register(job_b.clone(), token_b.clone());

		jobs.cancel(&job_a).expect("job_a must exist");

		assert!(token_a.is_cancelled());
		assert!(
			jobs.get(&job_b).is_some_and(|token| !token.is_cancelled()),
			"job_b は job_a の cancel の影響を受けない"
		);
	}

	// --- JobGuard: drop 時に必ず remove が呼ばれること ------------------------------

	#[test]
	fn job_guard_removes_entry_on_drop() {
		let jobs = JobsState::default();
		let token = CancelToken::new();
		let job_id = "job-a".to_string();
		jobs.try_register(job_id.clone(), token);

		{
			let _guard = JobGuard::new(&jobs, &job_id);
			assert!(
				jobs.get(&job_id).is_some(),
				"guard 生存中はまだ削除されない"
			);
		}

		assert!(jobs.get(&job_id).is_none(), "guard drop 後に削除される");
	}

	#[test]
	fn job_guard_removes_entry_on_early_return_via_panic_unwind() {
		// `run_media_job`/`run_ig_publish`/`run_youtube_publish` はいずれもパニック時の
		// State リーク対策として JobGuard の RAII drop に依存している(P1-5)。
		// `catch_unwind` を挟んだパニックでも drop が実行されることを確認する。
		let jobs = JobsState::default();
		let token = CancelToken::new();
		let job_id = "job-a".to_string();
		jobs.try_register(job_id.clone(), token);

		let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
			let _guard = JobGuard::new(&jobs, &job_id);
			panic!("simulated job panic");
		}));

		assert!(result.is_err());
		assert!(
			jobs.get(&job_id).is_none(),
			"panic 経由でも guard の drop で削除される"
		);
	}
}
