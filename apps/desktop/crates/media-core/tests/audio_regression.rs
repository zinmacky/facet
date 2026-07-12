//! 実 FFmpeg を使った音声パイプラインの回帰統合テスト。
//!
//! 背景: `audio.rs` の `AudioFifo`(push/pop)は、ステレオ以上の planar 音声で
//! 右チャンネル以降のサンプルを丸ごと取りこぼし、出力から音声トラックが完全に
//! 消える不具合を持っていた(`ffmpeg_next::frame::Audio::data(index)` が音声フレームの
//! `index >= 1` プレーンに対し常に長さ 0 のスライスを返す既知の制約が原因。
//! `audio.rs` の `audio_plane_bytes` 冒頭コメント参照)。モノラルの実機検証だけでは
//! プレーンが 1 個しか無くこの不具合を踏まないため見逃されていた。
//!
//! `audio.rs` 内の `#[cfg(test)]` ユニットテストは `AudioFifo` 単体をピュアに検証するが、
//! ここでは実際の `ffmpeg`/`ffprobe` CLI で生成した入力を `media_core::reframe()` に
//! 通し、出力 mp4 に音声ストリームが実在し、かつ期待フレーム数に近いことまで
//! エンドツーエンドで確認する(FIFO だけでなくデコード/リサンプル/エンコード/mux の
//! 全段が壊れていないことの保証)。
//!
//! 実 ffmpeg 環境が必要なため `#[ignore]`。`ffmpeg`/`ffprobe` を PATH に通した上で:
//!
//! ```text
//! cargo test -p media-core --test audio_regression -- --ignored --nocapture
//! ```

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use media_core::encode;
use media_core::fit;
use media_core::spec::{FitMode, Preset, SourceDimensions, Trim};
use media_core::{reframe, CancelToken, EncoderSelection, Progress, ReframeOptions};

/// `ffmpeg` CLI で lavfi ソースから入力動画を生成する(存在しなければパニックする —
/// `#[ignore]` テストは実 ffmpeg 環境前提のため、失敗はテスト実装の誤りとして扱う)。
fn generate_input(path: &Path, extra_args: &[&str]) {
	let status = Command::new("ffmpeg")
		.args(["-y", "-hide_banner", "-loglevel", "error"])
		.args(extra_args)
		.arg(path)
		.status()
		.expect("ffmpeg を起動できること(PATH に通っていること)");
	assert!(
		status.success(),
		"ffmpeg での入力生成に失敗しました: {path:?}"
	);
}

struct AudioStreamInfo {
	channel_layout: String,
	sample_rate: u32,
	nb_frames: u64,
}

/// `ffprobe` で最初の音声ストリームの channel_layout/sample_rate/nb_frames を読む。
/// 音声ストリームが存在しない場合は `None`(= 音声が消えている不具合を検知するのに使う)。
fn ffprobe_audio_info(path: &Path) -> Option<AudioStreamInfo> {
	let output = Command::new("ffprobe")
		.args([
			"-v",
			"error",
			"-select_streams",
			"a:0",
			"-show_entries",
			"stream=channel_layout,sample_rate,nb_frames",
			"-of",
			"csv=p=0",
		])
		.arg(path)
		.output()
		.expect("ffprobe を起動できること(PATH に通っていること)");
	assert!(
		output.status.success(),
		"ffprobe の実行に失敗しました: {path:?}"
	);
	let text = String::from_utf8_lossy(&output.stdout);
	let line = text.trim();
	if line.is_empty() {
		return None;
	}
	// `ffprobe -of csv` は `-show_entries` に指定した順ではなく、内部の固定順
	// (sample_rate, channel_layout, nb_frames)でフィールドを出す。
	let parts: Vec<&str> = line.split(',').collect();
	let [sample_rate, channel_layout, nb_frames] = parts.as_slice() else {
		panic!("想定外の ffprobe 出力: {line}");
	};
	Some(AudioStreamInfo {
		channel_layout: channel_layout.to_string(),
		sample_rate: sample_rate.parse().expect("sample_rate は整数のはず"),
		nb_frames: nb_frames.parse().expect("nb_frames は整数のはず"),
	})
}

fn has_video_stream(path: &Path) -> bool {
	let output = Command::new("ffprobe")
		.args([
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=index",
			"-of",
			"csv=p=0",
		])
		.arg(path)
		.output()
		.expect("ffprobe を起動できること");
	!String::from_utf8_lossy(&output.stdout).trim().is_empty()
}

struct VideoStreamInfo {
	r_frame_rate: String,
	nb_frames: u64,
}

/// `ffprobe` で最初の映像ストリームの r_frame_rate/nb_frames を読む。
fn ffprobe_video_info(path: &Path) -> Option<VideoStreamInfo> {
	let output = Command::new("ffprobe")
		.args([
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=r_frame_rate,nb_frames",
			"-of",
			"csv=p=0",
		])
		.arg(path)
		.output()
		.expect("ffprobe を起動できること(PATH に通っていること)");
	assert!(
		output.status.success(),
		"ffprobe の実行に失敗しました: {path:?}"
	);
	let text = String::from_utf8_lossy(&output.stdout);
	let line = text.trim();
	if line.is_empty() {
		return None;
	}
	let parts: Vec<&str> = line.split(',').collect();
	let [r_frame_rate, nb_frames] = parts.as_slice() else {
		panic!("想定外の ffprobe 出力: {line}");
	};
	Some(VideoStreamInfo {
		r_frame_rate: r_frame_rate.to_string(),
		nb_frames: nb_frames.parse().expect("nb_frames は整数のはず"),
	})
}

/// `"30/1"` や `"30000/1001"` 形式の `r_frame_rate` を fps(f64)へ変換する。
fn parse_frame_rate(raw: &str) -> f64 {
	let (num, den) = raw.split_once('/').expect("r_frame_rate は分数形式のはず");
	let num: f64 = num.parse().expect("r_frame_rate の分子は整数のはず");
	let den: f64 = den.parse().expect("r_frame_rate の分母は整数のはず");
	num / den
}

fn run_reframe(input: &Path, output: &Path, trim: Option<Trim>) -> Result<String, String> {
	let preset = Preset {
		name: "audio-regression-test".to_string(),
		width: 1080,
		height: 1920,
		fit: FitMode::BlurPad,
	};
	let cancel = CancelToken::new();
	let on_progress = |_p: Progress| {};
	let options = ReframeOptions {
		preset: &preset,
		sigma: fit::DEFAULT_SIGMA,
		crop: None,
		source: SourceDimensions {
			width: 0,
			height: 0,
		},
		trim,
		encoder: EncoderSelection::Auto,
		bit_rate: encode::DEFAULT_BITRATE,
		cancel: &cancel,
		on_progress: &on_progress,
	};
	reframe(input, output, options).map_err(|err| err.to_string())
}

fn scratch_path(name: &str) -> PathBuf {
	env::temp_dir().join(format!("media_core_audio_regression_{name}"))
}

/// AAC の期待フレーム数(1024 サンプル/フレーム)を尺と実サンプルレートから見積もる
/// (エンコーダ内部の遅延分の端数があるため、厳密一致ではなく許容幅で比較する)。
fn expected_aac_frames(duration_secs: f64, sample_rate: u32) -> f64 {
	(duration_secs * sample_rate as f64) / 1024.0
}

#[test]
#[ignore = "実 ffmpeg/ffprobe が PATH に必要。cargo test -p media-core --test audio_regression -- --ignored"]
fn stereo_48k_input_produces_stereo_aac_output_with_audio_track() {
	let input = scratch_path("stereo_in.mp4");
	let output = scratch_path("stereo_out.mp4");
	let _ = std::fs::remove_file(&output);

	// ステレオ AAC 48kHz(左右で異なる周波数にして、右チャンネルが取りこぼされる
	// 回帰を「音声ストリームの有無」だけでなく検知しやすくする)。
	generate_input(
		&input,
		&[
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=2",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=880:duration=2",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=640x360:d=2",
			"-filter_complex",
			"[0:a][1:a]amerge=inputs=2[a]",
			"-map",
			"[a]",
			"-map",
			"2:v",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-ar",
			"48000",
			"-ac",
			"2",
			"-shortest",
		],
	);

	let result = run_reframe(&input, &output, None);
	let _ = std::fs::remove_file(&input);
	let encoder_used = result.expect("reframe は成功すること(音声が原因で失敗してはいけない)");
	assert!(!encoder_used.is_empty());

	assert!(has_video_stream(&output), "映像ストリームは維持されること");
	let audio =
		ffprobe_audio_info(&output).expect("出力に音声ストリームが存在すること(回帰: 消えていた)");
	assert_eq!(
		audio.channel_layout, "stereo",
		"チャンネルレイアウトが保持されること"
	);
	assert_eq!(audio.sample_rate, 48_000);

	let expected = expected_aac_frames(2.0, 48_000);
	assert!(
		(audio.nb_frames as f64 - expected).abs() <= 2.0,
		"AAC フレーム数が期待値に近いこと(単にストリームが存在するだけでなく、実際に \
		 中身が入っていることを確認する): got={}, expected≈{:.1}",
		audio.nb_frames,
		expected
	);

	let _ = std::fs::remove_file(&output);
}

#[test]
#[ignore = "実 ffmpeg/ffprobe が PATH に必要。cargo test -p media-core --test audio_regression -- --ignored"]
fn mono_48k_input_still_produces_mono_aac_output_with_audio_track() {
	// Wave 3 の実機検証で確認されていた対照群(モノラルは元々プレーンが 1 個しか
	// 無く回帰対象のバグを踏まないため、修正がこちらを壊していないことも確認する)。
	let input = scratch_path("mono_in.mp4");
	let output = scratch_path("mono_out.mp4");
	let _ = std::fs::remove_file(&output);

	generate_input(
		&input,
		&[
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=2",
			"-f",
			"lavfi",
			"-i",
			"color=c=green:s=640x360:d=2",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-ar",
			"48000",
			"-ac",
			"1",
			"-shortest",
		],
	);

	let result = run_reframe(&input, &output, None);
	let _ = std::fs::remove_file(&input);
	result.expect("reframe は成功すること");

	let audio = ffprobe_audio_info(&output).expect("出力に音声ストリームが存在すること");
	assert_eq!(audio.channel_layout, "mono");
	assert_eq!(audio.sample_rate, 48_000);

	let expected = expected_aac_frames(2.0, 48_000);
	assert!(
		(audio.nb_frames as f64 - expected).abs() <= 2.0,
		"got={}, expected≈{:.1}",
		audio.nb_frames,
		expected
	);

	let _ = std::fs::remove_file(&output);
}

#[test]
#[ignore = "実 ffmpeg/ffprobe が PATH に必要。cargo test -p media-core --test audio_regression -- --ignored"]
fn trimmed_stereo_input_produces_audio_track_covering_the_trim_window() {
	// trim ありでもステレオ音声が正しく出力されること(pipeline.rs の
	// `AudioPipeline::flush` が常に呼ばれる経路、trim による Skip/Stop 分類との
	// 組み合わせを確認する)。
	let input = scratch_path("stereo_trim_in.mp4");
	let output = scratch_path("stereo_trim_out.mp4");
	let _ = std::fs::remove_file(&output);

	generate_input(
		&input,
		&[
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=5",
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=640x360:d=5",
			"-filter_complex",
			"[0:a]pan=stereo|c0=c0|c1=c0[a]",
			"-map",
			"[a]",
			"-map",
			"1:v",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-ar",
			"44100",
			"-ac",
			"2",
			"-shortest",
		],
	);

	let trim = Trim {
		start: 1.0,
		end: 3.0,
	};
	let result = run_reframe(&input, &output, Some(trim));
	let _ = std::fs::remove_file(&input);
	result.expect("trim ありでも reframe は成功すること");

	let audio = ffprobe_audio_info(&output).expect("trim 後も音声ストリームが存在すること");
	assert_eq!(audio.channel_layout, "stereo");
	assert_eq!(audio.sample_rate, 44_100);

	// trim 区間は 2 秒(1.0s〜3.0s)。
	let expected = expected_aac_frames(2.0, 44_100);
	assert!(
		(audio.nb_frames as f64 - expected).abs() <= 3.0,
		"trim 後の AAC フレーム数が期待値(約 2 秒分)に近いこと: got={}, expected≈{:.1}",
		audio.nb_frames,
		expected
	);

	let _ = std::fs::remove_file(&output);
}

#[test]
#[ignore = "実 ffmpeg/ffprobe が PATH に必要。cargo test -p media-core --test audio_regression -- --ignored"]
fn trim_end_keeps_audio_and_video_durations_close_regardless_of_interleave_pressure() {
	// 回帰対象: pipeline.rs のパケットループが「映像側が trim の end に到達した瞬間、
	// 音声パイプラインがまだ自身の trim end に到達していなくてもパケットループ全体を
	// 打ち切る」実装になっていると、コンテナのインターリーブ順序次第で未処理の音声
	// パケットが失われ、trim 終端付近の音声/映像 duration がズレうる(修正前の
	// `break 'decode` 直呼び出し。pipeline.rs `run_pipeline` のパケットループ末尾の
	// コメント参照)。
	//
	// この入力は GOP を大きく(`-g 900`、実質 1 GOP)・B フレームを多く(`-bf 8`)して
	// デコード遅延を増やし、`-max_interleave_delta` を大きくしてマルチプレクサの
	// インターリーブ猶予を広げる — 実機検証で「映像の trim end 到達タイミング」を
	// できるだけ動かし、インターリーブ順序依存の影響が出やすい構成にしている。
	//
	// 期待値: 音声/映像の実尺(パケット数から逆算した実際の収録尺、mp4 の
	// track duration メタデータではなく `nb_frames` ベース)の差は、AAC の
	// フレーム粒度(1024 サンプル ≈ 21.3ms @48kHz)に起因する原理的な残差の範囲
	// (数フレーム分、`ALLOWED_DIFF_MS` 参照)に収まること。これを大きく超える
	// (実測では数百 ms 規模になりうる)場合は、インターリーブ順序依存の
	// パケット取りこぼしが再発したことを示す。
	let input = scratch_path("trim_interleave_pressure_in.mp4");
	let output = scratch_path("trim_interleave_pressure_out.mp4");
	let _ = std::fs::remove_file(&output);

	generate_input(
		&input,
		&[
			"-f",
			"lavfi",
			"-i",
			"testsrc2=duration=15:size=640x360:rate=30",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=15",
			"-c:v",
			"libx264",
			"-bf",
			"8",
			"-g",
			"900",
			"-refs",
			"4",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-ar",
			"48000",
			"-ac",
			"2",
			"-max_interleave_delta",
			"10000000",
			"-shortest",
		],
	);

	// 意図的にフレーム/サンプル境界に揃わない値にする(境界の丸め自体は別問題として
	// 許容するが、境界がどちらのグリッドにも揃わない「典型的な」trim 指定でも
	// インターリーブ順依存の破綻(数百 ms 規模のズレ)が起きないことを確認する)。
	let trim = Trim {
		start: 1.111,
		end: 8.888,
	};
	let result = run_reframe(&input, &output, Some(trim));
	let _ = std::fs::remove_file(&input);
	result.expect("trim ありでも reframe は成功すること");

	let audio = ffprobe_audio_info(&output).expect("trim 後も音声ストリームが存在すること");
	let video = ffprobe_video_info(&output).expect("trim 後も映像ストリームが存在すること");

	let video_content_secs = video.nb_frames as f64 / parse_frame_rate(&video.r_frame_rate);
	let audio_content_secs = (audio.nb_frames as f64 * 1024.0) / audio.sample_rate as f64;
	let diff_ms = (audio_content_secs - video_content_secs).abs() * 1000.0;

	// AAC 1 フレーム(1024 サンプル @48kHz ≈ 21.3ms)の数フレーム分までを原理的な
	// 残差として許容する(trim 境界が音声のフレーム境界に対して持つ最大位相ズレは
	// 前後合わせて 1 フレーム分、加えてエンコーダ側の末尾パディングで最大 1 フレーム
	// 分。実測では 20〜31ms 程度)。インターリーブ順依存で音声が丸ごと取りこぼされる
	// 不具合が再発した場合、この桁を大きく超える(数百 ms 規模)ズレになるため、
	// 十分な安全マージンを持った上でなお回帰を検知できる。
	const ALLOWED_DIFF_MS: f64 = 100.0;
	assert!(
		diff_ms <= ALLOWED_DIFF_MS,
		"trim 終端付近の音声/映像 duration の差が大きすぎる(インターリーブ順序依存の \
		 取りこぼしを疑う): video_content_secs={video_content_secs:.5} \
		 audio_content_secs={audio_content_secs:.5} diff_ms={diff_ms:.2} \
		 (nb_video_frames={}, nb_audio_frames={})",
		video.nb_frames,
		audio.nb_frames,
	);

	let _ = std::fs::remove_file(&output);
}
