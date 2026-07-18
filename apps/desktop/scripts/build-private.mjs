#!/usr/bin/env node
// private ビルドの唯一の入口(Issue #96)。
//
// private ビルドは JS 側(vite の `--mode private`。tauri.*-private.conf.json の
// beforeBuildCommand 経由、§edition.build.ts)と Rust 側(cargo の
// `--features publish`、§src-tauri/Cargo.toml)の2つのスイッチが揃って初めて
// 成立する。これまで package.json の `build:mac-private` / `build:win-private`
// スクリプトにそれぞれ手書きしており、片方だけ更新して不整合になる余地があった。
// このスクリプトを唯一の入口にし、両スイッチを常にペアで発行する。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// tauri.*-private.conf.json 自体は beforeBuildCommand に `--mode private` を
// 埋め込み済み(§src-tauri/tauri.mac-private.conf.json 等)なので、ここで直接
// 発行するスイッチは cargo 側の `--features publish` のみ。config の選択(=どの
// private conf を使うか)と `--features publish` をこの1箇所でペアにすることが
// 目的なので、config パスもここに集約する。
const PLATFORM_CONFIGS = {
	mac: "src-tauri/tauri.mac-private.conf.json",
	win: "src-tauri/tauri.win-private.conf.json",
};

const platform = process.argv[2];
const config = PLATFORM_CONFIGS[platform];

if (!config) {
	console.error(
		`使い方: node scripts/build-private.mjs <${Object.keys(PLATFORM_CONFIGS).join("|")}> [tauri build への追加引数...]`,
	);
	process.exit(1);
}

// 追加引数(例: --target ...)はそのまま tauri build に転送する。
const extraArgs = process.argv.slice(3);

// apps/desktop/scripts/ からの相対で apps/desktop/ を cwd にする。`URL.pathname` は
// Windows で先頭に余分な `/`(例: `/C:/...`)が付き spawnSync の cwd として不正になる
// ほか、空白/非 ASCII を含むパスでパーセントエンコードされて壊れるため、
// `fileURLToPath` で OS ネイティブのパスに変換する(§edition.build.ts と同じ流儀)。
const desktopDir = fileURLToPath(new URL("..", import.meta.url));

const result = spawnSync(
	"pnpm",
	[
		"exec",
		"tauri",
		"build",
		"--config",
		config,
		"--features",
		"publish",
		...extraArgs,
	],
	{
		stdio: "inherit",
		cwd: desktopDir,
		// Windows の pnpm は `pnpm.cmd`(corepack 経由も含む)であることが多く、
		// Node 18.20.2/20.12.2/22 以降のセキュリティ修正により shell 無しで
		// `.cmd`/`.bat` を spawn すると EINVAL になる
		// (https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)。
		// mac/Linux は直接 spawn で問題ないため Windows のみ shell 経由にする。
		shell: process.platform === "win32",
	},
);

if (result.error) {
	console.error(result.error);
	process.exit(1);
}

process.exit(result.status ?? 1);
