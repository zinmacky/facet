// invoke 境界の最小実装。Phase 1 では renderer からの疎通確認用の ping のみを持つ。
// 実際のコマンド(reframe, probe, enqueue_ig, publish_youtube ...)は
// commands/ 以下にモジュールを分けて Phase 2 以降で追加する。
#[tauri::command]
fn ping() -> String {
	"pong".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	tauri::Builder::default()
		.invoke_handler(tauri::generate_handler![ping])
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
