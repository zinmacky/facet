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
}
