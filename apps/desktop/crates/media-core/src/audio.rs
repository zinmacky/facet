//! 音声パイプライン: 検出 → デコード → trim 適用 → リサンプル → AAC エンコード → mux。
//!
//! 参照: docs/desktop-migration-plan.md §12.1/§12.3(出力仕様: AAC ≤48kHz)、
//! `packages/ffmpeg-runner/src/runner.ts`(TS 側の真実の源。`-map 0:a?` +
//! `-c:a aac -b:a 128k` — 音声があれば必ず AAC へ再エンコードして通す、
//! 無ければ何もしない)。
//!
//! ## 責務の境界
//!
//! - **音声は任意**: 入力に音声ストリームが無い場合 [`open_audio_decoder`] は
//!   `Ok(None)` を返し、呼び出し側(pipeline.rs)は映像のみのパイプラインとして
//!   動作を継続する(`ReframeOptions` に音声の有効/無効フラグは存在しない —
//!   `0:a?` と同じ「あれば通す」挙動)。
//! - **trim**: 映像と同じ `trim::TrimWindow` の Skip/Keep/Stop 意味論を、音声ストリーム
//!   自身のタイムベースで独立に適用する。ただし [`AudioPipeline`] が
//!   `pipeline::run_pipeline` の同一パケットループ内でインターリーブ駆動される都合上、
//!   「映像側が trim の end に到達してループを打ち切る(`stopped_early`)」タイミングと
//!   「音声側が自身の trim end に到達するタイミング」は一致するとは限らない
//!   (デマルチプレクサのインターリーブ順序に依存する既知の限界。通常は音声/映像の
//!   pts ずれが 1 GOP 未満のため誤差は数百 ms 程度に収まる想定)。
//! - **pts の再基準化**: 映像は `TrimWindow::rebase` で pts を明示的に 0 基準へ
//!   シフトするが、音声はデコード後の生 pts をそのままエンコーダへは渡さない。
//!   代わりに「エンコーダへ実際に送った累積サンプル数」をそのままエンコーダ側の
//!   pts(`encoder_time_base = 1/sample_rate` 単位)として使う([`AudioPipeline`] の
//!   `next_pts_samples`)。trim で先頭がスキップされたフレームはそもそも
//!   エンコーダへ送られないため、最初に送るフレームが自然に pts=0 になり、
//!   映像の「trim 開始点を 0 に再基準化する」挙動と結果的に一致する。
//! - **リサンプル/フォーマット変換**: `ffmpeg_next::software::resampling::Context`
//!   (libswresample)を使い、サンプルレート・サンプルフォーマット・チャンネル
//!   レイアウトを AAC エンコーダが要求する形へ変換する。
//! - **FIFO バッファリング**: リサンプルは 1 回のデコード済みフレームに対して
//!   任意個数のサンプルを返しうる(レート変換・内部フィルタ遅延のため入力と出力の
//!   サンプル数が一致しない)一方、AAC エンコーダは固定フレームサイズ(通常 1024
//!   サンプル)単位でしか `send_frame` を受け付けない。`ffmpeg_next` はこの再分割の
//!   ための FIFO ラッパーを提供しないため、[`AudioFifo`] としてプレーン単位の
//!   バイトバッファを自前で持つ。

use ffmpeg_next::{
	codec, decoder, encoder, format, frame, media, software::resampling, ChannelLayout, Codec,
	Dictionary, Packet, Rational,
};

use crate::error::{MediaError, Result};
use crate::spec::Trim;
use crate::trim::{TrimDecision, TrimWindow};

/// AAC エンコーダ名(libav 内蔵のネイティブ実装。`packages/ffmpeg-runner` と同じ `aac`)。
pub const AAC_ENCODER_NAME: &str = "aac";

/// AAC の既定ビットレート。`packages/ffmpeg-runner/src/runner.ts` の
/// `DEFAULT_AUDIO_BITRATE = "128k"` と同一。
pub const DEFAULT_AUDIO_BITRATE: usize = 128_000;

/// AAC の最大サンプルレート
/// (docs/desktop-migration-plan.md §12.1/§12.3: 音声コーデックは AAC **≤48kHz**)。
pub const AAC_MAX_SAMPLE_RATE: u32 = 48_000;

/// リサンプラの flush でのサンプル数見積り(内部フィルタ遅延分の掃き出し用の
/// 初期バッファサイズ。実際に必要なサイズと異なっても `swr_convert_frame` が
/// 必要に応じてバッファを再確保するため、あくまで初期ヒントでしかない)。
const FLUSH_SAMPLE_HINT: usize = 4096;

/// 入力サンプルレートから出力(AAC)サンプルレートを決定する純関数。
/// 入力が [`AAC_MAX_SAMPLE_RATE`] 以下ならそのまま、超えるならダウンサンプルする。
pub fn decide_sample_rate(input_rate: u32) -> u32 {
	input_rate.min(AAC_MAX_SAMPLE_RATE)
}

/// 入力の最初の音声ストリームとそのデコーダ。
pub struct AudioSource {
	/// 入力コンテナ内でのストリーム index(パケット振り分けに使う)。
	pub stream_index: usize,
	/// 音声ストリームのタイムベース(trim 分類に使う)。
	pub time_base: Rational,
	pub decoder: decoder::Audio,
}

/// 入力に音声ストリームがあれば開く。無ければ `Ok(None)`
/// (`packages/ffmpeg-runner` の `-map 0:a?` と同じ「あれば通す・無ければ何もしない」)。
pub fn open_audio_decoder(input: &format::context::Input) -> Result<Option<AudioSource>> {
	let Some(stream) = input.streams().best(media::Type::Audio) else {
		return Ok(None);
	};
	let stream_index = stream.index();
	let time_base = stream.time_base();
	let parameters = stream.parameters();

	let decoder = codec::context::Context::from_parameters(parameters)
		.map_err(|source| MediaError::DecoderOpen { source })?
		.decoder()
		.audio()
		.map_err(|source| MediaError::DecoderOpen { source })?;

	Ok(Some(AudioSource {
		stream_index,
		time_base,
		decoder,
	}))
}

/// エンコーダが対応するサンプルフォーマットの先頭を採用する
/// (`encode::pick_pixel_format` の音声版)。AAC ネイティブ実装は通常 `fltp` のみを
/// 宣言するため実質固定だが、将来のエンコーダ差し替えに備えて動的に選ぶ。
/// 候補を宣言しないエンコーダに対しては `f32 planar` にフォールバックする。
fn pick_sample_format(codec: Codec) -> format::Sample {
	codec
		.audio()
		.ok()
		.and_then(|a| a.formats())
		.and_then(|mut formats| formats.next())
		.unwrap_or(format::Sample::F32(format::sample::Type::Planar))
}

/// チャンネル数だけ分かっていて具体的な並び(mask)が未設定なレイアウト
/// (`AV_CHANNEL_ORDER_UNSPEC`、[`ChannelLayout::is_empty`])を、チャンネル数から
/// 導いた標準レイアウト(`ChannelLayout::default`)へ正規化する。
///
/// 生 PCM 由来の入力等、コンテナ/デコーダがチャンネルレイアウトを明示しない
/// ケースでは、デコーダ構築直後の `channel_layout()` が「未設定・チャンネル数の
/// みのプレースホルダ」を返しうる。これをそのまま
/// `resampling::Context::get`(libswresample)の src レイアウトとして使うと、
/// 実際にデコードされたフレームが(libavcodec 内部で)標準レイアウトへ解決されて
/// 報告されるため構成が食い違い `swr_convert_frame` が "Input changed" を返す。
/// 同じ理由で `aac` エンコーダも `"N channels"` を未対応レイアウトとして拒否する。
/// どちらの用途でも正規化してから使う([`pick_channel_layout`] /
/// [`AudioPipeline::open`] の resampler 構築)。
fn normalize_channel_layout(layout: ChannelLayout) -> ChannelLayout {
	if layout.is_empty() {
		ChannelLayout::default(layout.channels().max(1))
	} else {
		layout
	}
}

/// エンコーダが対応するチャンネルレイアウトのうち、入力のチャンネル数を超えない
/// 範囲で最もチャンネル数が多いものを選ぶ(`examples/transcode-audio.rs` と同じ
/// `ChannelLayoutIter::best` の使い方)。エンコーダが候補を宣言しない場合は
/// (正規化した)入力のレイアウトをそのまま使う(AAC ネイティブ実装は多くの
/// レイアウトに対応するため通常はこちらの分岐)。
fn pick_channel_layout(codec: Codec, input_layout: ChannelLayout) -> ChannelLayout {
	let normalized = normalize_channel_layout(input_layout);
	match codec.audio().ok().and_then(|a| a.channel_layouts()) {
		Some(layouts) => layouts.best(normalized.channels()),
		None => normalized,
	}
}

/// [`open_audio_encoder`] が返す、open 済みエンコーダと実際に採用されたパラメータ一式。
struct OpenedAudioEncoder {
	encoder: encoder::Audio,
	format: format::Sample,
	channel_layout: ChannelLayout,
	rate: u32,
	/// 1 回の `send_frame` で要求されるサンプル数(AAC は 1024 固定)。
	/// 0 の場合は可変フレームサイズに対応するコーデック(現状 "aac" では発生しない
	/// 防御的な値。[`AudioPipeline::drain_full_chunks`] 参照)。
	frame_size: usize,
	/// 出力コンテナ内でのストリーム index。
	stream_index: usize,
}

/// AAC エンコーダを構築し、出力コンテキストへストリームとして追加した上で open する。
/// 映像の `encode::open_encoder` と同じく「ストリーム追加とエンコーダ open は不可分」
/// という制約に従う(`ost.set_parameters()` は open 後の値を要求するため)。
///
/// 呼び出し側(pipeline.rs)は映像の `open_selected_encoder` の**後**にこれを呼ぶこと
/// (出力コンテナのストリーム順を「映像 0・音声 1」に保つため)。
fn open_audio_encoder(
	octx: &mut format::context::Output,
	source: &AudioSource,
	bit_rate: usize,
	global_header: bool,
) -> Result<OpenedAudioEncoder> {
	let codec =
		encoder::find_by_name(AAC_ENCODER_NAME).ok_or_else(|| MediaError::EncoderNotFound {
			name: AAC_ENCODER_NAME.to_string(),
		})?;

	let sample_format = pick_sample_format(codec);
	let channel_layout = pick_channel_layout(codec, source.decoder.channel_layout());
	let rate = decide_sample_rate(source.decoder.rate());

	let mut ost = octx
		.add_stream(codec)
		.map_err(|source| MediaError::EncoderOpen {
			name: AAC_ENCODER_NAME.to_string(),
			source,
		})?;
	let stream_index = ost.index();

	let mut encoder_ctx = codec::context::Context::new_with_codec(codec)
		.encoder()
		.audio()
		.map_err(|source| MediaError::EncoderOpen {
			name: AAC_ENCODER_NAME.to_string(),
			source,
		})?;

	encoder_ctx.set_rate(rate as i32);
	encoder_ctx.set_format(sample_format);
	encoder_ctx.set_channel_layout(channel_layout);
	encoder_ctx.set_time_base(Rational(1, rate as i32));
	encoder_ctx.set_bit_rate(bit_rate);
	if global_header {
		encoder_ctx.set_flags(codec::Flags::GLOBAL_HEADER);
	}

	let opened =
		encoder_ctx
			.open_with(Dictionary::new())
			.map_err(|source| MediaError::EncoderOpen {
				name: AAC_ENCODER_NAME.to_string(),
				source,
			})?;
	ost.set_parameters(&opened);

	let frame_size = opened.frame_size() as usize;

	Ok(OpenedAudioEncoder {
		encoder: opened,
		format: sample_format,
		channel_layout,
		rate,
		frame_size,
		stream_index,
	})
}

/// リサンプル後のサンプルを蓄積し、エンコーダのフレームサイズ単位で取り出すための
/// 最小限の FIFO(モジュール冒頭コメント「FIFO バッファリング」参照)。
///
/// プレーン単位のバイトバッファとして持つ(planar フォーマットならチャンネル数分、
/// packed/interleaved フォーマットなら 1 個)。全プレーンが常に同じサンプル数を
/// 保持するという不変条件を、[`AudioFifo::push`] 内で全プレーン共通の `take` 長を
/// 計算することで保つ。
struct AudioFifo {
	format: format::Sample,
	channel_layout: ChannelLayout,
	rate: u32,
	channels: usize,
	bytes_per_sample: usize,
	planes: Vec<Vec<u8>>,
}

impl AudioFifo {
	fn new(format: format::Sample, channel_layout: ChannelLayout, rate: u32) -> Self {
		let channels = channel_layout.channels().max(1) as usize;
		let plane_count = if format.is_planar() { channels } else { 1 };
		AudioFifo {
			format,
			channel_layout,
			rate,
			channels,
			bytes_per_sample: format.bytes(),
			planes: vec![Vec::new(); plane_count],
		}
	}

	/// 1 プレーンあたり・1 サンプルあたりのバイト数
	/// (planar: 1 チャンネル分、packed: 全チャンネル分のインターリーブ)。
	fn stride(&self) -> usize {
		if self.format.is_planar() {
			self.bytes_per_sample
		} else {
			self.bytes_per_sample * self.channels
		}
	}

	/// リサンプル済みフレームをプレーンごとのバイトバッファへ追記する。
	fn push(&mut self, frame: &frame::Audio) {
		let samples = frame.samples();
		if samples == 0 {
			return;
		}
		let stride = self.stride();
		let ideal = samples * stride;
		// 全プレーンの中で最小のプレーン長に揃える(通常は全プレーン同じ長さになる
		// はずだが、万一の不整合でも「全プレーン同じサンプル数」という FIFO の不変
		// 条件を崩さないための防御。境界を割った端数バイトは単に取り込まれず、
		// `available_samples()` のカウントにも入らない — パニックはしない)。
		let take =
			(0..self.planes.len()).fold(ideal, |acc, index| acc.min(frame.data(index).len()));
		for (index, plane_buf) in self.planes.iter_mut().enumerate() {
			let data = frame.data(index);
			plane_buf.extend_from_slice(&data[..take]);
		}
	}

	/// 内部バッファに蓄積されているサンプル数(全プレーン共通)。
	fn available_samples(&self) -> usize {
		let stride = self.stride();
		self.planes.first().map(|p| p.len() / stride).unwrap_or(0)
	}

	/// `want_samples` 分をポップして新しい `frame::Audio` にする。
	/// バッファ不足(`available_samples() < want_samples`)の場合は `None`。
	fn pop(&mut self, want_samples: usize) -> Option<frame::Audio> {
		if want_samples == 0 || self.available_samples() < want_samples {
			return None;
		}
		let take = want_samples * self.stride();
		let mut out = frame::Audio::new(self.format, want_samples, self.channel_layout);
		out.set_rate(self.rate);
		for (index, plane_buf) in self.planes.iter_mut().enumerate() {
			// `take` は `available_samples() >= want_samples` チェック済みのため
			// 理論上必ず `plane_buf.len()` 以下だが、`data_mut` 側のプレーン長との
			// 不一致でパニックしないよう二重に `min` でクランプする。
			let take = take.min(plane_buf.len());
			let chunk: Vec<u8> = plane_buf.drain(0..take).collect();
			let dst = out.data_mut(index);
			let copy_len = take.min(dst.len());
			dst[..copy_len].copy_from_slice(&chunk[..copy_len]);
		}
		Some(out)
	}

	/// 残り全部(端数フレーム)を取り出す。flush 用。空なら `None`。
	fn pop_remainder(&mut self) -> Option<frame::Audio> {
		let remaining = self.available_samples();
		if remaining == 0 {
			return None;
		}
		self.pop(remaining)
	}
}

/// 1 本の音声パイプライン(デコード → trim → リサンプル → FIFO → AAC エンコード → mux)。
///
/// `pipeline::run_pipeline` から、映像と同じパケットループ内でインターリーブして
/// 駆動される(モジュール冒頭の設計コメント参照)。
pub struct AudioPipeline {
	stream_index: usize,
	decoder: decoder::Audio,
	frame_window: TrimWindow,
	/// trim の end に到達したか。true になった後は新規パケットの処理を打ち切る
	/// (pipeline.rs 映像側の `stopped_early` と同じ考え方)。
	stopped: bool,
	resampler: resampling::Context,
	/// リサンプラの構築(`Context::get`)に使った src チャンネルレイアウト
	/// (正規化済み)。デコード済みフレームが持つチャンネルレイアウトは
	/// コンテナ/デコーダによっては「チャンネル数のみのプレースホルダ」
	/// (`AV_CHANNEL_ORDER_UNSPEC`)のままのことがあり、これを正規化前のまま
	/// `resampler.run` へ渡すと `swr_convert_frame` が構成済みの src との
	/// 不一致を検知して "Input changed" を返す。そのため
	/// [`Self::resample_and_buffer`] で各フレームへこの値を明示的に上書きしてから
	/// 渡す(`normalize_channel_layout` 参照)。
	src_channel_layout: ChannelLayout,
	fifo: AudioFifo,
	frame_size: usize,
	encoder: encoder::Audio,
	encoder_time_base: Rational,
	ost_index: usize,
	/// `octx.write_header_with` 後に [`Self::bind_output_time_base`] で確定する。
	/// それまでは `encoder_time_base` を暫定値として持つ(バインド前に使われることは
	/// pipeline.rs の呼び出し順序上ない)。
	ost_time_base: Rational,
	/// エンコーダへ送るフレームの pts(サンプル数の累積値、`encoder_time_base` 単位)。
	/// モジュール冒頭コメント「pts の再基準化」参照。
	next_pts_samples: i64,
	encoded: Packet,
}

impl AudioPipeline {
	/// 音声ストリームがあれば構築する(出力ストリームの追加・エンコーダ open まで行う。
	/// `octx.write_header_with` より前に呼ぶこと — 映像と同じ制約)。
	pub fn open(
		octx: &mut format::context::Output,
		source: AudioSource,
		trim: Option<&Trim>,
		global_header: bool,
	) -> Result<Self> {
		let opened = open_audio_encoder(octx, &source, DEFAULT_AUDIO_BITRATE, global_header)?;

		// リサンプラの src レイアウトは、実際にデコードされるフレームが報告する値
		// (未設定の場合はチャンネル数のみのプレースホルダのまま)に厳密に一致させる
		// 必要がある。正規化した値を使うと `swr_convert_frame` が実フレームとの
		// 不一致を検知して "Input changed" を返す(正規化は dst 側
		// — [`pick_channel_layout`] 経由でエンコーダへ渡す値 — にのみ適用する。
		// エンコーダへ渡すフレームは FIFO がゼロから構築する自前のフレームであり
		// 実フレームとの一致を気にする必要がないため)。
		let src_channel_layout = normalize_channel_layout(source.decoder.channel_layout());
		let resampler = resampling::Context::get(
			source.decoder.format(),
			src_channel_layout,
			source.decoder.rate(),
			opened.format,
			opened.channel_layout,
			opened.rate,
		)
		.map_err(|source| MediaError::Resample { source })?;

		let fifo = AudioFifo::new(opened.format, opened.channel_layout, opened.rate);
		let frame_window = TrimWindow::new(trim, source.time_base);
		let encoder_time_base = Rational(1, opened.rate as i32);

		Ok(AudioPipeline {
			stream_index: source.stream_index,
			decoder: source.decoder,
			frame_window,
			stopped: false,
			resampler,
			src_channel_layout,
			fifo,
			frame_size: opened.frame_size,
			encoder: opened.encoder,
			encoder_time_base,
			ost_index: opened.stream_index,
			ost_time_base: encoder_time_base,
			next_pts_samples: 0,
			encoded: Packet::empty(),
		})
	}

	/// 入力コンテナ内での音声ストリーム index(パケット振り分けに使う)。
	pub fn stream_index(&self) -> usize {
		self.stream_index
	}

	/// `octx.write_header_with` 後、実際に確定した出力ストリームのタイムベースを束縛する。
	pub fn bind_output_time_base(&mut self, octx: &format::context::Output) -> Result<()> {
		let time_base = octx
			.stream(self.ost_index)
			.ok_or(MediaError::OutputStreamMissing {
				index: self.ost_index,
			})?
			.time_base();
		self.ost_time_base = time_base;
		Ok(())
	}

	/// 音声ストリームの 1 パケットを処理する(デコード → trim 分類 → リサンプル →
	/// FIFO → 満杯分をエンコード)。trim の end に既に到達している場合は no-op。
	pub fn process_packet(
		&mut self,
		packet: &Packet,
		octx: &mut format::context::Output,
	) -> Result<()> {
		if self.stopped {
			return Ok(());
		}
		self.decoder
			.send_packet(packet)
			.map_err(|source| MediaError::Decode { source })?;
		let mut decoded = frame::Audio::empty();
		while self.decoder.receive_frame(&mut decoded).is_ok() {
			match classify(&decoded, &self.frame_window) {
				TrimDecision::Skip => continue,
				TrimDecision::Stop => {
					self.stopped = true;
					break;
				}
				TrimDecision::Keep => {}
			}
			self.resample_and_buffer(&mut decoded)?;
			self.drain_full_chunks(octx)?;
		}
		Ok(())
	}

	/// デコーダ・リサンプラ・FIFO・エンコーダを最後まで flush する。
	/// `should_cancel`/進捗通知は行わない(映像側の flush と同様、キャンセルは
	/// メインループ側で既に確定済みの前提で呼ばれる)。
	pub fn flush(&mut self, octx: &mut format::context::Output) -> Result<()> {
		if !self.stopped {
			self.decoder
				.send_eof()
				.map_err(|source| MediaError::Decode { source })?;
			let mut decoded = frame::Audio::empty();
			while self.decoder.receive_frame(&mut decoded).is_ok() {
				match classify(&decoded, &self.frame_window) {
					TrimDecision::Skip => continue,
					TrimDecision::Stop => break,
					TrimDecision::Keep => {}
				}
				self.resample_and_buffer(&mut decoded)?;
			}
		}

		// リサンプラの内部バッファ(フィルタ遅延分)を掃き出す。
		loop {
			let mut flushed = frame::Audio::new(
				self.fifo.format,
				FLUSH_SAMPLE_HINT,
				self.fifo.channel_layout,
			);
			self.resampler
				.flush(&mut flushed)
				.map_err(|source| MediaError::Resample { source })?;
			if flushed.samples() == 0 {
				break;
			}
			self.fifo.push(&flushed);
		}

		self.drain_full_chunks(octx)?;
		if let Some(remainder) = self.fifo.pop_remainder() {
			self.encode_frame(remainder, octx)?;
		}

		self.encoder
			.send_eof()
			.map_err(|source| MediaError::Encode { source })?;
		self.drain_encoder(octx)?;

		Ok(())
	}

	/// リサンプルして FIFO へ積む。
	///
	/// `decoded` のチャンネルレイアウトを [`Self::src_channel_layout`](正規化済み、
	/// リサンプラの構築に使った値)へ明示的に上書きしてから渡す。デコーダ/コンテナ
	/// によっては個々のフレームが「チャンネル数のみのプレースホルダ」レイアウト
	/// (`AV_CHANNEL_ORDER_UNSPEC`)を持ったままのことがあり、これをそのまま
	/// `resampler.run` へ渡すと構築時に指定した(正規化済みの)src レイアウトとの
	/// 不一致を `swr_convert_frame` が検知して "Input changed" を返すため
	/// (`src_channel_layout` フィールドのコメント参照)。
	fn resample_and_buffer(&mut self, decoded: &mut frame::Audio) -> Result<()> {
		decoded.set_channel_layout(self.src_channel_layout);
		let samples_hint = decoded.samples().max(1);
		let mut resampled =
			frame::Audio::new(self.fifo.format, samples_hint, self.fifo.channel_layout);
		self.resampler
			.run(decoded, &mut resampled)
			.map_err(|source| MediaError::Resample { source })?;
		self.fifo.push(&resampled);
		Ok(())
	}

	/// FIFO に溜まった分のうち、フレームサイズちょうどのチャンクだけをエンコードする。
	/// 端数(最後の 1 チャンク未満)は [`Self::flush`] でまとめて送る。
	fn drain_full_chunks(&mut self, octx: &mut format::context::Output) -> Result<()> {
		if self.frame_size == 0 {
			// 可変フレームサイズに対応するコーデック向けの防御的分岐。
			// "aac"(ネイティブ実装)はフレームサイズ固定(1024)のため通常は通らない。
			return Ok(());
		}
		while self.fifo.available_samples() >= self.frame_size {
			match self.fifo.pop(self.frame_size) {
				Some(chunk) => self.encode_frame(chunk, octx)?,
				None => break,
			}
		}
		Ok(())
	}

	fn encode_frame(
		&mut self,
		mut frame: frame::Audio,
		octx: &mut format::context::Output,
	) -> Result<()> {
		frame.set_pts(Some(self.next_pts_samples));
		self.next_pts_samples += frame.samples() as i64;
		self.encoder
			.send_frame(&frame)
			.map_err(|source| MediaError::Encode { source })?;
		self.drain_encoder(octx)
	}

	fn drain_encoder(&mut self, octx: &mut format::context::Output) -> Result<()> {
		while self.encoder.receive_packet(&mut self.encoded).is_ok() {
			self.encoded.set_stream(self.ost_index);
			self.encoded
				.rescale_ts(self.encoder_time_base, self.ost_time_base);
			self.encoded
				.write_interleaved(octx)
				.map_err(|source| MediaError::Mux { source })?;
		}
		Ok(())
	}
}

/// デコード済み音声フレームの trim 分類を行う(映像の `classify_and_rebase` の
/// 音声版)。pts が不明な場合は分類できないため `Keep`(素通し)として扱う
/// (防御的フォールバック。通常のストリームでは発生しない)。
fn classify(decoded: &frame::Audio, frame_window: &TrimWindow) -> TrimDecision {
	match decoded.timestamp() {
		Some(pts) => frame_window.classify(pts),
		None => TrimDecision::Keep,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	// --- decide_sample_rate ---------------------------------------------------------

	#[test]
	fn decide_sample_rate_below_max_is_unchanged() {
		assert_eq!(decide_sample_rate(44_100), 44_100);
	}

	#[test]
	fn decide_sample_rate_at_max_is_unchanged() {
		assert_eq!(decide_sample_rate(48_000), 48_000);
	}

	#[test]
	fn decide_sample_rate_above_max_is_downsampled() {
		assert_eq!(decide_sample_rate(96_000), 48_000);
	}

	#[test]
	fn decide_sample_rate_handles_low_rates() {
		// 8kHz 電話品質のような低レートはそのまま(上限はダウンサンプル方向のみ)。
		assert_eq!(decide_sample_rate(8_000), 8_000);
	}
}
