<#
.SYNOPSIS
    BtbN/FFmpeg-Builds の日付固定タグから win64-lgpl-shared ビルドを取得し、
    apps/desktop/src-tauri/ffmpeg-dist/ に DLL のみをフラットにステージングする。

.DESCRIPTION
    リリース(配布用 / LGPL)ビルド専用のスクリプト。開発時は GPL shared ビルドを
    使う(docs/phase2-0-windows-setup.md)が、配布物には LGPL 版の共有ライブラリのみを
    同梱する(THIRD_PARTY_NOTICES.md / docs/phase4-packaging.md 参照)。

    タグは BtbN の日付固定タグ(autobuild-YYYY-MM-DD-HH-MM)に pin しており、
    "latest" エイリアスは使わない(再現性・監査可能性のため)。新しいタグへ更新する
    場合は本スクリプト冒頭の $Tag / $AssetName を書き換え、
    THIRD_PARTY_NOTICES.md の記載も同時に更新すること。

    ffmpeg.exe / ffprobe.exe は同梱しない(LGPL 配布の対象は共有ライブラリのみ。
    実行ファイルは GPL 部分を含みうるため意図的に除外する)。DLL 名はハードコード
    せず、展開後の bin/*.dll を機械的に列挙してコピーする。

.PARAMETER OutDir
    DLL のステージング先(既定: apps/desktop/src-tauri/ffmpeg-dist)。
    Tauri の bundle resources がここから exe 隣接へコピーする
    (tauri.win-release.conf.json)。

.PARAMETER ExtractRoot
    zip の展開先(既定: リポジトリ直下 .cache/ffmpeg-lgpl、Git 管理外)。
    展開後のルートディレクトリパスを標準出力の最終行として返す。
    cargo ビルド時の FFMPEG_DIR にはこのパスを指定する
    (lib/ に import library、include/ にヘッダが揃っている)。

.PARAMETER Force
    既存の展開キャッシュ・ステージング先があっても再取得・再ステージングする。

.OUTPUTS
    展開済み LGPL ビルドのルートディレクトリの絶対パス(文字列 1 行)。
    呼び出し側はこれを FFMPEG_DIR に設定できる。
    例: $lgplRoot = ./scripts/fetch-ffmpeg-lgpl.ps1
        $env:FFMPEG_DIR = $lgplRoot
#>

[CmdletBinding()]
param(
	[string]$OutDir,
	[string]$ExtractRoot,
	[switch]$Force
)

$ErrorActionPreference = "Stop"

# --- 日付固定タグ(pin)。BtbN/FFmpeg-Builds の GitHub Releases API で実在を確認済み。 ---
# 更新時は `gh api repos/BtbN/FFmpeg-Builds/releases --jq '.[].tag_name'` で最新の
# autobuild-YYYY-MM-DD-HH-MM を確認し、対象タグの assets からファイル名を確認すること。
$Tag = "autobuild-2026-07-11-13-13"
$AssetName = "ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1.zip"
$DownloadUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$Tag/$AssetName"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

if (-not $OutDir) {
	$OutDir = Join-Path $RepoRoot "apps\desktop\src-tauri\ffmpeg-dist"
}
if (-not $ExtractRoot) {
	$ExtractRoot = Join-Path $RepoRoot ".cache\ffmpeg-lgpl"
}

$assetBaseName = [System.IO.Path]::GetFileNameWithoutExtension($AssetName)
$lgplRoot = Join-Path $ExtractRoot $assetBaseName

function Write-Log([string]$Message) {
	Write-Host "[fetch-ffmpeg-lgpl] $Message"
}

if ((Test-Path $lgplRoot) -and -not $Force) {
	Write-Log "既に展開済み: $lgplRoot (再取得する場合は -Force)"
}
else {
	if (Test-Path $ExtractRoot) {
		if ($Force) {
			Remove-Item -Recurse -Force $ExtractRoot
		}
	}
	New-Item -ItemType Directory -Force -Path $ExtractRoot | Out-Null

	$tmpDir = Join-Path $ExtractRoot "_tmp"
	if (Test-Path $tmpDir) {
		Remove-Item -Recurse -Force $tmpDir
	}
	New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

	$zipPath = Join-Path $tmpDir $AssetName
	Write-Log "取得中(pin: $Tag): $DownloadUrl"
	Invoke-WebRequest -Uri $DownloadUrl -OutFile $zipPath

	Write-Log "展開中: $zipPath -> $ExtractRoot"
	Expand-Archive -Path $zipPath -DestinationPath $ExtractRoot -Force

	Remove-Item -Recurse -Force $tmpDir

	if (-not (Test-Path $lgplRoot)) {
		throw "展開後に期待するルートディレクトリが見つからない: $lgplRoot (zip の内部構成が変わった可能性。BtbN のアセット構成を確認すること)"
	}
}

$binDir = Join-Path $lgplRoot "bin"
if (-not (Test-Path $binDir)) {
	throw "bin ディレクトリが見つからない: $binDir"
}

$dlls = Get-ChildItem -Path $binDir -Filter "*.dll" -File
if ($dlls.Count -eq 0) {
	throw "bin ディレクトリに DLL が見つからない: $binDir"
}

if ((Test-Path $OutDir) -and $Force) {
	Get-ChildItem -Path $OutDir -Filter "*.dll" -File | Remove-Item -Force
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Log "DLL を $($dlls.Count) 件ステージング: $OutDir"
foreach ($dll in $dlls) {
	Copy-Item -Path $dll.FullName -Destination $OutDir -Force
	Write-Log "  - $($dll.Name)"
}

# ffmpeg.exe / ffprobe.exe が誤って混入していないことを確認(DLL のみ同梱の保証)。
$exeLeak = Get-ChildItem -Path $OutDir -Filter "*.exe" -File -ErrorAction SilentlyContinue
if ($exeLeak) {
	throw "ffmpeg-dist に実行ファイルが混入している(LGPL 配布は DLL のみの想定): $($exeLeak.Name -join ', ')"
}

Write-Log "完了。FFMPEG_DIR には次のパスを指定すること: $lgplRoot"

# 呼び出し側が `$lgplRoot = ./scripts/fetch-ffmpeg-lgpl.ps1` で受け取れるよう、
# 最終出力として展開ルートの絶対パスのみを返す(ログは Write-Host 経由なので
# 標準出力ストリームには混ざらない)。
$lgplRoot
