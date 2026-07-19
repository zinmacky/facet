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
# あわせて $ExpectedSha256 も取得したファイルの `shasum -a 256`(または
# `Get-FileHash -Algorithm SHA256`)で計算し直して更新すること(改ざん・差し替え
# 検出のため。取得先は BtbN のリリースアセットで署名は提供されていないため、
# ハッシュ固定が唯一の完全性検証手段)。
$Tag = "autobuild-2026-07-11-13-13"
$AssetName = "ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1.zip"
$DownloadUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$Tag/$AssetName"
$ExpectedSha256 = "11514A894225FA65076FF1DE7BCB926CF6AD1CB12B0B3864955CF91E0AC11352"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

if (-not $OutDir) {
	$OutDir = Join-Path $RepoRoot "apps\desktop\src-tauri\ffmpeg-dist"
}
if (-not $ExtractRoot) {
	$ExtractRoot = Join-Path $RepoRoot ".cache\ffmpeg-lgpl"
}

$assetBaseName = [System.IO.Path]::GetFileNameWithoutExtension($AssetName)
$lgplRoot = Join-Path $ExtractRoot $assetBaseName
# キャッシュ再利用時の完全性再検証用に、検証済み zip を _tmp の外($ExtractRoot 直下)
# に残しておく。展開済みディレクトリの実在だけを見て再取得をスキップすると、
# キャッシュが破損・改ざん(ファイル差し替えや不要ファイル混入)されていても
# 検出できずそのまま使ってしまうため。
$cachedZipPath = Join-Path $ExtractRoot $AssetName

function Write-Log([string]$Message) {
	Write-Host "[fetch-ffmpeg-lgpl] $Message"
}

# キャッシュ再利用は「展開済みディレクトリがあり」かつ「保存済み zip の SHA-256 が
# 期待値と一致する」場合のみ許可する(fail closed)。展開済みディレクトリだけが
# あって zip が無い(旧バージョンのキャッシュ等)場合や、zip はあってもハッシュが
# 不一致の場合は、無検証で使い回さず再取得する。
$cacheIsValid = $false
if ((Test-Path $lgplRoot) -and -not $Force) {
	if (Test-Path $cachedZipPath) {
		$cachedSha256 = (Get-FileHash -Path $cachedZipPath -Algorithm SHA256).Hash
		if ($cachedSha256.ToUpperInvariant() -eq $ExpectedSha256.ToUpperInvariant()) {
			$cacheIsValid = $true
		}
		else {
			Write-Log "警告: キャッシュ済み zip の SHA-256 が期待値と不一致のため再取得します: $cachedZipPath"
		}
	}
	else {
		Write-Log "警告: 展開済みキャッシュはあるが検証用 zip が無いため再取得します: $lgplRoot"
	}
}

if ($cacheIsValid) {
	Write-Log "既に展開済み・検証済み: $lgplRoot (再取得する場合は -Force)"
}
else {
	# $Force 指定時に加え、キャッシュが無検証(zip 欠落・ハッシュ不一致)と判定された
	# 場合も、展開済みディレクトリに改ざん時の混入ファイルが残り得るため既存の
	# $ExtractRoot を丸ごと削除してから作り直す(Expand-Archive -Force による
	# 上書きだけでは zip に無い余分なファイルは削除されない)。
	if (Test-Path $ExtractRoot) {
		Remove-Item -Recurse -Force $ExtractRoot
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

	# 改ざん・差し替え検出: 展開前に SHA-256 を検証する(大文字小文字を無視した比較)。
	# 一致しない場合は即 throw し、展開ステップに進ませない。
	Write-Log "SHA-256 を検証中: $zipPath"
	$actualSha256 = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash
	if ($actualSha256.ToUpperInvariant() -ne $ExpectedSha256.ToUpperInvariant()) {
		throw "SHA-256 が一致しません(改ざん・アセット差し替えの可能性): 期待値 $ExpectedSha256, 実際 $actualSha256 ($zipPath)"
	}
	Write-Log "SHA-256 検証 OK: $actualSha256"

	Write-Log "展開中: $zipPath -> $ExtractRoot"
	Expand-Archive -Path $zipPath -DestinationPath $ExtractRoot -Force

	# 検証済み zip を _tmp の外($cachedZipPath)にコピーしてから _tmp を削除する。
	# 次回実行時のキャッシュ再利用判定(上記)はこの zip のハッシュを再検証して行う。
	Copy-Item -Path $zipPath -Destination $cachedZipPath -Force

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
