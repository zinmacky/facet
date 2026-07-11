//! デコード → フィルタ → エンコード → mux のメインループ。
//!
//! スパイク(`spikes/libav-reframe/src/reframe.rs`)のループ構造を移植しつつ、
//! `unwrap` をすべて `Result<_, MediaError>` の伝搬に置き換えている。
//!
//! **Wave 3 のためのフックをここで固定する**(公開 API として安定させ、Wave 3 の
//! 3 エージェントが並行でこのシグネチャへ接続できるようにする):
//! - [`crate::cancel::CancelToken`] をループ境界(パケット単位)で毎回チェックする。
//!   キャンセルを検知したら一時出力ファイルを削除して `MediaError::Cancelled` を返す。
//!   クローン可能・スレッド安全なので、将来 Tauri コマンド(別スレッド/非同期)から
//!   同じトークンの `cancel()` を呼んで中断できる(`cancel.rs` 冒頭コメント参照)。
//! - `on_progress: &dyn Fn(Progress)` をエンコーダへフレームを送出するたびに呼ぶ。
//!   `Progress` はフレーム数ベースの最小構造体(frame / total_frames 推定 / percent)。
//!   Wave 3 の `progress.rs` が fps/speed 等へ拡張する前提。
//! - エンコーダは [`EncoderSelection`] として引数注入する(`Explicit` は明示指定、
//!   `Auto` はプラットフォーム別候補を `encoder_select` から取得し順に試す。
//!   Wave 2 配線で確定)。
//!
//! **キャンセル/失敗時の出力の扱い**: 出力は一時ファイル名(`<stem>.tmp.<ext>`)に書き、
//! 正常終了時のみ最終ファイル名へリネームする。途中終了(エラー・キャンセルいずれも)は
//! 一時ファイルを削除するため、`output_path` に不完全な mp4 が残ることはない
//! (docs/desktop-migration-plan.md §6.2)。
//!
//! **Wave 2 で接続したモジュール**:
//! - `trim`: `open_input` 直後に `TrimWindow::new(trim, trim::AV_TIME_BASE)` の
//!   `start_ts()` で demuxer をシークし(`start_ts == 0` ならシーク自体を省略)、
//!   デコードループでは `ist_time_base` の `TrimWindow` で各フレームを
//!   `classify()` する(`Skip` は破棄して継続、`Stop` はループを抜けて flush、
//!   `Keep` は `rebase()` で pts を再基準化してから通常処理)。`trim` が `None` の
//!   場合、`TrimWindow` は no-op(常に `Keep`・恒等 rebase)になるため、分岐を
//!   増やさずに同じコードパスで扱える。
//! - `crop`: `ReframeOptions.crop`(+ `source`)から `crop::crop_filter()` で
//!   文字列化し、`fit::FilterGraphSpec.pre_crop` へ接続する。
//! - `encoder_select`: `ReframeOptions.encoder` が `Auto` の場合、候補を先頭から
//!   順に `encode::open_encoder` で試し、`MediaError::EncoderOpen` なら次候補へ、
//!   それ以外の失敗は即座に返す。

use std::fs;
use std::path::{Path, PathBuf};

use ffmpeg_next::{self as ffmpeg, filter, format, frame, Dictionary, Packet, Rational};

use crate::cancel::CancelToken;
use crate::crop;
use crate::decode;
use crate::encode::{self, EncoderSpec};
use crate::encoder_select;
use crate::error::{MediaError, Result};
use crate::fit::{self, FilterGraphSpec};
use crate::probe;
use crate::spec::{CropRect, Preset, SourceDimensions, Trim};
use crate::trim::{self, TrimDecision, TrimWindow};

/// パイプライン進捗の最小構造体。
///
/// Wave 1 時点ではフレーム数ベースの最小情報のみを持つ(fps/speed 等は Wave 3 の
/// `progress.rs` が拡張する)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Progress {
	/// これまでにエンコーダへ送出したフレーム数。
	pub frame: u64,
	/// コンテナ申告値等から見積もった総フレーム数(不明なら `None`)。
	pub total_frames: Option<u64>,
	/// 0.0〜100.0(見積り不能なら `None`)。
	pub percent: Option<f64>,
}

impl Progress {
	fn new(frame: u64, total_frames: Option<u64>) -> Self {
		let percent = total_frames
			.filter(|&total| total > 0)
			.map(|total| (frame as f64 / total as f64 * 100.0).min(100.0));
		Progress {
			frame,
			total_frames,
			percent,
		}
	}
}

/// エンコーダの選び方。`Explicit` はテスト・CLI での明示指定用、`Auto` は
/// `encoder_select` のプラットフォーム別候補を先頭から順に試す(Wave 2 配線)。
pub enum EncoderSelection<'a> {
	/// `encoder_select::select()` が返す候補を先頭から順に試す。
	/// 全滅した場合は最後の `MediaError::EncoderOpen`(候補が 1 つも登録されて
	/// いない場合は `MediaError::NoEncoderCandidate`)を返す。
	Auto,
	/// エンコーダ名 + 追加オプションを直接指定する(単体テスト・CLI の
	/// 明示指定用途)。`encoder_select` を経由しない。
	Explicit {
		name: &'a str,
		options: Dictionary<'a>,
	},
}

/// [`reframe`] に渡すオプション一式。
pub struct ReframeOptions<'a> {
	pub preset: &'a Preset,
	/// blur-pad の gblur sigma。既定は [`fit::DEFAULT_SIGMA`]。
	pub sigma: u32,
	/// ソース側の事前クロップ矩形(0..1 正規化)。`None` なら事前クロップなし
	/// (`EditSpec.crop` に対応、Wave 2 配線)。
	pub crop: Option<CropRect>,
	/// 元動画の実ピクセル寸法。`crop` を実ピクセルの `crop=` フィルタへ解決するのに
	/// 使う(`crop` が `None` の場合は未使用。`EditSpec.source` に対応)。
	pub source: SourceDimensions,
	/// 秒単位のイン/アウト点。`None` なら全尺を処理する(`EditSpec.trim` に対応、
	/// Wave 2 配線)。
	pub trim: Option<Trim>,
	pub encoder: EncoderSelection<'a>,
	pub bit_rate: usize,
	/// クローン可能・スレッド安全なキャンセルトークン([`CancelToken`] 冒頭コメント参照)。
	pub cancel: &'a CancelToken,
	pub on_progress: &'a dyn Fn(Progress),
}

/// `EditSpec` 1 つを libav パイプラインで実行し、`input_path` を `preset` 形状へ
/// 再フレーミングして `output_path` に書き出す(映像のみ。音声は Wave 3 の `audio.rs`
/// で追加予定 — `lib.rs` 冒頭コメント参照)。
///
/// 出力は完了時のみ `output_path` に現れる(§6.2、モジュール冒頭コメント参照)。
///
/// 戻り値は実際に使われたエンコーダ名(`encode::open_encoder` に渡した
/// `EncoderSpec.name`)。`EncoderSelection::Auto` の場合、どの候補が採用されたかを
/// 呼び出し側(ログ・実機検証・将来の UI 表示)が確認できるようにするための情報
/// (Wave 2 配線)。
pub fn reframe(
	input_path: &Path,
	output_path: &Path,
	options: ReframeOptions<'_>,
) -> Result<String> {
	ffmpeg::init().map_err(|source| MediaError::Init { source })?;

	let tmp_output_path = temp_output_path(output_path);
	match run_pipeline(input_path, &tmp_output_path, options) {
		Ok(encoder_name) => {
			fs::rename(&tmp_output_path, output_path)?;
			Ok(encoder_name)
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
) -> Result<String> {
	let ReframeOptions {
		preset,
		sigma,
		crop,
		source,
		trim,
		encoder,
		bit_rate,
		cancel,
		on_progress,
	} = options;

	let mut decode_ctx = decode::open_input(input_path)?;
	let ist_index = decode_ctx.stream_index;
	let ist_time_base = decode_ctx.time_base;
	let container_total_frames = decode_ctx.total_frames;
	let frame_rate = decode_ctx.decoder.frame_rate();

	// trim: demuxer シーク(統合ガイド 1.、trim.rs 冒頭コメント参照)。
	// `trim` が `None` の場合、`TrimWindow::new(None, ..)` は start_ts=0 の no-op
	// window になるため、以下は無条件に実行してよい(start_ts==0 ならシーク省略)。
	let seek_window = TrimWindow::new(trim.as_ref(), trim::AV_TIME_BASE);
	if seek_window.start_ts() != 0 {
		decode_ctx
			.input
			.seek(seek_window.start_ts(), ..)
			.map_err(|source| MediaError::Seek {
				path: input_path.to_path_buf(),
				source,
			})?;
	}

	// trim ありの場合のみ、実効尺(ソース尺 - trim)から総フレーム数を見積もり直す
	// (統合ガイド 3.)。trim なしなら従来どおりコンテナ申告値を使う(数値計算自体は
	// [`total_frames_with_trim`] に切り出してユニットテスト可能にしている)。
	let total_frames = match trim.as_ref() {
		Some(t) => {
			let video_stream =
				decode_ctx
					.input
					.stream(ist_index)
					.ok_or(MediaError::InputStreamMissing {
						path: input_path.to_path_buf(),
						index: ist_index,
					})?;
			let source_duration_secs = probe::duration_seconds(&decode_ctx, &video_stream);
			total_frames_with_trim(t, frame_rate, source_duration_secs)
		}
		None => container_total_frames,
	};

	// フレーム単位の trim 分類・再基準化用ウィンドウ(ストリームのタイムベース)。
	let frame_window = TrimWindow::new(trim.as_ref(), ist_time_base);

	// `input`/`decoder` を別々の可変参照として取り出す(同一ループ内で両方を
	// 独立に可変借用するため。DecodeContext のフィールドは互いに素なので安全)。
	let decoder = &mut decode_ctx.decoder;
	let input = &mut decode_ctx.input;

	let mut octx = format::output(tmp_output_path).map_err(|source| MediaError::OutputCreate {
		path: tmp_output_path.to_path_buf(),
		source,
	})?;

	let global_header = octx.format().flags().contains(format::Flags::GLOBAL_HEADER);
	let (mut encoder_ctx, enc_pix_fmt, stream_index, encoder_name_used) = open_selected_encoder(
		&mut octx,
		encoder,
		preset,
		ist_time_base,
		frame_rate,
		bit_rate,
		global_header,
	)?;

	let enc_pix_name = encode::pix_fmt_name(enc_pix_fmt);
	let pre_crop = crop.map(|rect| crop::crop_filter(rect, source));
	let filter_spec_str = fit::build_filter_graph(&FilterGraphSpec {
		preset,
		pre_crop: pre_crop.as_deref(),
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
	// trim の end に到達してループを早期終了したか(統合ガイド 2. `Stop`)。
	// 早期終了時はデコーダ内部にまだ残っているかもしれない未取得フレームも
	// (pts が単調増加である限り)すべて end 以降のため、デコーダ側の EOF flush は
	// 行わずフィルタ/エンコーダの flush のみ行う。
	let mut stopped_early = false;

	'decode: for (stream, packet) in input.packets() {
		if cancel.is_cancelled() {
			return Err(MediaError::Cancelled);
		}
		if stream.index() != ist_index {
			continue;
		}
		decoder
			.send_packet(&packet)
			.map_err(|source| MediaError::Decode { source })?;
		while decoder.receive_frame(&mut decoded).is_ok() {
			match classify_and_rebase(&mut decoded, &frame_window) {
				TrimDecision::Skip => continue,
				TrimDecision::Stop => {
					stopped_early = true;
					break 'decode;
				}
				TrimDecision::Keep => {}
			}
			push_to_filter(&mut graph, &decoded)?;
			pull_filtered(
				&mut graph,
				&mut encoder_ctx,
				&mut octx,
				stream_index,
				ist_time_base,
				ost_time_base,
				&mut filtered,
				&mut encoded,
				&mut frame_count,
				total_frames,
				on_progress,
			)?;
		}
		if cancel.is_cancelled() {
			return Err(MediaError::Cancelled);
		}
	}

	// flush: decoder → filter → encoder(スパイク同様の 3 段 flush)。
	// trim の end で早期終了した場合はデコーダ側の flush をスキップする
	// (上の `stopped_early` コメント参照)。
	if !stopped_early {
		decoder
			.send_eof()
			.map_err(|source| MediaError::Decode { source })?;
		while decoder.receive_frame(&mut decoded).is_ok() {
			match classify_and_rebase(&mut decoded, &frame_window) {
				TrimDecision::Skip => continue,
				TrimDecision::Stop => break,
				TrimDecision::Keep => {}
			}
			push_to_filter(&mut graph, &decoded)?;
			pull_filtered(
				&mut graph,
				&mut encoder_ctx,
				&mut octx,
				stream_index,
				ist_time_base,
				ost_time_base,
				&mut filtered,
				&mut encoded,
				&mut frame_count,
				total_frames,
				on_progress,
			)?;
		}
	}
	flush_filter_source(&mut graph)?;
	pull_filtered(
		&mut graph,
		&mut encoder_ctx,
		&mut octx,
		stream_index,
		ist_time_base,
		ost_time_base,
		&mut filtered,
		&mut encoded,
		&mut frame_count,
		total_frames,
		on_progress,
	)?;

	encoder_ctx
		.send_eof()
		.map_err(|source| MediaError::Encode { source })?;
	drain_encoder(
		&mut encoder_ctx,
		&mut octx,
		stream_index,
		ist_time_base,
		ost_time_base,
		&mut encoded,
	)?;

	octx.write_trailer()
		.map_err(|source| MediaError::Mux { source })?;
	// Windows で書き込み中ハンドルが残ったままリネームすると失敗しうるため、
	// ここで明示的に出力コンテキストを閉じる(Drop で avio を close する)。
	drop(octx);

	Ok(encoder_name_used)
}

/// デコード済みフレームの trim 分類を行い、`Keep` の場合は pts を再基準化する
/// (統合ガイド 2.)。pts が不明な場合は分類できないため `Keep`(素通し、pts は
/// 変更しない)として扱う(防御的フォールバック。通常のストリームでは発生しない)。
fn classify_and_rebase(decoded: &mut frame::Video, frame_window: &TrimWindow) -> TrimDecision {
	match decoded.timestamp() {
		Some(pts) => {
			let decision = frame_window.classify(pts);
			if decision == TrimDecision::Keep {
				decoded.set_pts(Some(frame_window.rebase(pts)));
			}
			decision
		}
		None => TrimDecision::Keep,
	}
}

/// trim 適用時の `Progress.total_frames` を見積もる(統合ガイド 3.)。
/// フレームレートが不明(`frame_rate: None`)な場合は見積り不能として `None` を返す。
/// `trim なし` のケースはこの関数の外側(呼び出し側、`run_pipeline`)で
/// コンテナ申告値をそのまま使うため、ここでは扱わない。
fn total_frames_with_trim(
	trim: &Trim,
	frame_rate: Option<Rational>,
	source_duration_secs: f64,
) -> Option<u64> {
	let frame_rate = frame_rate?;
	trim::estimate_total_frames(
		trim::effective_duration_secs(Some(trim), source_duration_secs),
		frame_rate,
	)
}

/// [`EncoderSelection`] に従ってエンコーダを開く。戻り値の `String` は実際に
/// 使われたエンコーダ名(`reframe` の戻り値としてそのまま呼び出し側へ伝わる)。
///
/// `Auto` の場合は `encoder_select::select()` が返す候補を先頭から順に試し、
/// `MediaError::EncoderOpen`(open 失敗)なら次候補へ進む。それ以外の失敗
/// (`EncoderNotFound` 等)は即座に返す。全候補が `EncoderOpen` で失敗した場合は
/// 最後に発生した `EncoderOpen` を返す(§11-2: libx264 等へのソフトウェア
/// フォールバックはしない)。
#[allow(clippy::too_many_arguments)]
fn open_selected_encoder(
	octx: &mut format::context::Output,
	selection: EncoderSelection<'_>,
	preset: &Preset,
	time_base: Rational,
	frame_rate: Option<Rational>,
	bit_rate: usize,
	global_header: bool,
) -> Result<(ffmpeg::encoder::Video, format::Pixel, usize, String)> {
	match selection {
		EncoderSelection::Explicit { name, options } => {
			let (opened, pixel_format, stream_index) = encode::open_encoder(
				octx,
				EncoderSpec {
					name,
					options,
					width: preset.width,
					height: preset.height,
					time_base,
					frame_rate,
					bit_rate,
					global_header,
				},
			)?;
			Ok((opened, pixel_format, stream_index, name.to_string()))
		}
		EncoderSelection::Auto => {
			let candidates = encoder_select::select()?;
			let mut last_err: Option<MediaError> = None;
			for choice in candidates {
				let attempt = encode::open_encoder(
					octx,
					EncoderSpec {
						name: choice.name,
						options: choice.to_dictionary(),
						width: preset.width,
						height: preset.height,
						time_base,
						frame_rate,
						bit_rate,
						global_header,
					},
				);
				match attempt {
					Ok((opened, pixel_format, stream_index)) => {
						return Ok((opened, pixel_format, stream_index, choice.name.to_string()))
					}
					Err(err @ MediaError::EncoderOpen { .. }) => last_err = Some(err),
					Err(err) => return Err(err),
				}
			}
			// `encoder_select::select()` は候補が 1 つもない場合
			// `MediaError::NoEncoderCandidate` を返す(=ここには来ない)ため、
			// `last_err` は理論上必ず `Some` になる。防御的に `None` の場合は
			// `unwrap`/`expect` せず明確なエラーを返す。
			Err(last_err.unwrap_or(MediaError::NoEncoderCandidate {
				platform: "auto".to_string(),
				attempted: Vec::new(),
			}))
		}
	}
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
fn pull_filtered(
	graph: &mut filter::Graph,
	encoder: &mut ffmpeg::encoder::Video,
	octx: &mut format::context::Output,
	stream_index: usize,
	ist_time_base: Rational,
	ost_time_base: Rational,
	filtered: &mut frame::Video,
	encoded: &mut Packet,
	frame_count: &mut u64,
	total_frames: Option<u64>,
	on_progress: &dyn Fn(Progress),
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
		on_progress(Progress::new(*frame_count, total_frames));
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	// --- Progress::new (既存の Wave 1 テストの範囲。回帰確認用) -------------------------

	#[test]
	fn progress_percent_is_none_when_total_unknown() {
		let progress = Progress::new(5, None);
		assert_eq!(progress.frame, 5);
		assert_eq!(progress.total_frames, None);
		assert_eq!(progress.percent, None);
	}

	#[test]
	fn progress_percent_is_clamped_to_100() {
		let progress = Progress::new(120, Some(100));
		assert_eq!(progress.percent, Some(100.0));
	}

	// --- temp_output_path --------------------------------------------------------------

	#[test]
	fn temp_output_path_preserves_extension() {
		let tmp = temp_output_path(Path::new("/out/video.mp4"));
		assert_eq!(tmp, PathBuf::from("/out/video.tmp.mp4"));
	}

	#[test]
	fn temp_output_path_without_extension_appends_tmp_suffix() {
		let tmp = temp_output_path(Path::new("/out/video"));
		assert_eq!(tmp, PathBuf::from("/out/video.tmp"));
	}

	// --- open_selected_encoder: Auto の全滅時に Explicit ではなく候補ループを
	//     経由すること自体は実 FFmpeg 依存なので実機検証で確認する(このファイルの
	//     ユニットテストでは encoder_select 側の候補選択ロジックのみを検証する)。

	// --- total_frames_with_trim ----------------------------------------------------------

	#[test]
	fn total_frames_with_trim_uses_effective_duration_and_frame_rate() {
		let t = Trim {
			start: 5.0,
			end: 15.0,
		};
		// 実効尺は 10 秒(effective_duration_secs と同じ計算)、30fps。
		let result = total_frames_with_trim(&t, Some(Rational(30, 1)), 20.0);
		assert_eq!(result, Some(300));
	}

	#[test]
	fn total_frames_with_trim_clamps_to_source_duration() {
		// end がソース尺を超えるケース: effective_duration_secs 側でクランプされる。
		let t = Trim {
			start: 2.0,
			end: 100.0,
		};
		let result = total_frames_with_trim(&t, Some(Rational(30, 1)), 10.0);
		// 実効尺 = 10.0 - 2.0 = 8.0 秒 -> 8.0 * 30 = 240 フレーム。
		assert_eq!(result, Some(240));
	}

	#[test]
	fn total_frames_with_trim_unknown_frame_rate_is_none() {
		let t = Trim {
			start: 0.0,
			end: 5.0,
		};
		assert_eq!(total_frames_with_trim(&t, None, 10.0), None);
	}

	#[test]
	fn encoder_selection_explicit_holds_name_and_options() {
		let mut options = Dictionary::new();
		options.set("hw_encoding", "1");
		let selection = EncoderSelection::Explicit {
			name: "h264_mf",
			options,
		};
		match selection {
			EncoderSelection::Explicit { name, options } => {
				assert_eq!(name, "h264_mf");
				assert_eq!(options.get("hw_encoding"), Some("1"));
			}
			EncoderSelection::Auto => panic!("expected Explicit"),
		}
	}
}
