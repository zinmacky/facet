<#
.SYNOPSIS
    配布用 FFmpeg(LGPL 構成)のライセンス適合ゲート(apps/desktop/crates/license-gate)を実行する。

.DESCRIPTION
    license-gate は「PATH 上で解決される FFmpeg 共有ライブラリ(DLL)」を実行時に
    検査するバイナリ。開発機には検証用の GPL shared FFmpeg(FFMPEG_DIR 経由。
    apps/desktop/CLAUDE.md 参照)が別途 PATH に載っていることが多く、そのままでは
    どちらの FFmpeg が検査対象になるか不定になってしまう。

    そのためこのスクリプトは次の2段階で実行する:
    1. license-gate バイナリ自体のビルド(`cargo build -p license-gate`)は通常の
       開発環境(既存の FFMPEG_DIR / LIBCLANG_PATH / PATH)で行う。license-gate の
       ビルド時リンク先(FFMPEG_DIR)は検査対象と無関係(検査は実行時に
       avutil_license() 等の戻り値を見るだけなので、開発用の GPL 構成でビルドして
       問題ない。Cargo.toml のコメント参照)。
    2. ビルド済みの exe を「検査対象ディレクトリのみ + Windows システムパス最小限」
       に絞った PATH で直接実行する。こうすることで、システムに別の FFmpeg が
       PATH 上にあっても検査対象に混入しない。

.PARAMETER FfmpegDistPath
    検査対象の FFmpeg DLL(avutil-*.dll 等)が配置されているディレクトリ。
    省略時は apps/desktop/src-tauri/ffmpeg-dist
    (scripts/fetch-ffmpeg-lgpl.ps1 のステージング先、Phase 4 Wave A)。

.PARAMETER Configuration
    ビルド構成。既定は Debug(検査ロジック自体の実行速度は問題にならないため、
    ビルド時間が短い Debug を既定にしている)。Release を指定すると
    `cargo build -p license-gate --release` を使う。

.EXAMPLE
    # Wave A のステージング先(既定)を検査する
    ./scripts/run-license-gate.ps1

.EXAMPLE
    # 任意の FFmpeg bin ディレクトリを指定して検査する(ネガティブテスト等)
    ./scripts/run-license-gate.ps1 -FfmpegDistPath "C:\ffmpeg\ffmpeg-n8.1-latest-win64-gpl-shared-8.1\bin"
#>
[CmdletBinding()]
param(
	[string]$FfmpegDistPath = (Join-Path $PSScriptRoot "..\apps\desktop\src-tauri\ffmpeg-dist"),
	[ValidateSet("Debug", "Release")]
	[string]$Configuration = "Debug"
)

$ErrorActionPreference = "Stop"

$resolvedDist = Resolve-Path -LiteralPath $FfmpegDistPath -ErrorAction SilentlyContinue
if (-not $resolvedDist) {
	Write-Error (
		"指定された FFmpeg ステージングディレクトリが見つかりません: $FfmpegDistPath`n" +
		"(Wave A の scripts/fetch-ffmpeg-lgpl.ps1 でステージングするか、" +
		"-FfmpegDistPath で既存の FFmpeg DLL の入った bin ディレクトリを指定してください)"
	)
	exit 1
}
$distPath = $resolvedDist.Path

$dlls = Get-ChildItem -LiteralPath $distPath -Filter "*.dll" -File -ErrorAction SilentlyContinue
if (-not $dlls -or $dlls.Count -eq 0) {
	Write-Error "指定ディレクトリに DLL が見つかりません: $distPath"
	exit 1
}

Write-Host "license-gate: 検査対象ディレクトリ = $distPath"
Write-Host "license-gate: 検出した DLL = $($dlls.Name -join ', ')"

$desktopRoot = Resolve-Path (Join-Path $PSScriptRoot "..\apps\desktop")

Write-Host "license-gate: ビルド中(cargo build -p license-gate$(if ($Configuration -eq 'Release') { ' --release' }))..."
Push-Location $desktopRoot
try {
	if ($Configuration -eq "Release") {
		cargo build -p license-gate --release
	}
	else {
		cargo build -p license-gate
	}
	if ($LASTEXITCODE -ne 0) {
		Write-Error "license-gate のビルドに失敗しました(exit code $LASTEXITCODE)"
		exit $LASTEXITCODE
	}
}
finally {
	Pop-Location
}

$exeName = "license-gate.exe"
$exePath = if ($Configuration -eq "Release") {
	Join-Path $desktopRoot "target\release\$exeName"
}
else {
	Join-Path $desktopRoot "target\debug\$exeName"
}
if (-not (Test-Path -LiteralPath $exePath)) {
	Write-Error "ビルド後も exe が見つかりません: $exePath"
	exit 1
}

# PATH を「検査対象ディレクトリ + Windows システムパスの最小限」に絞る。
# システムパスを残すのは exe 自体が依存する Windows API DLL(kernel32 等)の
# 解決のため。開発用に別途 PATH へ追加してある FFmpeg(GPL shared 等)を
# 検査対象から確実に除外するのが目的。
$systemRoot = $env:SystemRoot
$minimalSystemPaths = @(
	(Join-Path $systemRoot "System32"),
	$systemRoot,
	(Join-Path $systemRoot "System32\Wbem"),
	(Join-Path $systemRoot "System32\WindowsPowerShell\v1.0")
) -join ";"

$originalPath = $env:PATH
try {
	$env:PATH = "$distPath;$minimalSystemPaths"
	Write-Host "license-gate: PATH を検査対象ディレクトリに限定して実行します"
	Write-Host ""

	& $exePath
	$exitCode = $LASTEXITCODE
}
finally {
	$env:PATH = $originalPath
}

exit $exitCode
