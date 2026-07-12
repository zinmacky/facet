//! 検査項目の判定ロジック本体。
//!
//! ここでは `avutil_license()` / `avcodec_configuration()` の**文字列**と
//! `encoder::find_by_name()` の**真偽値**のみを入力に取る純粋関数として実装する。
//!
//! 理由: `cargo test --workspace` は CI(開発用 GPL FFmpeg、ci.yml 参照)でも走る。
//! 実際にリンクされている FFmpeg の状態に依存するテストを書くと、GPL 環境では
//! 意図的に「不合格」判定になってしまう(それ自体はゲートとして正しい挙動だが、
//! 単体テストとして書くと開発環境で常に失敗する壊れたテストになる)。そのため
//! ロジックは合成した文字列/真偽値を入力に取る形にして、実際の FFmpeg 呼び出し
//! (main.rs 側)とは分離する。

/// GPL 専用のエンコーダ。LGPL 構成の FFmpeg には登録されていないはず。
pub const FORBIDDEN_ENCODERS: &[&str] = &["libx264", "libx264rgb", "libx265", "libxvid"];

/// LGPL 構成でも収録されているはずの Windows ネイティブ HW エンコーダ。
/// 未登録の場合はステージングした FFmpeg 自体が壊れている(DLL 欠落等)可能性が高い。
pub const REQUIRED_HW_ENCODERS: &[&str] = &["h264_amf", "h264_mf"];

/// `avcodec_configuration()` に含まれていてはならないビルドフラグ。
/// 1つでも含まれていれば GPL/nonfree コンポーネントが有効化されたビルド。
const FORBIDDEN_CONFIGURE_FLAGS: &[&str] = &[
	"--enable-gpl",
	"--enable-nonfree",
	"--enable-libx264",
	"--enable-libx265",
	"--enable-libxvid",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckOutcome {
	Pass,
	Fail,
}

#[derive(Debug, Clone)]
pub struct CheckResult {
	pub label: String,
	pub outcome: CheckOutcome,
	pub detail: String,
}

/// (1) `avutil_license()` が "LGPL" で始まるか。
///
/// BtbN の lgpl 構成は `--enable-version3` でビルドされるため、正常系では
/// "LGPL version 3 or later" になるはず(先頭一致のみ厳密判定し、バージョン
/// 表記の細部までは固定しない)。
pub fn check_license(license: &str) -> CheckResult {
	let outcome = if license.starts_with("LGPL") {
		CheckOutcome::Pass
	} else {
		CheckOutcome::Fail
	};
	CheckResult {
		label: "avutil ライセンス文字列".to_string(),
		outcome,
		detail: format!(
			"avutil_license() = \"{license}\"(期待: \"LGPL\" で始まる。BtbN の lgpl 構成は \
			 --enable-version3 のため \"LGPL version 3 or later\" になるはず)"
		),
	}
}

/// (2) `avcodec_configuration()` に GPL/nonfree 系の有効化フラグが含まれていないか。
pub fn check_configuration(configuration: &str) -> CheckResult {
	let found: Vec<&str> = FORBIDDEN_CONFIGURE_FLAGS
		.iter()
		.copied()
		.filter(|flag| configuration.contains(flag))
		.collect();
	let outcome = if found.is_empty() {
		CheckOutcome::Pass
	} else {
		CheckOutcome::Fail
	};
	let detail = if found.is_empty() {
		format!(
			"avcodec_configuration() に GPL/nonfree 系フラグなし(configuration = \"{configuration}\")"
		)
	} else {
		format!(
			"avcodec_configuration() に禁止フラグを検出: {}(configuration = \"{configuration}\")",
			found.join(", ")
		)
	};
	CheckResult {
		label: "avcodec ビルド設定".to_string(),
		outcome,
		detail,
	}
}

/// (3) GPL 専用エンコーダ(`FORBIDDEN_ENCODERS`)が未登録であること。
pub fn check_encoder_absent(name: &str, found: bool) -> CheckResult {
	let outcome = if found {
		CheckOutcome::Fail
	} else {
		CheckOutcome::Pass
	};
	CheckResult {
		label: format!("エンコーダ未登録確認: {name}"),
		outcome,
		detail: if found {
			format!("{name} が登録されています(GPL 構成の疑いあり)")
		} else {
			format!("{name} は未登録(想定どおり)")
		},
	}
}

/// (4) HW エンコーダ(`REQUIRED_HW_ENCODERS`)が登録されていること。
pub fn check_encoder_present(name: &str, found: bool) -> CheckResult {
	let outcome = if found {
		CheckOutcome::Pass
	} else {
		CheckOutcome::Fail
	};
	CheckResult {
		label: format!("HW エンコーダ登録確認: {name}"),
		outcome,
		detail: if found {
			format!("{name} は登録済み")
		} else {
			format!("{name} が未登録です(FFmpeg のステージングが壊れている可能性)")
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn license_lgpl_v3_passes() {
		let r = check_license("LGPL version 3 or later");
		assert_eq!(r.outcome, CheckOutcome::Pass);
	}

	#[test]
	fn license_lgpl_v2_1_passes() {
		// 先頭一致のみ判定するため、v2.1 表記でも "LGPL" で始まれば合格扱い。
		let r = check_license("LGPL version 2.1 or later");
		assert_eq!(r.outcome, CheckOutcome::Pass);
	}

	#[test]
	fn license_gpl_fails() {
		let r = check_license("GPL version 2 or later");
		assert_eq!(r.outcome, CheckOutcome::Fail);
	}

	#[test]
	fn license_empty_fails() {
		let r = check_license("");
		assert_eq!(r.outcome, CheckOutcome::Fail);
	}

	#[test]
	fn configuration_clean_passes() {
		let r = check_configuration(
			"--enable-shared --enable-version3 --enable-amf --enable-mediafoundation",
		);
		assert_eq!(r.outcome, CheckOutcome::Pass);
	}

	#[test]
	fn configuration_with_gpl_flag_fails() {
		let r = check_configuration("--enable-shared --enable-gpl --enable-libx264");
		assert_eq!(r.outcome, CheckOutcome::Fail);
	}

	#[test]
	fn configuration_with_nonfree_flag_fails() {
		let r = check_configuration("--enable-shared --enable-nonfree");
		assert_eq!(r.outcome, CheckOutcome::Fail);
	}

	#[test]
	fn configuration_with_libx265_flag_fails() {
		let r = check_configuration("--enable-shared --enable-gpl --enable-libx265");
		assert_eq!(r.outcome, CheckOutcome::Fail);
	}

	#[test]
	fn encoder_absent_when_not_found_passes() {
		let r = check_encoder_absent("libx264", false);
		assert_eq!(r.outcome, CheckOutcome::Pass);
	}

	#[test]
	fn encoder_absent_when_found_fails() {
		let r = check_encoder_absent("libx264", true);
		assert_eq!(r.outcome, CheckOutcome::Fail);
	}

	#[test]
	fn encoder_present_when_found_passes() {
		let r = check_encoder_present("h264_amf", true);
		assert_eq!(r.outcome, CheckOutcome::Pass);
	}

	#[test]
	fn encoder_present_when_missing_fails() {
		let r = check_encoder_present("h264_amf", false);
		assert_eq!(r.outcome, CheckOutcome::Fail);
	}
}
