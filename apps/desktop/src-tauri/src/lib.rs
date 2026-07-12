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
// Phase 4 Wave C(自動更新): `tauri-plugin-updater` / `tauri-plugin-process` を追加する。
// 起動時チェック→アプリ内通知→ダウンロード→再起動は invoke コマンドを介さず、
// renderer が `@tauri-apps/plugin-updater`(`check`/`Update.download`/`Update.install`)・
// `@tauri-apps/plugin-process`(`relaunch`)をプラグイン権限経由で直接呼ぶ
// (capabilities/default.json の `updater:default`/`process:allow-restart`)。
// 更新の配布元・公開鍵・Windows のインストールモードは tauri.conf.json の
// `plugins.updater` で設定する(pubkey はユーザーの鍵生成待ちのプレースホルダ — 同ファイルの
// コメント参照)。
mod commands;

use commands::reframe::JobsState;

#[tauri::command]
fn ping() -> String {
	"pong".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_opener::init())
		.plugin(tauri_plugin_updater::Builder::new().build())
		.plugin(tauri_plugin_process::init())
		.manage(JobsState::default())
		.invoke_handler(tauri::generate_handler![
			ping,
			commands::probe::probe,
			commands::reframe::reframe_start,
			commands::reframe::reframe_cancel,
			commands::reframe::set_max_concurrent_encodes,
			commands::preview::preview_start,
		])
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
