//! 入力オープン・映像ストリーム選択・デコーダ構築。
//!
//! スパイク(`spikes/libav-reframe/src/reframe.rs`)の `ictx` / デコーダ構築部分を、
//! `unwrap` を排して `Result<_, MediaError>` に伝搬する形へ移植したもの。

use std::path::Path;

use ffmpeg_next::{self as ffmpeg, codec, decoder, format, media, Rational};

use crate::error::{MediaError, Result};

/// 入力オープン〜デコーダ構築までの結果一式。
///
/// `input` は demuxer コンテキストそのもの(`ictx.packets()` でパケットを読み進める
/// のに使う)、`decoder` は選択した映像ストリームのデコーダ。
pub struct DecodeContext {
	pub input: format::context::Input,
	/// デコード対象の映像ストリームの index(`packets()` でのフィルタに使う)。
	pub stream_index: usize,
	/// 映像ストリームのタイムベース(パケット/フレームの pts はこの単位)。
	pub time_base: Rational,
	pub decoder: decoder::Video,
	/// コンテナが申告する総フレーム数の見積り。0(未申告)の場合は `None`
	/// (progress.rs / `pipeline::Progress` の percent 算出に使う、Wave 1 時点では
	/// 最小のフレーム数ベース見積りのみ)。
	pub total_frames: Option<u64>,
}

/// 入力ファイルを開き、最良の映像ストリームを選んでデコーダを構築する。
pub fn open_input(path: &Path) -> Result<DecodeContext> {
	let input = format::input(path).map_err(|source| MediaError::InputOpen {
		path: path.to_path_buf(),
		source,
	})?;

	let (stream_index, time_base, parameters, total_frames) =
		{
			let stream = input.streams().best(media::Type::Video).ok_or_else(|| {
				MediaError::NoVideoStream {
					path: path.to_path_buf(),
				}
			})?;
			let frames = stream.frames();
			let total_frames = if frames > 0 {
				Some(frames as u64)
			} else {
				None
			};
			(
				stream.index(),
				stream.time_base(),
				stream.parameters(),
				total_frames,
			)
		};

	let decoder = codec::context::Context::from_parameters(parameters)
		.map_err(|source| MediaError::DecoderOpen { source })?
		.decoder()
		.video()
		.map_err(|source| MediaError::DecoderOpen { source })?;

	Ok(DecodeContext {
		input,
		stream_index,
		time_base,
		decoder,
		total_frames,
	})
}

/// デコーダの表示アスペクト比(SAR)。未設定(0/0)なら 1:1 を返す
/// (フィルタグラフの `buffer` ソースへ渡す `pixel_aspect` の既定値、スパイク同様)。
pub fn sample_aspect_ratio(decoder: &decoder::Video) -> Rational {
	let sar = decoder.aspect_ratio();
	if sar.numerator() == 0 {
		Rational(1, 1)
	} else {
		sar
	}
}

/// デコーダのフレームフォーマット名を安全に得る(フィルタグラフの `buffer` ソース
/// 引数 `pix_fmt=` に使う)。
pub fn pix_fmt_name(format: format::Pixel) -> String {
	crate::encode::pix_fmt_name(format)
}

/// libav の全コーデック/フォーマット登録を行う。プロセス内で一度だけ呼べば十分。
/// `lib.rs` の公開 API(`reframe`)から呼ばれる想定。
pub fn init() -> Result<()> {
	ffmpeg::init().map_err(|source| MediaError::Init { source })
}
