#!/usr/bin/env bash
# PostToolUse フック: Write/Edit 直後の高速チェック(project-setup スキルが生成)
# 入力契約: stdin に JSON(.tool_name, .tool_input.file_path など)
# 出力契約: 問題なし・対象外・チェック環境不備 → 何も出力せず exit 0
#           チェック失敗 → exit 0 のまま hookSpecificOutput.additionalContext で
#           エラー内容を Claude に返す(自己修正を促す。ブロックはしない)
# 注意: ここに入れてよいのはファイル単位・数秒以内のチェックのみ。
#       プロジェクト全体の typecheck / test は CLAUDE.md の
#       「コミット前に実行」に書くこと(このリポジトリでは pnpm -r typecheck)
#
# グローバルフック(~/.claude/hooks/post-edit-check.sh)は .js/.mjs/.cjs/.json/
# .sh/.py/.rb の構文チェックを担うが .ts/.tsx/.rs は検査しない。ここでは
# TS/JS を Biome lint、.rs を rustfmt --check(構文エラーも検出)で検査する。
# clippy はクレート全体コンパイルで per-file にできないためフック対象外
# (CLAUDE.md のコミット前チェック側に記載)。
set -euo pipefail

input="$(cat)"

# jq がなければ保守的にスキップ
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"

if [ -z "$file" ] || [ ! -f "$file" ]; then
  exit 0
fi

check_output=""
status=0
checker=""

case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
    # ローカルの Biome を解決(グローバル PATH には無い)。
    # CLAUDE_PROJECT_DIR 優先、無ければ編集ファイルから git ルートを辿る。
    project_dir="${CLAUDE_PROJECT_DIR:-}"
    if [ -z "$project_dir" ]; then
      project_dir="$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null || true)"
    fi
    biome_bin="$project_dir/node_modules/.bin/biome"
    # Biome 未導入なら安全に no-op(実効性もゼロになる点に注意)
    [ -n "$project_dir" ] && [ -x "$biome_bin" ] || exit 0
    # lint のみ(整形差分は出さない)。Biome は biome.json を上位ディレクトリへ
    # 自動探索するため cwd に依存しない。警告は exit 0、エラーのみ非ゼロ。
    checker="Biome lint"
    check_output="$("$biome_bin" lint "$file" 2>&1)" || status=$?
    ;;
  *.rs)
    # rustfmt を解決する。Claude Code のフックは非ログインシェルで動くため
    # ~/.cargo/bin が PATH に無いことがある(このマシンで実測)。フォールバックで拾う
    rustfmt_bin="$(command -v rustfmt 2>/dev/null || true)"
    if [ -z "$rustfmt_bin" ] && [ -x "$HOME/.cargo/bin/rustfmt" ]; then
      rustfmt_bin="$HOME/.cargo/bin/rustfmt"
    fi
    [ -n "$rustfmt_bin" ] || exit 0
    # rustfmt 単体は Cargo.toml の edition を読まないため明示する
    # (apps/desktop/Cargo.toml の workspace edition = "2021" に合わせる。
    # edition を上げたらここも更新)。rustfmt.toml(hard_tabs 等)は
    # ファイルのディレクトリから上方探索されるよう cwd を合わせて実行する
    checker="rustfmt --check"
    # 注意: rustfmt は mod 宣言を辿って子モジュール(別ファイル)も検査するため、
    # 編集ファイル以外の未整形が報告されることがある(--skip-children は
    # nightly 限定のため使えない — stable では "Unrecognized option" になる)
    check_output="$( (cd "$(dirname "$file")" && "$rustfmt_bin" --check --edition 2021 "$file") 2>&1)" || status=$?
    ;;
  *)
    # 対象外の拡張子はスキップ
    exit 0
    ;;
esac

if [ "$status" -ne 0 ]; then
  # インタープリタ/実行体自体の不備(shim エラー等)はコードの問題ではないためスキップ
  if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then
    exit 0
  fi
  case "$check_output" in
    *"command not found"*|*"is not installed"*) exit 0 ;;
  esac

  # エラー内容を Claude に渡す。truncate は ${var:0:N}(文字単位)で行う。
  # パイプ + head だと SIGPIPE × set -euo pipefail でフックごと死ぬため使わない
  ctx="post-edit-check: ${file} の ${checker} に失敗しました。以下のエラーを確認して修正してください。
${check_output:0:2000}"
  jq -n --arg ctx "$ctx" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
fi

exit 0
