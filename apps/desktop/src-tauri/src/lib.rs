// invoke 境界。Phase 1 では疎通確認用の ping のみを持っていたが、Phase 2 Wave 5 で
// reframe/probe の実コマンドを commands/ 以下に追加した(enqueue_ig, publish_youtube ...
// は後続 Phase で追加予定)。Wave 4+5 統合で preview_start も追加し、
// reframe_start と同じ JobsState(ジョブ ID 空間)を共有する
// (commands::preview モジュール冒頭コメント参照。preview_cancel という専用コマンドは
// 存在せず、reframe_cancel をそのまま使う)。
mod commands;

use commands::reframe::JobsState;

#[tauri::command]
fn ping() -> String {
	"pong".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	tauri::Builder::default()
		.manage(JobsState::default())
		.invoke_handler(tauri::generate_handler![
			ping,
			commands::probe::probe,
			commands::reframe::reframe_start,
			commands::reframe::reframe_cancel,
			commands::preview::preview_start,
		])
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
