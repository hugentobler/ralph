#!/usr/bin/env bash
# Tests for parsing Codex JSONL event streams in both Python and Bun parsers.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_PARSER=("python3" "-u" "$ROOT_DIR/src/ralph/lib/parse_jsonl.py")
BUN_PARSER=("bun" "run" "--silent" "$ROOT_DIR/src/ralph/lib/parse_jsonl.mjs")

run_parser_suite() {
  local label="$1"
  shift
  local -a parser_cmd=("$@")
  local failures=0

  run_one() {
    local name="$1"
    local expected_exit="$2"
    local expected_out="$3"
    shift 3

    local tmp_out
    tmp_out="$(mktemp)"
    local raw_log
    raw_log="$(mktemp)"

    set +e
    {
      for line in "$@"; do
        printf '%s\n' "$line"
      done
    } | RALPH_HEARTBEAT_SECS="9999" \
        RALPH_COMPLETION_PROMISE="<promise>DONE</promise>" \
        RALPH_COMPLETION_EXIT_CODE="10" \
        RALPH_RAW_LOG_PATH="$raw_log" \
        "${parser_cmd[@]}" >"$tmp_out" 2>/dev/null
    local status=$?
    set -e
    local out
    out="$(cat "$tmp_out")"

    rm -f "$raw_log" "$tmp_out"

    if [[ "$status" -ne "$expected_exit" ]]; then
      echo "[$label] $name: expected exit $expected_exit, got $status" >&2
      failures=$((failures + 1))
      return
    fi
    if [[ "$out" != "$expected_out" ]]; then
      echo "[$label] $name: expected output '$expected_out', got '$out'" >&2
      failures=$((failures + 1))
    fi
  }

  run_one "json_completion" 10 "hello" \
    '{"type":"item.completed","item":{"type":"agent_message","text":"hello <promise>DONE</promise>"}}'

  run_one "non_json_completion" 10 "noise" \
    'noise <promise>DONE</promise>'

  run_one "command_output_contains_promise" 0 "" \
    '{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"<promise>DONE</promise>"}}'

  run_one "completion_then_more" 10 "hello" \
    '{"type":"item.completed","item":{"type":"agent_message","text":"hello <promise>DONE</promise>"}}' \
    '{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"later"}}'

  if [[ "$failures" -ne 0 ]]; then
    exit 1
  fi
}

if command -v python3 >/dev/null 2>&1; then
  run_parser_suite "python" "${PY_PARSER[@]}"
else
  echo "python3 not found; skipping python parser tests" >&2
fi

if command -v bun >/dev/null 2>&1; then
  run_parser_suite "bun" "${BUN_PARSER[@]}"
else
  echo "bun not found; skipping bun parser tests" >&2
fi

echo "codex jsonl parser tests: ok"
