import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * dev:mock(`src/mock/core.ts`)のドリフト検知テスト。
 *
 * private エディションの UI(`PublishGateProvider`・投稿設定・YT/IG アップロード等)は
 * `vite --mode mock` で常にマウントされる(§vite.config.ts が `--mode mock` のとき
 * `edition` を強制的に "private" にするため)。そのため renderer が呼びうる invoke
 * コマンドは実装漏れなく `core.ts` のディスパッチャに対応している必要がある —
 * 新しい実コマンド(§src-tauri/src/commands/publish/*)を追加した際にモック対応を
 * 忘れると、dev:mock は起動直後、または該当 UI を開いた瞬間に
 * `[mock] invoke not implemented for command: ...` で例外になる(過去に
 * `get_scheduler_url`/`ig_job_status`/`youtube_oauth_*`/`youtube_publish_*` 等
 * 計9コマンドがこの状態だった)。
 *
 * 本テストは以下の単純な静的テキスト解析のみで判定する(仕様どおり "no build-time
 * magic" — TypeScript コンパイラ API やビルド成果物には依存しない):
 *   (a) renderer ソース(`src/mock/`・`src/test/`・`*.test.ts(x)` を除く `src/` 配下の
 *       すべての `.ts`/`.tsx`)から `invoke("cmd", ...)` / `invoke<T>("cmd", ...)`
 *       という文字列リテラル呼び出しを正規表現で総ざらいする。
 *   (b) `core.ts` の `invoke()` ディスパッチャが持つ `case "cmd":` ラベルの集合を
 *       同じく正規表現で抽出する。
 *   (a) の集合が (b) の集合(または下記 ALLOWLIST)に含まれることを確認する。
 *
 * 実装が意図的にまだ無いコマンドは ALLOWLIST に理由付きで追加する(現状は空 —
 * renderer が呼ぶ全コマンドを §mock/core.ts が実装済みのため)。
 */

const MOCK_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(MOCK_DIR, "..");
const CORE_TS_PATH = join(MOCK_DIR, "core.ts");

/** モック未実装でも許容するコマンド(理由必須)。 */
const ALLOWLIST: ReadonlyArray<{ command: string; reason: string }> = [];

// `invoke("cmd", ...)` / `invoke<T>("cmd", ...)`(`@tauri-apps/api/core` の invoke。
// 本リポジトリではエイリアスやラッパー無しに直接 import して使われる。§Explore 調査済み)。
const INVOKE_CALL_RE = /\binvoke(?:<[^()]*>)?\(\s*["']([A-Za-z0-9_]+)["']/g;
const CASE_LABEL_RE = /case\s+["']([A-Za-z0-9_]+)["']\s*:/g;

// dev:mock 自身(src/mock/**)と vitest 用モック・テストファイルは「renderer が呼ぶ
// コマンド」の集計対象から除く(いずれも実 invoke の呼び出し元ではない)。
const EXCLUDED_DIR_NAMES = new Set(["mock", "test"]);

/**
 * JSDoc/行コメント中の `invoke("...")` 風の記述(例:
 * `` `invoke("reframe_start", …)` を呼ぶ ``)を実呼び出しと誤集計しないよう、
 * 正規表現マッチ前にコメントを除去する。簡易実装のため文字列リテラル内の
 * `//`/`/* ` は考慮しないが、`:` の直後の `//`(`https://` 等)は URL とみなして
 * 除去対象から外す。本リポジトリの invoke 呼び出しコード自体にこのような
 * リテラルが同居する箇所は無いことを確認済み(§Explore 調査)。
 */
function stripComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			if (EXCLUDED_DIR_NAMES.has(entry)) continue;
			collectSourceFiles(full, out);
			continue;
		}
		if (!/\.(ts|tsx)$/.test(entry)) continue;
		if (/\.test\.(ts|tsx)$/.test(entry)) continue;
		if (entry.endsWith(".d.ts")) continue;
		out.push(full);
	}
	return out;
}

function extractInvokedCommands(): Set<string> {
	const commands = new Set<string>();
	for (const file of collectSourceFiles(SRC_ROOT)) {
		const text = stripComments(readFileSync(file, "utf8"));
		for (const match of text.matchAll(INVOKE_CALL_RE)) {
			if (match[1]) commands.add(match[1]);
		}
	}
	return commands;
}

const INVOKE_FN_START = "export async function invoke";

/**
 * `core.ts` の `export async function invoke` 本体だけを対象に case ラベルを拾う。
 * 本体の終端は次の(トップレベルの)`export` 宣言の直前とする — ファイル末尾まで
 * 素通しにすると、将来 `invoke()` より後ろに別の switch を持つ関数が追加された際、
 * その case を誤って「モック済み」と数えてしまい drift の見逃し(false negative)に
 * つながるため。
 */
function extractMockedCommands(): Set<string> {
	const text = readFileSync(CORE_TS_PATH, "utf8");
	const start = text.indexOf(INVOKE_FN_START);
	if (start === -1) {
		throw new Error(
			"core.ts に `export async function invoke` が見つかりません(ドリフト検知テストの前提が崩れています)。",
		);
	}
	const afterStart = start + INVOKE_FN_START.length;
	const nextExportOffset = text.slice(afterStart).search(/\n\s*export\s/);
	const end = nextExportOffset === -1 ? text.length : afterStart + nextExportOffset;

	const commands = new Set<string>();
	for (const match of text.slice(start, end).matchAll(CASE_LABEL_RE)) {
		if (match[1]) commands.add(match[1]);
	}
	return commands;
}

describe("mock/core.ts: invoke コマンドのドリフト検知", () => {
	it("renderer が呼ぶ invoke コマンドは全て core.ts に実装済み、または ALLOWLIST 記載である", () => {
		const invoked = extractInvokedCommands();
		const mocked = extractMockedCommands();
		const allowlisted = new Set(ALLOWLIST.map((entry) => entry.command));

		const missing = [...invoked]
			.filter((cmd) => !mocked.has(cmd) && !allowlisted.has(cmd))
			.sort();

		expect(
			missing,
			missing.length > 0
				? `未実装の invoke コマンドがあります: ${missing.join(", ")}\n` +
						"apps/desktop/src/mock/core.ts に実装を追加するか、意図的に未実装の" +
						"ままにする場合はこのファイルの ALLOWLIST に理由付きで追加してください。"
				: undefined,
		).toEqual([]);
	});

	it("regex 抽出そのものが壊れていない(false negative 検知の健全性チェック)", () => {
		// renderer 側の抽出ロジックが変化して 0 件/大幅減少になっていないかの簡易ガード
		// (現状の実呼び出し数は 25 件)。閾値は将来のリファクタで多少コマンドが増減しても
		// 壊れない程度に余裕を持たせる。
		const invoked = extractInvokedCommands();
		expect(invoked.size).toBeGreaterThanOrEqual(15);
		expect(invoked.has("probe")).toBe(true);
		expect(invoked.has("check_scheduler_connection")).toBe(true);
		expect(invoked.has("youtube_publish_start")).toBe(true);

		const mocked = extractMockedCommands();
		expect(mocked.size).toBeGreaterThanOrEqual(15);
		expect(mocked.has("probe")).toBe(true);
	});

	it("ALLOWLIST の各エントリには理由(reason)が書かれている", () => {
		for (const entry of ALLOWLIST) {
			expect(
				entry.reason.trim().length,
				`${entry.command} の reason が空です`,
			).toBeGreaterThan(0);
		}
	});
});
