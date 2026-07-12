//! ロード済みモジュール(DLL)一覧から、名前が指定プレフィックスで始まるものを
//! 探してフルパスを返す(Windows 専用)。
//!
//! 当初は検査に使った関数シンボル(`avutil_license` 等)のアドレスを
//! `GetModuleHandleExW`(`GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS`)で逆引きする案を
//! 検討したが、Windows の DLL 動的インポート(dllimport)はリンカが生成する間接
//! 呼び出しスタブを経由するため、関数アドレスを取得すると実際には exe 自身の中の
//! スタブアドレスが返ってしまい、DLL 側の逆引きができないことが実機検証で判明した
//! (`license-gate.exe` 自身のパスが返ってしまう)。
//!
//! 代わりにプロセスにロード済みの全モジュールを列挙し(`EnumProcessModules`)、
//! ファイル名のプレフィックス一致で目的の DLL を特定する。DLL 名のバージョン付番
//! (`avutil-60.dll` 等)は FFmpeg のバージョンで変わりうるためハードコードしない。

use windows_sys::Win32::Foundation::HMODULE;
use windows_sys::Win32::System::ProcessStatus::{EnumProcessModules, GetModuleFileNameExW};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

/// 現在のプロセスにロード済みのモジュールのうち、ファイル名(拡張子を除く)が
/// `prefix` で(大文字小文字を区別せず)始まる最初のもののフルパスを返す。
/// 見つからない、または列挙に失敗した場合は理由を含む文字列を返す(呼び出し元は
/// ログ出力用途のみに使うため、Result にはしない)。
pub fn find_loaded_module_path(prefix: &str) -> String {
	unsafe {
		let process = GetCurrentProcess();

		// ロード済みモジュール数はプロセスの規模によって変わるため、まず十分な
		// 余裕を持ったバッファで EnumProcessModules を呼び、実際に書き込まれた
		// 件数(needed)だけを見る。1024 件を超えることは想定していないが、
		// 超えた場合は先頭 1024 件のみ走査する(検査対象の DLL は通常プロセス
		// 起動直後にロードされるため十分実用的)。
		let mut needed: u32 = 0;
		let mut modules: Vec<HMODULE> = vec![std::ptr::null_mut(); 1024];
		let cb = (modules.len() * std::mem::size_of::<HMODULE>()) as u32;
		let ok = EnumProcessModules(process, modules.as_mut_ptr(), cb, &mut needed);
		if ok == 0 {
			return "(モジュール列挙失敗: EnumProcessModules)".to_string();
		}
		let count = (needed as usize / std::mem::size_of::<HMODULE>()).min(modules.len());

		for &module in &modules[..count] {
			let mut buf = [0u16; 1024];
			let len = GetModuleFileNameExW(process, module, buf.as_mut_ptr(), buf.len() as u32);
			if len == 0 {
				continue;
			}
			let path = String::from_utf16_lossy(&buf[..len as usize]);
			let file_name = path.rsplit(['\\', '/']).next().unwrap_or(&path);
			let base_name = file_name.strip_suffix(".dll").unwrap_or(file_name);
			if base_name
				.to_ascii_lowercase()
				.starts_with(&prefix.to_ascii_lowercase())
			{
				return path;
			}
		}

		format!("(見つかりません: プレフィックス \"{prefix}\" に一致するロード済みモジュールなし)")
	}
}
