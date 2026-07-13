// invoke 境界。Phase 1 では疎通確認用の ping のみを持っていたが、Phase 2 Wave 5 で
// reframe/probe の実コマンドを commands/ 以下に追加した(enqueue_ig, publish_youtube ...
// は後続 Phase で追加予定)。Wave 4+5 統合で preview_start も追加し、
// reframe_start と同じ JobsState(ジョブ ID 空間)を共有する
// (commands::preview モジュール冒頭コメント参照。preview_cancel という専用コマンドは
// 存在せず、reframe_cancel をそのまま使う)。
//
// renderer 配線(Phase 2 最終接続): `tauri-plugin-dialog` を追加する。renderer が
// 元動画の選択・書き出し先フォルダの選択に使うネイティブダイアログで、
// invoke コマンドではなくプラグイン権限(capabilities/default.json の
// `dialog:default`)経由で renderer から直接呼ぶ(`@tauri-apps/plugin-dialog`)。
//
// bulk-download バグ修正: `tauri-plugin-opener` を追加する。studio 版は書き出し結果を
// HTTP 経由の ZIP ダウンロードで渡すが、desktop には studio-server が存在しないため
// 同じ経路は使えない(既知ギャップ)。代わりに実ファイルを直接書き出し、
// 保存先フォルダを OS 既定のファイルマネージャで開く形にする
// (`opener:default` 経由で renderer から直接呼ぶ。`@tauri-apps/plugin-opener`)。
//
// 書き出し完了通知: `tauri-plugin-notification` を追加する。書き出し(reframe)が
// 完了した際にデスクトップ通知でユーザーに知らせるためで、invoke コマンドではなく
// dialog/opener と同様プラグイン権限(capabilities/default.json の
// `notification:default`)経由で renderer から直接呼ぶ
// (`@tauri-apps/plugin-notification` で権限確認と通知発火を行う)。
//
// Phase 4 Wave C(自動更新): `tauri-plugin-updater` / `tauri-plugin-process` を追加する。
// 起動時チェック→アプリ内通知→ダウンロード→再起動は invoke コマンドを介さず、
// renderer が `@tauri-apps/plugin-updater`(`check`/`Update.download`/`Update.install`)・
// `@tauri-apps/plugin-process`(`relaunch`)をプラグイン権限経由で直接呼ぶ
// (capabilities/default.json の `updater:default`/`process:allow-restart`)。
// 更新の配布元・公開鍵・Windows のインストールモードは tauri.conf.json の
// `plugins.updater` で設定する(pubkey はユーザーの鍵生成待ちのプレースホルダ — 同ファイルの
// コメント参照)。
//
// エディション分離(v2.4, docs/desktop-migration-plan.md §6.6): `publish` cargo feature
// (Cargo.toml [features])が既定で無効なため、`commands::publish`(資格情報設定 + OS
// キーチェーン + scheduler 疎通チェック。§11-3)は public(配布版)ビルドのバイナリに
// 一切含まれない。private ビルド(build:mac-private 等)のみ `--features publish` で
// 有効化する。`tauri::generate_handler!` は各エントリに `#[cfg(...)]` を個別に
// 付けられる(tauri-macros の Handler パーサがそのまま素通しする)ため、下記
// invoke_handler 内で `#[cfg(feature = "publish")]` を付けて出し分ける
// (ハンドラ一覧を feature 有無で二重管理せずに済む)。
//
// Phase 3 本体(IG 連携、§6.4): `jobs` モジュール(R2 アップロード + POST /jobs の
// ビジネスロジック層。Tauri 非依存)を追加する。`commands::publish::ig` が invoke 境界
// (`ig_publish_start`/`ig_publish_cancel`)としてこれを呼ぶ。`jobs` 自体も `publish`
// feature 限定(§jobs/mod.rs)。
mod commands;
#[cfg(feature = "publish")]
mod jobs;

use commands::reframe::JobsState;

#[tauri::command]
fn ping() -> String {
	"pong".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	let builder = tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_opener::init())
		.plugin(tauri_plugin_notification::init())
		.plugin(tauri_plugin_updater::Builder::new().build())
		.plugin(tauri_plugin_process::init())
		.manage(JobsState::default());

	// IG 公開ジョブ(R2 アップロード + POST /jobs)の CancelToken を保持する State
	// (`commands::reframe::JobsState` とは別のジョブ ID 空間、§commands/publish/ig.rs
	// 冒頭コメント参照)。`publish` feature 無効(public ビルド)では型自体が存在しないため
	// `manage` ごと除外する。
	#[cfg(feature = "publish")]
	let builder = builder.manage(commands::publish::IgJobsState::default());

	builder
		.invoke_handler(tauri::generate_handler![
			ping,
			commands::probe::probe,
			commands::reframe::reframe_start,
			commands::reframe::reframe_cancel,
			commands::reframe::set_max_concurrent_encodes,
			commands::preview::preview_start,
			// 資格情報設定 + OS キーチェーン + scheduler 疎通チェック(§11-3)。
			// `publish` feature 無効(public ビルド)ではこれらのコマンド自体が
			// 存在しないため、ここで削除されコンパイルされない。
			#[cfg(feature = "publish")]
			commands::publish::set_scheduler_api_token,
			#[cfg(feature = "publish")]
			commands::publish::has_scheduler_api_token,
			#[cfg(feature = "publish")]
			commands::publish::delete_scheduler_api_token,
			#[cfg(feature = "publish")]
			commands::publish::check_scheduler_connection,
			// R2(S3 互換)資格情報設定(§6.4)。
			#[cfg(feature = "publish")]
			commands::publish::set_r2_credentials,
			#[cfg(feature = "publish")]
			commands::publish::has_r2_credentials,
			#[cfg(feature = "publish")]
			commands::publish::delete_r2_credentials,
			// IG(Instagram)本体: R2 アップロード + POST /jobs(§6.4・§8 Phase 3)。
			// YouTube 本体のコマンドは今回のスコープ外(Phase 3 の別作業)。
			#[cfg(feature = "publish")]
			commands::publish::ig_publish_start,
			#[cfg(feature = "publish")]
			commands::publish::ig_publish_cancel,
		])
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
