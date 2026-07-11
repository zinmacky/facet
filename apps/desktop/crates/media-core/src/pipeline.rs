//! デコード → フィルタ → エンコード → mux のメインループ。
//!
//! スパイク(`spikes/libav-reframe/src/reframe.rs`)のループ構造を移植しつつ、
//! `unwrap` をすべて `Result<_, MediaError>` の伝搬に置き換えている。
//!
//! **Wave 3 のためのフックをここで固定する**(公開 API として安定させ、Wave 3 の
//! 3 エージェントが並行でこのシグネチャへ接続できるようにする):
//! - `should_cancel: &dyn Fn() -> bool` をループ境界(パケット単位)で毎回チェックする。
//!   キャンセルを検知したら一時出力ファイルを削除して `MediaError::Cancelled` を返す。
//! - `on_progress: &dyn Fn(Progress)` は `progress::ProgressTracker` 経由で呼ばれる。
//!   `ProgressTracker` がフレームを送出するたびに fps/speed/out_time_secs/percent を
//!   算出し、既定 200ms 間隔でスロットリングした上で `on_progress` を発火する
//!   (`Progress` のフィールド定義・スロットリング仕様は `progress.rs` 参照)。
//! - エンコーダ(名前 + オプション)は `encode::EncoderSpec` として引数注入する
//!   (プラットフォーム別選択ロジックは Wave 2 の `encoder_select` に委ねる)。
//!
//! **キャンセル/失敗時の出力の扱い**: 出力は一時ファイル名(`<stem>.tmp.<ext>`)に書き、
//! 正常終了時のみ最終ファイル名へリネームする。途中終了(エラー・キャンセルいずれも)は
//! 一時ファイルを削除するため、`output_path` に不完全な mp4 が残ることはない
//! (docs/desktop-migration-plan.md §6.2)。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use ffmpeg_next::{self as ffmpeg, filter, format, frame, Dictionary, Packet, Rational};

use crate::decode;
use crate::encode::{self, EncoderSpec};
use crate::error::{MediaError, Result};
use crate::fit::{self, FilterGraphSpec};
use crate::progress::ProgressTracker;
use crate::spec::{Preset, Trim};

/// パイプライン進捗の構造体。定義本体は Wave 3 で `progress.rs` へ移設した
/// (frame/total_frames/percent に加え out_time_secs/fps/speed を持つ)。
pub use crate::progress::Progress;

/// [`reframe`] に渡すオプション一式。
pub struct ReframeOptions<'a> {
	pub preset: &'a Preset,
	/// blur-pad の gblur sigma。既定は [`fit::DEFAULT_SIGMA`]。
	pub sigma: u32,
	/// 計算済みの事前クロップフィルタ文字列。
	/// TODO(Wave 2): `crop.rs` 実装後、`EditSpec.crop` から自動算出して渡す形にする。
	pub pre_crop: Option<&'a str>,
	/// TODO(Wave 2): `trim.rs` 実装後、秒単位のイン/アウト点を入力側のシーク
	/// (`format::context::Input::seek`)と尺制限へ変換して適用する。
	/// Wave 1 時点では受け取るのみで未適用(常に全尺を処理する)。
	pub trim: Option<Trim>,
	pub encoder_name: &'a str,
	pub encoder_options: Dictionary<'a>,
	pub bit_rate: usize,
	pub should_cancel: &'a dyn Fn() -> bool,
	pub on_progress: &'a dyn Fn(Progress),
}

/// `EditSpec` 1 つを libav パイプラインで実行し、`input_path` を `preset` 形状へ
/// 再フレーミングして `output_path` に書き出す(映像のみ。音声は Wave 3 の `audio.rs`
/// で追加予定 — `lib.rs` 冒頭コメント参照)。
///
/// 出力は完了時のみ `output_path` に現れる(§6.2、モジュール冒頭コメント参照)。
pub fn reframe(input_path: &Path, output_path: &Path, options: ReframeOptions<'_>) -> Result<()> {
	ffmpeg::init().map_err(|source| MediaError::Init { source })?;

	let tmp_output_path = temp_output_path(output_path);
	match run_pipeline(input_path, &tmp_output_path, options) {
		Ok(()) => {
			fs::rename(&tmp_output_path, output_path)?;
			Ok(())
		}
		Err(err) => {
			// 途中終了(エラー・キャンセル)。一時出力が存在すれば削除する
			// (存在しない場合の Err は無視してよい)。
			let _ = fs::remove_file(&tmp_output_path);
			Err(err)
		}
	}
}

/// 一時出力ファイルパスを組み立てる。最終的な拡張子(muxer 判定に使われる)を
/// 保つよう `<stem>.tmp.<ext>` の形にする(`<path>.tmp` のように末尾へ単純追加すると
/// `format::output` が拡張子からコンテナ形式を推測できなくなるため)。
fn temp_output_path(output: &Path) -> PathBuf {
	match output.extension().and_then(|ext| ext.to_str()) {
		Some(ext) => {
			let mut tmp = output.with_extension("").into_os_string();
			tmp.push(".tmp.");
			tmp.push(ext);
			PathBuf::from(tmp)
		}
		None => {
			let mut tmp = output.as_os_str().to_os_string();
			tmp.push(".tmp");
			PathBuf::from(tmp)
		}
	}
}

fn run_pipeline(
	input_path: &Path,
	tmp_output_path: &Path,
	options: ReframeOptions<'_>,
) -> Result<()> {
	let ReframeOptions {
		preset,
		sigma,
		pre_crop,
		trim: _trim,
		encoder_name,
		encoder_options,
		bit_rate,
		should_cancel,
		on_progress,
	} = options;

	let mut decode_ctx = decode::open_input(input_path)?;
	let ist_index = decode_ctx.stream_index;
	let ist_time_base = decode_ctx.time_base;
	let total_frames = decode_ctx.total_frames;
	// `input`/`decoder` を別々の可変参照として取り出す(同一ループ内で両方を
	// 独立に可変借用するため。DecodeContext のフィールドは互いに素なので安全)。
	let decoder = &mut decode_ctx.decoder;
	let input = &mut decode_ctx.input;

	let mut octx = format::output(tmp_output_path).map_err(|source| MediaError::OutputCreate {
		path: tmp_output_path.to_path_buf(),
		source,
	})?;

	let global_header = octx.format().flags().contains(format::Flags::GLOBAL_HEADER);
	let (mut encoder, enc_pix_fmt, stream_index) = encode::open_encoder(
		&mut octx,
		EncoderSpec {
			name: encoder_name,
			options: encoder_options,
			width: preset.width,
			height: preset.height,
			time_base: ist_time_base,
			frame_rate: decoder.frame_rate(),
			bit_rate,
			global_header,
		},
	)?;

	let enc_pix_name = encode::pix_fmt_name(enc_pix_fmt);
	let filter_spec_str = fit::build_filter_graph(&FilterGraphSpec {
		preset,
		pre_crop,
		pix_fmt: &enc_pix_name,
		sigma,
	});
	let mut graph = open_filter_graph(decoder, ist_time_base, &filter_spec_str, enc_pix_fmt)?;

	// mp4 に +faststart(moov 先頭。docs/desktop-migration-plan.md §12.1/§6.2)。
	let mut mux_opts = Dictionary::new();
	mux_opts.set("movflags", "+faststart");
	octx.write_header_with(mux_opts)
		.map_err(|source| MediaError::Mux { source })?;
	let ost_time_base = octx
		.stream(stream_index)
		.ok_or(MediaError::OutputStreamMissing {
			index: stream_index,
		})?
		.time_base();

	let mut decoded = frame::Video::empty();
	let mut filtered = frame::Video::empty();
	let mut encoded = Packet::empty();
	let mut frame_count: u64 = 0;
	// 直近で得られたフレームの pts を秒に変換した値(`Progress.out_time_secs` の元)。
	// フィルタ出力フレームの pts が稀に不明(`None`)な場合でも 0 に巻き戻らないよう、
	// 判明したときだけ更新する(`pull_filtered` 内)。
	let mut last_out_time_secs: f64 = 0.0;
	let mut progress_tracker = ProgressTracker::new(total_frames, on_progress);

	for (stream, packet) in input.packets() {
		if should_cancel() {
			return Err(MediaError::Cancelled);
		}
		if stream.index() != ist_index {
			continue;
		}
		decoder
			.send_packet(&packet)
			.map_err(|source| MediaError::Decode { source })?;
		while decoder.receive_frame(&mut decoded).is_ok() {
			let ts = decoded.timestamp();
			decoded.set_pts(ts);
			push_to_filter(&mut graph, &decoded)?;
			pull_filtered(
				&mut graph,
				&mut encoder,
				&mut octx,
				stream_index,
				ist_time_base,
				ost_time_base,
				&mut filtered,
				&mut encoded,
				&mut frame_count,
				&mut last_out_time_secs,
				&mut progress_tracker,
			)?;
		}
		if should_cancel() {
			return Err(MediaError::Cancelled);
		}
	}

	// flush: decoder → filter → encoder(スパイク同様の 3 段 flush)。
	decoder
		.send_eof()
		.map_err(|source| MediaError::Decode { source })?;
	while decoder.receive_frame(&mut decoded).is_ok() {
		let ts = decoded.timestamp();
		decoded.set_pts(ts);
		push_to_filter(&mut graph, &decoded)?;
		pull_filtered(
			&mut graph,
			&mut encoder,
			&mut octx,
			stream_index,
			ist_time_base,
			ost_time_base,
			&mut filtered,
			&mut encoded,
			&mut frame_count,
			&mut last_out_time_secs,
			&mut progress_tracker,
		)?;
	}
	flush_filter_source(&mut graph)?;
	pull_filtered(
		&mut graph,
		&mut encoder,
		&mut octx,
		stream_index,
		ist_time_base,
		ost_time_base,
		&mut filtered,
		&mut encoded,
		&mut frame_count,
		&mut last_out_time_secs,
		&mut progress_tracker,
	)?;

	encoder
		.send_eof()
		.map_err(|source| MediaError::Encode { source })?;
	drain_encoder(
		&mut encoder,
		&mut octx,
		stream_index,
		ist_time_base,
		ost_time_base,
		&mut encoded,
	)?;
	// 完了時は必ず最終進捗を通知する(直前の update がスロットリングで間引かれていても、
	// 呼び出し側は 100% の Progress を確実に受け取れる)。
	progress_tracker.finish(frame_count, last_out_time_secs);

	octx.write_trailer()
		.map_err(|source| MediaError::Mux { source })?;
	// Windows で書き込み中ハンドルが残ったままリネームすると失敗しうるため、
	// ここで明示的に出力コンテキストを閉じる(Drop で avio を close する)。
	drop(octx);

	Ok(())
}

/// `buffer`/`buffersink` を使った最小のフィルタグラフを構築する
/// (スパイクの `build_filter` を移植)。
fn open_filter_graph(
	decoder: &ffmpeg::decoder::Video,
	ist_time_base: Rational,
	filter_spec_str: &str,
	enc_pix_fmt: format::Pixel,
) -> Result<filter::Graph> {
	let mut graph = filter::Graph::new();

	let sar = decode::sample_aspect_ratio(decoder);
	let args = format!(
		"width={}:height={}:pix_fmt={}:time_base={}:pixel_aspect={}",
		decoder.width(),
		decoder.height(),
		encode::pix_fmt_name(decoder.format()),
		ist_time_base,
		sar,
	);

	let buffer_filter = filter::find("buffer").ok_or_else(|| MediaError::FilterNotFound {
		name: "buffer".to_string(),
	})?;
	let buffersink_filter =
		filter::find("buffersink").ok_or_else(|| MediaError::FilterNotFound {
			name: "buffersink".to_string(),
		})?;

	let filter_graph_err = |source: ffmpeg::Error| MediaError::FilterGraph {
		spec: filter_spec_str.to_string(),
		source,
	};

	graph
		.add(&buffer_filter, "in", &args)
		.map_err(filter_graph_err)?;
	graph
		.add(&buffersink_filter, "out", "")
		.map_err(filter_graph_err)?;

	{
		let mut out = graph.get("out").ok_or_else(|| MediaError::FilterNotFound {
			name: "out".to_string(),
		})?;
		out.set_pixel_format(enc_pix_fmt);
	}

	graph
		.output("in", 0)
		.map_err(filter_graph_err)?
		.input("out", 0)
		.map_err(filter_graph_err)?
		.parse(filter_spec_str)
		.map_err(filter_graph_err)?;
	graph.validate().map_err(filter_graph_err)?;

	Ok(graph)
}

fn push_to_filter(graph: &mut filter::Graph, decoded: &frame::Video) -> Result<()> {
	graph
		.get("in")
		.ok_or_else(|| MediaError::FilterNotFound {
			name: "in".to_string(),
		})?
		.source()
		.add(decoded)
		.map_err(|source| MediaError::Filter { source })
}

fn flush_filter_source(graph: &mut filter::Graph) -> Result<()> {
	graph
		.get("in")
		.ok_or_else(|| MediaError::FilterNotFound {
			name: "in".to_string(),
		})?
		.source()
		.flush()
		.map_err(|source| MediaError::Filter { source })
}

fn drain_encoder(
	encoder: &mut ffmpeg::encoder::Video,
	octx: &mut format::context::Output,
	stream_index: usize,
	ist_time_base: Rational,
	ost_time_base: Rational,
	encoded: &mut Packet,
) -> Result<()> {
	while encoder.receive_packet(encoded).is_ok() {
		encoded.set_stream(stream_index);
		encoded.rescale_ts(ist_time_base, ost_time_base);
		encoded
			.write_interleaved(octx)
			.map_err(|source| MediaError::Mux { source })?;
	}
	Ok(())
}

#[allow(clippy::too_many_arguments)]
fn pull_filtered<F: Fn() -> Instant>(
	graph: &mut filter::Graph,
	encoder: &mut ffmpeg::encoder::Video,
	octx: &mut format::context::Output,
	stream_index: usize,
	ist_time_base: Rational,
	ost_time_base: Rational,
	filtered: &mut frame::Video,
	encoded: &mut Packet,
	frame_count: &mut u64,
	last_out_time_secs: &mut f64,
	tracker: &mut ProgressTracker<'_, F>,
) -> Result<()> {
	loop {
		let has_frame = graph
			.get("out")
			.ok_or_else(|| MediaError::FilterNotFound {
				name: "out".to_string(),
			})?
			.sink()
			.frame(filtered)
			.is_ok();
		if !has_frame {
			break;
		}
		encoder
			.send_frame(filtered)
			.map_err(|source| MediaError::Encode { source })?;
		drain_encoder(
			encoder,
			octx,
			stream_index,
			ist_time_base,
			ost_time_base,
			encoded,
		)?;
		*frame_count += 1;
		// フィルタ出力フレームの pts が判明していれば out_time_secs を更新する
		// (`buffersink` は通常 `best_effort_timestamp` を保つが、まれに不明な場合は
		// 直前の値を引き継ぎ 0 に巻き戻さない)。
		if let Some(pts) = filtered.timestamp() {
			*last_out_time_secs = pts_to_secs(pts, ist_time_base);
		}
		tracker.update(*frame_count, *last_out_time_secs);
	}
	Ok(())
}

/// pts(`time_base` 単位の整数)を秒に変換する。
fn pts_to_secs(pts: i64, time_base: Rational) -> f64 {
	pts as f64 * f64::from(time_base.numerator()) / f64::from(time_base.denominator())
}
