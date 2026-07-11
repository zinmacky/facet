//! プラットフォーム別 HW エンコーダ選択。
//!
//! 参照: docs/desktop-migration-plan.md §5(技術選定)・§11-2(コーデック確定)、
//! docs/phase2-0-windows-setup.md §7(Windows 実機検証結果)。
//!
//! ## 責務の境界
//!
//! このモジュールは「どのエンコーダを・どの順で・どんな追加オプション付きで
//! 試すか」だけを決める。実際に `open_with` を呼ぶのは `encode::open_encoder`
//! (呼び出し側)の責務であり、本モジュールでは open を一切行わない。
//! HW エンコーダは `ffmpeg_next::encoder::find_by_name` が成功しても、実際に
//! open するとドライバ初期化失敗やセッション枯渇(VideoToolbox の -12903 相当)で
//! 失敗しうる(参考: `apps/studio/server/src/services/encode.ts` の
//! `isEncoderOpenError` 検知)。そのため [`candidates`] は候補を**順序付きリスト**
//! として返し、呼び出し側(pipeline.rs / 統合担当)が先頭から
//! `encode::open_encoder` を試し、`MediaError::EncoderOpen` /
//! `MediaError::EncoderNotFound` を捕捉して次候補へ進むループを組む想定である。
//! 推奨ループ形は本ファイル末尾の doc コメント(呼び出し側向けメモ)を参照。
//!
//! ## 候補テーブル
//!
//! - **Windows**: `h264_amf` → `h264_mf`。`h264_mf` は既定で `-hw_encoding=false`
//!   (capabilities=hybrid)のため、追加オプションなしで open するとソフトウェア
//!   MFT(`H264 Encoder MFT`)へ**静かにフォールバック**することが実機検証で
//!   確認済み(docs/phase2-0-windows-setup.md §7.2、3 回試行で再現)。
//!   このため `h264_mf` の候補には常に `hw_encoding=1` を付与する
//!   (付与すると `AMDh264Encoder` 等の HW MFT に切り替わることを確認済み)。
//! - **macOS**: `h264_videotoolbox` のみ。
//! - **その他 OS**: 候補なし(空リスト)。現状 Windows/macOS のみサポート(§5)。
//!
//! ## SW フォールバックをしない方針(§11-2)
//!
//! Phase 2 は libx264 等のソフトウェアエンコーダへフォールバックしない
//! (GPL 破棄。openh264 の実行時 DL は Phase 2.5 に後置)。[`select`] は
//! 候補が 1 つも利用できない場合(`find_by_name` ベースの登録確認のみ)、
//! 何を・なぜ試して失敗したかを含む [`MediaError::NoEncoderCandidate`] を返す。
//! これは「libav にエンコーダが登録されていない」ケースを検出するだけであり、
//! 「登録はされているが open が実際に失敗する」ケースの集約エラーは、
//! 呼び出し側の候補ループ(pipeline.rs)が責務を持つ。
//!
//! ## examples/reframe.rs との関係
//!
//! `examples/reframe.rs` は現状 `h264_mf` を CLI 引数で受け取った場合に限り
//! `hw_encoding=1` をハードコードで付与している(スパイクからの暫定移植)。
//! このモジュールが提供する [`candidates`] / [`select`] はその特別扱いを
//! 汎用化した置き換えであり、example 自体の書き換えは統合担当が行う。

use ffmpeg_next::Dictionary;

use crate::error::{MediaError, Result};

/// 1 つのエンコーダ候補: libav 上のエンコーダ名 + open 時に付与する追加オプション。
///
/// `options` はエンコーダ open 時に `Dictionary` へそのまま設定する想定
/// (`encode::EncoderSpec::options` に渡す)。[`EncoderChoice::to_dictionary`] で
/// 変換できる。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncoderChoice {
	/// libav のエンコーダ名(`ffmpeg_next::encoder::find_by_name` に渡す値)。
	pub name: &'static str,
	/// open 時に付与する追加オプション(key, value)。空でよい。
	pub options: &'static [(&'static str, &'static str)],
}

impl EncoderChoice {
	/// `options` を `ffmpeg_next::Dictionary` へ変換する
	/// (`encode::EncoderSpec::options` にそのまま渡せる)。
	pub fn to_dictionary(&self) -> Dictionary<'static> {
		let mut dict = Dictionary::new();
		for (key, value) in self.options {
			dict.set(key, value);
		}
		dict
	}
}

/// 対応プラットフォーム。`cfg(target_os)` を直接使うと単体テストで
/// クロスプラットフォームの分岐を検証できないため、実体を注入可能な列挙にしている。
/// 実行時は [`Platform::current`] を使い、テストでは明示的に指定してモックする。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
	Windows,
	MacOs,
	/// Windows/macOS 以外(現状候補なし。§5「対応 OS」)。
	Other,
}

impl Platform {
	/// ビルド時の `cfg(target_os)` から実プラットフォームを判定する。
	pub fn current() -> Self {
		if cfg!(target_os = "windows") {
			Platform::Windows
		} else if cfg!(target_os = "macos") {
			Platform::MacOs
		} else {
			Platform::Other
		}
	}

	/// エラーメッセージ・ログ用のラベル。
	fn label(self) -> &'static str {
		match self {
			Platform::Windows => "windows",
			Platform::MacOs => "macos",
			Platform::Other => "other",
		}
	}
}

const WINDOWS_CANDIDATES: &[EncoderChoice] = &[
	EncoderChoice {
		name: "h264_amf",
		options: &[],
	},
	// ソフト MFT への静かなフォールバックを避けるため hw_encoding=1 を必須で付与する
	// (docs/phase2-0-windows-setup.md §7.2 で実機検証済み)。
	EncoderChoice {
		name: "h264_mf",
		options: &[("hw_encoding", "1")],
	},
];

const MACOS_CANDIDATES: &[EncoderChoice] = &[EncoderChoice {
	name: "h264_videotoolbox",
	options: &[],
}];

/// `platform` 向けの候補テーブルを優先順位順で返す(フィルタなし)。
pub fn candidate_table(platform: Platform) -> &'static [EncoderChoice] {
	match platform {
		Platform::Windows => WINDOWS_CANDIDATES,
		Platform::MacOs => MACOS_CANDIDATES,
		Platform::Other => &[],
	}
}

/// 現在のプラットフォーム向けの候補テーブルを優先順位順で返す
/// ([`Platform::current`] を使う)。
///
/// **フィルタなし**: `find_by_name` による存在確認は行わない。呼び出し側が
/// この順で `encode::open_encoder` を試し、open 失敗(`MediaError::EncoderOpen` /
/// `MediaError::EncoderNotFound`)を捕捉して次候補へ進むループを組む想定
/// (このモジュールは open を行わない。モジュール冒頭コメント参照)。
pub fn candidates() -> Vec<EncoderChoice> {
	candidate_table(Platform::current()).to_vec()
}

/// `is_available` で候補ごとの利用可否を判定し、使える候補だけを優先順位順で返す。
///
/// テスト用に availability チェックを注入できる形にしてある(実 FFmpeg に依存せず
/// 「amf なし → mf が選ばれ hw_encoding=1 が付く」等を検証できる)。実行時は
/// [`select`] が `ffmpeg_next::encoder::find_by_name` を使ってこの関数を呼ぶ。
///
/// 候補が 1 つも使えない場合(非対応プラットフォームで候補 0 件のケースを含む)は
/// [`MediaError::NoEncoderCandidate`] を返す。この判定は「libav にエンコーダが
/// 登録されているか」のみであり、実際の HW 初期化成否(open 失敗)はこの関数では
/// 検出できない点に注意(モジュール冒頭コメント参照)。
pub fn select_with(
	platform: Platform,
	is_available: impl Fn(&str) -> bool,
) -> Result<Vec<EncoderChoice>> {
	let table = candidate_table(platform);
	let available: Vec<EncoderChoice> = table
		.iter()
		.copied()
		.filter(|choice| is_available(choice.name))
		.collect();

	if available.is_empty() {
		return Err(MediaError::NoEncoderCandidate {
			platform: platform.label().to_string(),
			attempted: table.iter().map(|choice| choice.name.to_string()).collect(),
		});
	}
	Ok(available)
}

/// 現在のプラットフォームで、`ffmpeg_next::encoder::find_by_name` に登録されている
/// 候補だけを優先順位順で返す。
///
/// 返った `Vec` は先頭から順に `encode::open_encoder` を試す想定(open 失敗時は
/// 次候補へ進める呼び出し側ループを想定。§11-2 によりソフトウェアフォールバックは
/// しない)。
///
/// # 呼び出し側の推奨ループ形(pipeline.rs / 統合担当向け)
///
/// ```ignore
/// let mut last_err = None;
/// for choice in media_core::encoder_select::select()? {
///     match encode::open_encoder(&mut octx, EncoderSpec {
///         name: choice.name,
///         options: choice.to_dictionary(),
///         // ... width/height/time_base/frame_rate/bit_rate/global_header
///     }) {
///         Ok(opened) => break Ok(opened), // 成功した候補を採用
///         Err(err @ MediaError::EncoderOpen { .. }) => last_err = Some(err), // 次候補へ
///         Err(err) => return Err(err), // open 以外の失敗は即エラー
///     }
/// }
/// ```
pub fn select() -> Result<Vec<EncoderChoice>> {
	select_with(Platform::current(), |name| {
		ffmpeg_next::encoder::find_by_name(name).is_some()
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn windows_prefers_amf_then_mf_with_hw_encoding() {
		let chosen = select_with(Platform::Windows, |_name| true).expect("should succeed");
		assert_eq!(chosen.len(), 2);
		assert_eq!(chosen[0].name, "h264_amf");
		assert!(chosen[0].options.is_empty());
		assert_eq!(chosen[1].name, "h264_mf");
		assert_eq!(chosen[1].options, &[("hw_encoding", "1")]);
	}

	#[test]
	fn windows_falls_back_to_mf_when_amf_unavailable() {
		// find_by_name が h264_amf にだけ失敗する状況(AMF 非搭載環境)をモックする。
		let chosen =
			select_with(Platform::Windows, |name| name != "h264_amf").expect("mf は利用可能");
		assert_eq!(chosen.len(), 1);
		assert_eq!(chosen[0].name, "h264_mf");
		assert_eq!(chosen[0].options, &[("hw_encoding", "1")]);
	}

	#[test]
	fn windows_all_unavailable_returns_clear_error() {
		let err = select_with(Platform::Windows, |_name| false).expect_err("全滅のはず");
		match err {
			MediaError::NoEncoderCandidate {
				platform,
				attempted,
			} => {
				assert_eq!(platform, "windows");
				assert_eq!(
					attempted,
					vec!["h264_amf".to_string(), "h264_mf".to_string()]
				);
			}
			other => panic!("unexpected error variant: {other:?}"),
		}
	}

	#[test]
	fn macos_selects_videotoolbox_only() {
		let chosen = select_with(Platform::MacOs, |_name| true).expect("should succeed");
		assert_eq!(chosen.len(), 1);
		assert_eq!(chosen[0].name, "h264_videotoolbox");
		assert!(chosen[0].options.is_empty());
	}

	#[test]
	fn macos_all_unavailable_returns_clear_error() {
		let err = select_with(Platform::MacOs, |_name| false).expect_err("全滅のはず");
		match err {
			MediaError::NoEncoderCandidate {
				platform,
				attempted,
			} => {
				assert_eq!(platform, "macos");
				assert_eq!(attempted, vec!["h264_videotoolbox".to_string()]);
			}
			other => panic!("unexpected error variant: {other:?}"),
		}
	}

	#[test]
	fn other_platform_has_no_candidates_and_errors_with_empty_attempted() {
		let err = select_with(Platform::Other, |_name| true).expect_err("候補 0 件のはず");
		match err {
			MediaError::NoEncoderCandidate {
				platform,
				attempted,
			} => {
				assert_eq!(platform, "other");
				assert!(attempted.is_empty());
			}
			other => panic!("unexpected error variant: {other:?}"),
		}
	}

	#[test]
	fn to_dictionary_sets_hw_encoding_for_mf_candidate() {
		let mf = candidate_table(Platform::Windows)
			.iter()
			.find(|choice| choice.name == "h264_mf")
			.copied()
			.expect("h264_mf candidate must exist");
		let dict = mf.to_dictionary();
		assert_eq!(dict.get("hw_encoding"), Some("1"));
	}

	#[test]
	fn candidates_matches_current_platform_shape() {
		// cfg(target_os) 依存部分自体は実行環境依存のため、値の中身ではなく
		// 「Windows/macOS なら非空、それ以外なら空」という形だけを検証する。
		let current = candidates();
		match Platform::current() {
			Platform::Windows | Platform::MacOs => assert!(!current.is_empty()),
			Platform::Other => assert!(current.is_empty()),
		}
	}

	/// 実 FFmpeg の `find_by_name` 登録状況に依存する統合寄りのテスト。
	/// CI 環境(HW なし)では対象コーデックが未登録の可能性があるため `#[ignore]` にし、
	/// 実機検証時に手動実行する(`cargo test -p media-core -- --ignored`)。
	#[test]
	#[ignore = "実 FFmpeg ビルドのエンコーダ登録状況(HW 搭載環境)に依存するため手動実行"]
	fn select_against_real_ffmpeg() {
		ffmpeg_next::init().expect("ffmpeg init should succeed");
		let result = select();
		match result {
			Ok(chosen) => assert!(!chosen.is_empty()),
			Err(MediaError::NoEncoderCandidate { .. }) => {
				// 対象コーデック非搭載環境ではこちらも許容する。
			}
			Err(other) => panic!("unexpected error variant: {other:?}"),
		}
	}
}
