//! エンコーダ構築。
//!
//! エンコーダ名(例: "h264_amf" / "h264_mf" / "h264_videotoolbox")と追加オプション
//! (`Dictionary`。例: h264_mf の `hw_encoding=1`)は呼び出し側が**引数で注入**する。
//! 「どのエンコーダを選ぶか」というプラットフォーム別選択ロジック自体は Wave 2 の
//! `encoder_select` モジュールに委ねる想定で、本モジュールは「開き方」だけを知っている。
//!
//! `pick_pixel_format` / `is_hwaccel_format` はスパイク(`spikes/libav-reframe/src/reframe.rs`)
//! からの移植。libavutil の `AVPixFmtDescriptor` を読む unsafe FFI 呼び出しを含むため、
//! それぞれ safety コメントを付けている。

use std::ffi::CStr;

use ffmpeg_next::ffi::{
	av_get_pix_fmt_name, av_pix_fmt_desc_get, AVPixelFormat, AV_PIX_FMT_FLAG_HWACCEL,
};
use ffmpeg_next::{codec, encoder, format, Codec, Dictionary, Rational};

use crate::error::{MediaError, Result};

/// 既定ビットレート(8Mbps)。旧 CLI runner(`packages/ffmpeg-runner`、削除済み)の既定と同一で、
/// Instagram の映像 VBR 上限(25Mbps, docs/desktop-migration-plan.md §12.3)に十分収まる。
pub const DEFAULT_BITRATE: usize = 8_000_000;

/// libavutil の pix_fmt 名を安全な `String` として得る
/// (フィルタグラフの `buffer`/`format=` 引数や診断ログに使う)。
pub fn pix_fmt_name(pixel: format::Pixel) -> String {
	// Safety: `av_get_pix_fmt_name` はライブラリ内蔵の静的テーブルを参照するだけの
	// 読み取り専用 API で、返るポインタは NUL 終端の静的文字列 or NULL(未知の値の場合)。
	// 所有権の移動や解放は発生しないため、ここで CStr として読み取るだけで安全。
	unsafe {
		let raw: AVPixelFormat = pixel.into();
		let ptr = av_get_pix_fmt_name(raw);
		if ptr.is_null() {
			return "unknown".to_string();
		}
		CStr::from_ptr(ptr).to_string_lossy().into_owned()
	}
}

/// 指定フォーマットがハードウェアサーフェス形式(`AV_PIX_FMT_FLAG_HWACCEL`)かを判定する。
/// media-core はソフトウェアフレームをエンコーダへ直接 `send_frame` する
/// (`hw_frames_ctx` を組まない)ため、hwaccel 形式(例: VideoToolbox のサーフェス型)は
/// エンコード用ピクセルフォーマットの候補から除外する必要がある。
fn is_hwaccel_format(pixel: format::Pixel) -> bool {
	// Safety: `av_pix_fmt_desc_get` は未知の pix_fmt に対して NULL を返しうるため、
	// デリファレンス前に null チェックする。返る `*const AVPixFmtDescriptor` は
	// libavutil が保持する静的テーブルへの参照で、呼び出し側での解放は不要・不可。
	unsafe {
		let raw: AVPixelFormat = pixel.into();
		let desc = av_pix_fmt_desc_get(raw);
		if desc.is_null() {
			return false;
		}
		(*desc).flags & (AV_PIX_FMT_FLAG_HWACCEL as u64) != 0
	}
}

/// エンコーダが対応するソフトウェアピクセルフォーマットの先頭を採用する。
///
/// `codec.video().formats()` は対応形式を宣言していないエンコーダに対して `None` を
/// 返しうる(その場合や候補が hwaccel 形式しかない場合は `yuv420p` にフォールバック)。
/// 例: `h264_videotoolbox` は `[VIDEOTOOLBOX(hw), NV12, YUV420P]` の順で報告するため
/// hwaccel を除外した先頭の `NV12` を採用する。`h264_mf` のような NV12 専用エンコーダも
/// 同じロジックで扱える。
pub fn pick_pixel_format(codec: Codec) -> format::Pixel {
	codec
		.video()
		.ok()
		.and_then(|v| v.formats())
		.and_then(|mut formats| formats.find(|&f| !is_hwaccel_format(f)))
		.unwrap_or(format::Pixel::YUV420P)
}

/// エンコーダ構築に必要なパラメータ。エンコーダ名・追加オプションは呼び出し側が
/// 注入する(Wave 2 の `encoder_select` が選択ロジックを担当する前提)。
pub struct EncoderSpec<'a> {
	pub name: &'a str,
	/// 例: h264_mf の `hw_encoding=1`(空でよい)。
	pub options: Dictionary<'a>,
	pub width: u32,
	pub height: u32,
	/// 出力ストリームのタイムベース。通常は入力映像ストリームのタイムベースを流用する。
	pub time_base: Rational,
	pub frame_rate: Option<Rational>,
	pub bit_rate: usize,
	/// 出力コンテナが `GLOBAL_HEADER` を要求するか(mp4 等)。
	pub global_header: bool,
}

/// エンコーダを構築して open し、成功した場合のみ出力コンテキストへストリームとして
/// 追加する。
///
/// **ストリーム追加は open 成功後に行う**(Wave 2 で `encoder_select::Auto` の候補
/// リトライループから呼ばれるようになったための設計判断)。`octx.add_stream()` は
/// `avformat_new_stream` を直接呼ぶため、一度追加したストリームを取り消す API は
/// ffmpeg-next に存在しない。open 前に追加してしまうと、候補が open に失敗した際に
/// 中身のない不正なストリームが出力コンテキストに残り続け、次の候補で追加した
/// 正しいストリームと合わせて 2 本のストリームを持つ壊れた mp4 になってしまう
/// (`ost.set_parameters()` はエンコーダの open 後にしか正しい値を持たないため、
/// 元々「ストリーム追加」と「エンコーダ open」は不可分に行っていたが、順序を
/// 「open → 追加」に入れ替えることで、この 2 つの不可分性を保ったまま安全にリトライできる)。
///
/// 戻り値の `format::Pixel` は、エンコーダが実際に受け付けるピクセルフォーマット
/// (`pick_pixel_format` の結果)。フィルタグラフ末尾の `format=` と必ず一致させる
/// 必要があるため(不一致だとエンコーダ open やフレーム投入で失敗する)、
/// 呼び出し側(pipeline.rs)はこの値を `fit::build_filter_graph` へそのまま渡す。
/// `usize` は追加した出力ストリームの index。
pub fn open_encoder(
	octx: &mut format::context::Output,
	spec: EncoderSpec<'_>,
) -> Result<(encoder::Video, format::Pixel, usize)> {
	let codec = encoder::find_by_name(spec.name).ok_or_else(|| MediaError::EncoderNotFound {
		name: spec.name.to_string(),
	})?;

	let pixel_format = pick_pixel_format(codec);

	let mut encoder_ctx = codec::context::Context::new_with_codec(codec)
		.encoder()
		.video()
		.map_err(|source| MediaError::EncoderOpen {
			name: spec.name.to_string(),
			source,
		})?;

	encoder_ctx.set_width(spec.width);
	encoder_ctx.set_height(spec.height);
	encoder_ctx.set_format(pixel_format);
	encoder_ctx.set_time_base(spec.time_base);
	encoder_ctx.set_frame_rate(spec.frame_rate);
	encoder_ctx.set_aspect_ratio(Rational(1, 1));
	encoder_ctx.set_bit_rate(spec.bit_rate);
	if spec.global_header {
		encoder_ctx.set_flags(codec::Flags::GLOBAL_HEADER);
	}

	let opened = encoder_ctx
		.open_with(spec.options)
		.map_err(|source| MediaError::EncoderOpen {
			name: spec.name.to_string(),
			source,
		})?;

	// ここまで到達したら open は成功している。ここで初めてストリームを追加する。
	let mut ost = octx
		.add_stream(codec)
		.map_err(|source| MediaError::OutputStreamCreate {
			name: spec.name.to_string(),
			source,
		})?;
	let stream_index = ost.index();
	ost.set_parameters(&opened);

	Ok((opened, pixel_format, stream_index))
}
