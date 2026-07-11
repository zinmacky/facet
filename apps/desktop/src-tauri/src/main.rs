// Windows のリリースビルドでコンソールウィンドウを出さないための属性(tauri 標準)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
	facet_desktop_lib::run();
}
