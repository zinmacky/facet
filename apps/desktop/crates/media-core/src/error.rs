//! media-core 全体で使うエラー型。
//!
//! 方針: `unwrap`/`expect` は使わず、失敗しうる箇所はすべて `Result<T, MediaError>`
//! で呼び出し側へ伝搬する(スパイク `spikes/libav-reframe/src/reframe.rs` は検証用途で
//! `unwrap` 多用だが、media-core 本体では持ち込まない)。variant は「どの段階で・何が」
//! 失敗したかを呼び出し側が判別できる粒度で分ける。

use std::path::PathBuf;

use thiserror::Error;

/// media-core の公開 API 全体で使う `Result` エイリアス。
pub type Result<T> = std::result::Result<T, MediaError>;

#[derive(Debug, Error)]
pub enum MediaError {
	/// `ffmpeg::init()`(libav の全コーデック/フォーマット登録)が失敗した。
	/// 通常は発生しないが、libav 側の初期化失敗を握りつぶさないために区別する。
	#[error("libav の初期化に失敗しました ({source})")]
	Init {
		#[source]
		source: ffmpeg_next::Error,
	},

	/// 入力ファイルを demuxer で開けなかった(存在しない・壊れている・非対応コンテナ等)。
	#[error("入力を開けませんでした: {path} ({source})")]
	InputOpen {
		path: PathBuf,
		#[source]
		source: ffmpeg_next::Error,
	},

	/// 出力ファイル(muxer)を作成できなかった。
	#[error("出力を作成できませんでした: {path} ({source})")]
	OutputCreate {
		path: PathBuf,
		#[source]
		source: ffmpeg_next::Error,
	},

	/// 入力に映像ストリームが存在しない。
	#[error("映像ストリームが見つかりません: {path}")]
	NoVideoStream { path: PathBuf },

	/// 映像ストリームの寸法(width/height)が 0 以下(取得不可)。
	/// TS 版 `probe.ts` の「映像の寸法を取得できません」に対応。
	#[error("映像の寸法を取得できません: {path}")]
	InvalidDimensions { path: PathBuf },

	/// `decode::open_input` が返した `stream_index` を、`format::context::Input` から
	/// 再度引けなかった(通常発生しない内部不整合。probe.rs がフレームレート/尺
	/// 取得のためストリームを再取得する箇所で使用)。
	#[error("入力ストリームが見つかりません(index={index}): {path}")]
	InputStreamMissing { path: PathBuf, index: usize },

	/// 映像ストリームのコーデックパラメータからデコーダを構築できなかった
	/// (非対応コーデック等)。
	#[error("デコーダを構築できませんでした ({source})")]
	DecoderOpen {
		#[source]
		source: ffmpeg_next::Error,
	},

	/// 指定名のエンコーダが libav 側に登録されていない
	/// (例: HW エンコーダ非搭載環境で "h264_amf" を指定した場合)。
	#[error("エンコーダが見つかりません: {name}")]
	EncoderNotFound { name: String },

	/// エンコーダのパラメータ設定または `open_with` が失敗した
	/// (VideoToolbox の -12903 のような HW セッション枯渇等もここに含まれる)。
	#[error("エンコーダを開けませんでした: {name} ({source})")]
	EncoderOpen {
		name: String,
		#[source]
		source: ffmpeg_next::Error,
	},

	/// 必須の libavfilter フィルタ(`buffer`/`buffersink`)や、構築済みグラフ内の
	/// ノード(`in`/`out`)が見つからなかった。通常は環境の libavfilter が
	/// 壊れている・ビルド構成に filter が含まれていない場合のみ発生する。
	#[error("フィルタが見つかりません: {name}")]
	FilterNotFound { name: String },

	/// フィルタグラフの構築(add/parse/validate)が失敗した。
	#[error("フィルタグラフの構築に失敗しました: {spec} ({source})")]
	FilterGraph {
		spec: String,
		#[source]
		source: ffmpeg_next::Error,
	},

	/// デコードループ(send_packet/receive_frame)での失敗。
	#[error("デコード処理に失敗しました ({source})")]
	Decode {
		#[source]
		source: ffmpeg_next::Error,
	},

	/// フィルタグラフへのフレーム投入・取得での失敗。
	#[error("フィルタ処理に失敗しました ({source})")]
	Filter {
		#[source]
		source: ffmpeg_next::Error,
	},

	/// エンコードループ(send_frame/receive_packet)での失敗。
	#[error("エンコード処理に失敗しました ({source})")]
	Encode {
		#[source]
		source: ffmpeg_next::Error,
	},

	/// 多重化(write_header/write_interleaved/write_trailer)での失敗。
	#[error("多重化(mux)処理に失敗しました ({source})")]
	Mux {
		#[source]
		source: ffmpeg_next::Error,
	},

	/// mux 済みの出力ストリームが見つからなかった(通常発生しない内部不整合)。
	#[error("出力ストリームが見つかりません(index={index})")]
	OutputStreamMissing { index: usize },

	/// 一時出力ファイルの作成・リネーム・削除などファイル操作での失敗
	/// (§6.2 キャンセル設計: 出力は一時ファイル名に書き、完了時にリネームする)。
	#[error("入出力エラー: {0}")]
	Io(#[from] std::io::Error),

	/// `should_cancel` フックがループ境界でキャンセルを検知した。
	/// 呼び出し側はこのエラーを受けた時点で一時出力が既に削除済みであることを期待できる
	/// (pipeline.rs の実装契約)。
	#[error("キャンセルされました")]
	Cancelled,

	/// trim 開始点への demuxer シーク(`format::context::Input::seek`)が失敗した。
	#[error("シークに失敗しました: {path} ({source})")]
	Seek {
		path: PathBuf,
		#[source]
		source: ffmpeg_next::Error,
	},

	/// `encoder_select` モジュール: プラットフォーム別の HW エンコーダ候補が
	/// 1 つも使えなかった。`attempted` は候補テーブルの全エンコーダ名
	/// (非対応プラットフォームで候補自体が 0 件の場合は空)。
	///
	/// この判定は `ffmpeg_next::encoder::find_by_name` による登録確認のみに基づく
	/// (`encoder_select::select` の責務)。実際の HW 初期化成否(open 失敗、
	/// ドライバ/セッション枯渇等)はここでは検出できない — その扱いは
	/// `candidates()` の返す順で `encode::open_encoder` を試す呼び出し側の
	/// 候補ループに委ねる(`EncoderOpen` が個々の open 失敗を表す)。
	/// Phase 2 では libx264 等のソフトウェアエンコーダへのフォールバックを
	/// 行わない(docs/desktop-migration-plan.md §11-2)。
	#[error("利用可能な HW エンコーダが見つかりません(platform={platform}, 候補={attempted:?})")]
	NoEncoderCandidate {
		platform: String,
		attempted: Vec<String>,
	},

	/// 音声のリサンプル(サンプルレート/フォーマット/チャンネルレイアウト変換)の
	/// 構築(`resampling::Context::get`)または実行(`run`/`flush`)が失敗した
	/// (`audio.rs`)。
	#[error("音声のリサンプルに失敗しました ({source})")]
	Resample {
		#[source]
		source: ffmpeg_next::Error,
	},

	/// 同一 `output_path` への書き出しが既に別のジョブで実行中(P1-2: 出力先競合防止)。
	///
	/// `pipeline::reframe` はグローバルなレジストリで実行中の出力先パスを追跡しており、
	/// 同じパスへ 2 本目の `reframe`(または `render_preview` 経由の呼び出し)を
	/// 開始しようとすると、実際の書き出し処理(一時ファイル作成・デコーダ/エンコーダ
	/// open 等)には一切入らず、このエラーで即座に失敗する。1 本目が完了(成功・失敗
	/// 問わず)すればレジストリから解放され、同じパスへ再度書き出せるようになる。
	#[error("出力先が既に使用中です(別のジョブが実行中の可能性があります): {path}")]
	OutputBusy { path: PathBuf },

	/// 音声ストリームを検出し `AudioPipeline` を構築、かつ trim 範囲内の音声フレームを
	/// 実際に 1 つ以上デコード済みだったにもかかわらず、最終的に AAC パケットを
	/// 1 つも出力できなかった(想定外の内部不整合)。
	///
	/// この判定は「trim で音声区間が丸ごとスキップされた」という正常系とは区別できる
	/// (`AudioPipeline` が `TrimDecision::Keep` のフレームを 1 度も見ていない場合は
	/// このエラーを出さない)。実際に v0.0.0 で発見された不具合の再発防止用の
	/// 安全網: `ffmpeg_next::frame::Audio::data()` の index>=1 プレーン長バグにより
	/// `AudioFifo` がステレオ以上の音声を丸ごと読み落とし、映像だけの出力を
	/// エラーなく返していた(`audio.rs` の `audio_plane_bytes` 冒頭コメント参照)。
	/// 同種の不具合が再発した場合に「音声が黙って消える」出力を返さず、ここで
	/// 明示的に失敗させる。
	#[error(
		"音声ストリームを検出し、trim 範囲内の音声フレームも存在しましたが、AAC パケットを 1 つも出力できませんでした(入力: 音声あり / 出力: 音声なし)"
	)]
	AudioStreamProducedNoPackets,
}
