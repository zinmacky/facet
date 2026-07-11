// Phase 2-0(先行ゲート・Windows 検証)用の最小 reframe スパイク。
// decode → filtergraph(blur-pad / crop-cover)→ HW エンコーダ → mp4(+faststart)。
// blur-pad は現 studio(packages/core/src/filtergraph/blur-pad.ts)と同一のフィルタ
// 記述文字列を使い、出力の同等性検証(SSIM)の基準を揃える。音声はスパイクでは扱わない。
//
// mac スパイク(h264_videotoolbox 固定)からの変更点:
// - エンコーダ名を CLI 引数化(既定 h264_videotoolbox)。Windows では h264_mf /
//   h264_amf を渡して go/no-go を判定する。
// - ピクセルフォーマットをエンコーダの対応形式から動的に決定する。h264_mf は
//   NV12 のみ受け付ける可能性が高いため、yuv420p 固定だと open に失敗しうる。
//
// 使い方: reframe <input> <output> <blur-pad|crop-cover> <target_w> <target_h> [encoder]
//   例(Windows, HW 検証): reframe in.mp4 out.mp4 blur-pad 1080 1920 h264_mf

extern crate ffmpeg_next as ffmpeg;

use std::env;
use std::ffi::CStr;

use ffmpeg::ffi::{
	av_get_pix_fmt_name, av_pix_fmt_desc_get, AVPixelFormat, AV_PIX_FMT_FLAG_HWACCEL,
};
use ffmpeg::{
	codec, decoder, encoder, filter, format, frame, media, Codec, Dictionary, Packet, Rational,
};

/// libavfilter の buffer ソースへ渡す pix_fmt 名を安全に得る。
fn pix_fmt_name(p: format::Pixel) -> String {
	unsafe {
		let raw: AVPixelFormat = p.into();
		let ptr = av_get_pix_fmt_name(raw);
		CStr::from_ptr(ptr).to_string_lossy().into_owned()
	}
}

/// 指定フォーマットがハードウェアサーフェス形式(AV_PIX_FMT_FLAG_HWACCEL)かを判定する。
/// このスパイクはソフトウェアフレームをエンコーダへ直接 send_frame する(hw_frames_ctx
/// を組まない)ため、hwaccel 形式(例: h264_videotoolbox の VIDEOTOOLBOX)は
/// 候補から除外する必要がある。
fn is_hwaccel_format(p: format::Pixel) -> bool {
	unsafe {
		let raw: AVPixelFormat = p.into();
		let desc = av_pix_fmt_desc_get(raw);
		if desc.is_null() {
			return false;
		}
		(*desc).flags & (AV_PIX_FMT_FLAG_HWACCEL as u64) != 0
	}
}

/// エンコーダが対応するソフトウェアピクセルフォーマットの先頭を採用する。
/// `codec.video().formats()` は `pix_fmts` が NULL の場合 None を返す
/// (対応形式を宣言していないエンコーダがある)ため、その場合や候補が
/// hwaccel 形式しかない場合は yuv420p にフォールバックする。
/// 例: h264_videotoolbox は [VIDEOTOOLBOX(hw), NV12, YUV420P] の順で報告するため
/// NV12 を採用する(既存の mac 経路は yuv420p 固定でも動くが、この関数は
/// h264_mf 等 NV12 専用エンコーダも同じロジックで扱えるようにするためのもの)。
fn pick_pixel_format(codec: Codec) -> format::Pixel {
	codec
		.video()
		.ok()
		.and_then(|v| v.formats())
		.and_then(|mut it| it.find(|&f| !is_hwaccel_format(f)))
		.unwrap_or(format::Pixel::YUV420P)
}

/// buffer → (spec) → buffersink のグラフを構築。spec の入力は [in]、出力は [out]。
fn build_filter(
	spec: &str,
	decoder: &decoder::Video,
	enc_format: format::Pixel,
	time_base: Rational,
) -> Result<filter::Graph, ffmpeg::Error> {
	let mut graph = filter::Graph::new();

	let sar = decoder.aspect_ratio();
	let sar = if sar.numerator() == 0 {
		Rational(1, 1)
	} else {
		sar
	};
	let args = format!(
		"width={}:height={}:pix_fmt={}:time_base={}:pixel_aspect={}",
		decoder.width(),
		decoder.height(),
		pix_fmt_name(decoder.format()),
		time_base,
		sar,
	);

	graph.add(&filter::find("buffer").unwrap(), "in", &args)?;
	graph.add(&filter::find("buffersink").unwrap(), "out", "")?;
	{
		let mut out = graph.get("out").unwrap();
		out.set_pixel_format(enc_format);
	}
	graph.output("in", 0)?.input("out", 0)?.parse(spec)?;
	graph.validate()?;
	println!("--- filtergraph ---\n{}", graph.dump());
	Ok(graph)
}

/// フィルタグラフの文字列を組み立てる。末尾の `format=` はエンコーダの
/// `set_format` と必ず一致させる(不一致だとエンコーダ open やフレーム投入で失敗する)。
fn filter_spec(fit: &str, tw: u32, th: u32, pix_fmt: &str) -> String {
	match fit {
		"blur-pad" => format!(
			"[in]split=2[bg][fg];\
			 [bg]scale={tw}:{th}:force_original_aspect_ratio=increase,crop={tw}:{th},gblur=sigma=20[bgb];\
			 [fg]scale={tw}:{th}:force_original_aspect_ratio=decrease[fgs];\
			 [bgb][fgs]overlay=(W-w)/2:(H-h)/2,format={pix_fmt}[out]"
		),
		// crop-cover(既定)
		_ => format!(
			"[in]scale={tw}:{th}:force_original_aspect_ratio=increase,crop={tw}:{th},format={pix_fmt}[out]"
		),
	}
}

fn main() {
	let input = env::args().nth(1).expect("missing input");
	let output = env::args().nth(2).expect("missing output");
	let fit = env::args().nth(3).unwrap_or_else(|| "blur-pad".to_string());
	let tw: u32 = env::args()
		.nth(4)
		.and_then(|s| s.parse().ok())
		.unwrap_or(1080);
	let th: u32 = env::args()
		.nth(5)
		.and_then(|s| s.parse().ok())
		.unwrap_or(1920);
	// エンコーダ名(第6引数)。既定は mac の HW 第一候補 h264_videotoolbox。
	// Windows 検証では h264_mf / h264_amf を渡す(§Phase2 作業 2-0)。
	let encoder_name = env::args()
		.nth(6)
		.unwrap_or_else(|| "h264_videotoolbox".to_string());

	ffmpeg::init().unwrap();

	let mut ictx = format::input(&input).unwrap();
	let mut octx = format::output(&output).unwrap();

	let ist = ictx
		.streams()
		.best(media::Type::Video)
		.expect("no video stream");
	let ist_index = ist.index();
	let ist_time_base = ist.time_base();

	let mut decoder = codec::context::Context::from_parameters(ist.parameters())
		.unwrap()
		.decoder()
		.video()
		.unwrap();

	// --- エンコーダ: CLI 引数で指定(既定 h264_videotoolbox, §11-2)。
	let codec = encoder::find_by_name(&encoder_name)
		.unwrap_or_else(|| panic!("encoder not available: {encoder_name}"));

	// --- ピクセルフォーマットの吸収 ---
	// h264_mf は NV12 のみ受け付ける可能性が高いなど、エンコーダごとに対応
	// pix_fmt が異なる。エンコーダの対応ソフトウェア形式の先頭を採用し(hwaccel
	// サーフェス形式は除外。詳細は pick_pixel_format 参照)、取得できない場合は
	// yuv420p にフォールバックする。フィルタ末尾の `format=` とエンコーダの
	// `set_format` はここで揃える。
	let enc_format = pick_pixel_format(codec);
	let enc_pix_name = pix_fmt_name(enc_format);

	let global_header = octx.format().flags().contains(format::Flags::GLOBAL_HEADER);
	let mut ost = octx.add_stream(codec).unwrap();

	let mut enc = codec::context::Context::new_with_codec(codec)
		.encoder()
		.video()
		.unwrap();
	enc.set_width(tw);
	enc.set_height(th);
	enc.set_format(enc_format);
	enc.set_time_base(ist_time_base);
	enc.set_frame_rate(decoder.frame_rate());
	enc.set_aspect_ratio(Rational(1, 1));
	enc.set_bit_rate(8_000_000); // 現 runner 既定 8M(§12.3 IG VBR≤25M に収まる)
	if global_header {
		enc.set_flags(codec::Flags::GLOBAL_HEADER);
	}
	// h264_mf は ffmpeg 上 hybrid 扱いで既定 -hw_encoding=false のため、
	// 明示的に "1" を渡さないとソフトウェア MFT にフォールバックする(§Phase2-0 追試)。
	// 他のエンコーダ(h264_amf 等)の挙動は変えない。
	let mut enc_opts = Dictionary::new();
	if encoder_name == "h264_mf" {
		enc_opts.set("hw_encoding", "1");
	}
	let opened = enc.open_with(enc_opts).expect("open encoder failed");
	ost.set_parameters(&opened);
	let mut encoder = opened;

	let spec = filter_spec(&fit, tw, th, &enc_pix_name);
	println!("fit={fit} target={tw}x{th} encoder={encoder_name} pix_fmt={enc_pix_name}");
	let mut graph = build_filter(&spec, &decoder, enc_format, ist_time_base).unwrap();

	// --- mp4 に +faststart(moov 先頭, §12.1/§6.2)---
	let mut mux_opts = Dictionary::new();
	mux_opts.set("movflags", "+faststart");
	octx.write_header_with(mux_opts).unwrap();
	let ost_time_base = octx.stream(0).unwrap().time_base();

	let mut decoded = frame::Video::empty();
	let mut filtered = frame::Video::empty();
	let mut encoded = Packet::empty();

	let mut drain_encoder = |encoder: &mut encoder::Video, octx: &mut format::context::Output| {
		while encoder.receive_packet(&mut encoded).is_ok() {
			encoded.set_stream(0);
			encoded.rescale_ts(ist_time_base, ost_time_base);
			encoded.write_interleaved(octx).unwrap();
		}
	};

	let mut pull_filtered = |graph: &mut filter::Graph,
	                         encoder: &mut encoder::Video,
	                         octx: &mut format::context::Output| {
		while graph
			.get("out")
			.unwrap()
			.sink()
			.frame(&mut filtered)
			.is_ok()
		{
			encoder.send_frame(&filtered).unwrap();
			drain_encoder(encoder, octx);
		}
	};

	for (stream, packet) in ictx.packets() {
		if stream.index() != ist_index {
			continue;
		}
		decoder.send_packet(&packet).unwrap();
		while decoder.receive_frame(&mut decoded).is_ok() {
			let ts = decoded.timestamp();
			decoded.set_pts(ts);
			graph.get("in").unwrap().source().add(&decoded).unwrap();
			pull_filtered(&mut graph, &mut encoder, &mut octx);
		}
	}

	// flush: decoder → filter → encoder
	decoder.send_eof().unwrap();
	while decoder.receive_frame(&mut decoded).is_ok() {
		let ts = decoded.timestamp();
		decoded.set_pts(ts);
		graph.get("in").unwrap().source().add(&decoded).unwrap();
		pull_filtered(&mut graph, &mut encoder, &mut octx);
	}
	graph.get("in").unwrap().source().flush().unwrap();
	pull_filtered(&mut graph, &mut encoder, &mut octx);

	encoder.send_eof().unwrap();
	drain_encoder(&mut encoder, &mut octx);

	octx.write_trailer().unwrap();
	println!("done -> {output}");
}
