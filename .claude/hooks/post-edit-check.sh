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
# .sh/.py/.rb の構文チェックを担うが .ts/.tsx は検査しない。ここでは Biome lint で
# TS/JS を lint する(構文エラー + lint エラーを含む上位検査)。
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
    check_output="$("$biome_bin" lint "$file" 2>&1)" || status=$?
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
  ctx="post-edit-check: ${file} の Biome lint に失敗しました。以下のエラーを確認して修正してください。
${check_output:0:2000}"
  jq -n --arg ctx "$ctx" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
fi

exit 0
