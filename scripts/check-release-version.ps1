<#
.SYNOPSIS
    リリース用 git タグ(vX.Y.Z[-rc.N] 形式)と、リポジトリ内のバージョン単一ソース
    (apps/desktop/src-tauri/tauri.conf.json の version)が一致しているかを検査する。

.DESCRIPTION
    Phase 4 Wave D(.github/workflows/release.yml)で使用する。バージョンの単一
    ソースは tauri.conf.json とし、apps/desktop/package.json および
    apps/desktop/Cargo.toml([workspace.package] version)は bump 時に同時更新する
    運用としている(docs/phase4-packaging.md 参照)。本スクリプトは以下の 4 箇所が
    すべて一致することを確認する:

    1. git タグ(先頭の "v" を除いた文字列)
    2. apps/desktop/src-tauri/tauri.conf.json の .version
    3. apps/desktop/package.json の .version
    4. apps/desktop/Cargo.toml の [workspace.package] version

    1つでも不一致なら非ゼロ終了する。

.PARAMETER Tag
    検査対象の git タグ(例: "v0.1.0"、"v0.1.0-rc.1")。"v" プレフィックス必須。

.PARAMETER RepoRoot
    リポジトリルート(既定: このスクリプトの1つ上のディレクトリ)。

.EXAMPLE
    # 正常系(すべて 0.0.0 の現状で v0.0.0 タグを検査 → 一致)
    ./scripts/check-release-version.ps1 -Tag "v0.0.0"

.EXAMPLE
    # 異常系(タグとバージョンが不一致 → exit 1)
    ./scripts/check-release-version.ps1 -Tag "v9.9.9"
#>
[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[string]$Tag,

	[string]$RepoRoot
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
	$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
}

function Write-Log([string]$Message) {
	Write-Host "[check-release-version] $Message"
}

# --- 1. タグ形式の検証 + "v" プレフィックス除去 ---
if ($Tag -notmatch '^v(?<ver>\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?)$') {
	Write-Error "タグの形式が不正: '$Tag'(期待: vX.Y.Z または vX.Y.Z-rc.N のような prerelease サフィックス)"
	exit 1
}
$tagVersion = $Matches['ver']

# --- 2. tauri.conf.json(単一ソース) ---
$tauriConfPath = Join-Path $RepoRoot "apps\desktop\src-tauri\tauri.conf.json"
if (-not (Test-Path $tauriConfPath)) {
	Write-Error "tauri.conf.json が見つからない: $tauriConfPath"
	exit 1
}
$tauriConf = Get-Content -Raw -LiteralPath $tauriConfPath | ConvertFrom-Json
$tauriVersion = $tauriConf.version

# --- 3. apps/desktop/package.json ---
$pkgPath = Join-Path $RepoRoot "apps\desktop\package.json"
if (-not (Test-Path $pkgPath)) {
	Write-Error "package.json が見つからない: $pkgPath"
	exit 1
}
$pkg = Get-Content -Raw -LiteralPath $pkgPath | ConvertFrom-Json
$pkgVersion = $pkg.version

# --- 4. apps/desktop/Cargo.toml [workspace.package] version ---
$cargoTomlPath = Join-Path $RepoRoot "apps\desktop\Cargo.toml"
if (-not (Test-Path $cargoTomlPath)) {
	Write-Error "Cargo.toml が見つからない: $cargoTomlPath"
	exit 1
}
$cargoToml = Get-Content -LiteralPath $cargoTomlPath
$inWorkspacePackage = $false
$cargoVersion = $null
foreach ($line in $cargoToml) {
	if ($line -match '^\s*\[workspace\.package\]\s*$') {
		$inWorkspacePackage = $true
		continue
	}
	if ($inWorkspacePackage -and $line -match '^\s*\[') {
		# 次のセクションに入ったら打ち切り
		break
	}
	if ($inWorkspacePackage -and $line -match '^\s*version\s*=\s*"(?<v>[^"]+)"\s*$') {
		$cargoVersion = $Matches['v']
		break
	}
}
if (-not $cargoVersion) {
	Write-Error "Cargo.toml の [workspace.package] version が見つからない: $cargoTomlPath"
	exit 1
}

# --- 突き合わせ ---
Write-Log "タグ由来のバージョン       : $tagVersion"
Write-Log "tauri.conf.json (単一ソース): $tauriVersion"
Write-Log "apps/desktop/package.json  : $pkgVersion"
Write-Log "apps/desktop/Cargo.toml    : $cargoVersion"

$mismatches = @()
if ($tagVersion -ne $tauriVersion) {
	$mismatches += "タグ($tagVersion) != tauri.conf.json($tauriVersion)"
}
if ($tauriVersion -ne $pkgVersion) {
	$mismatches += "tauri.conf.json($tauriVersion) != package.json($pkgVersion)"
}
if ($tauriVersion -ne $cargoVersion) {
	$mismatches += "tauri.conf.json($tauriVersion) != Cargo.toml($cargoVersion)"
}

if ($mismatches.Count -gt 0) {
	Write-Error (
		"バージョン不一致を検出:`n" +
		($mismatches -join "`n") +
		"`n(バージョン単一ソースは tauri.conf.json。bump 時は package.json / Cargo.toml も同時更新すること)"
	)
	exit 1
}

Write-Log "OK: タグとバージョン単一ソース(tauri.conf.json)・package.json・Cargo.toml が一致"
exit 0
