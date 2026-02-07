#!/usr/bin/env bash
# Tests for parsing Claude JSONL event streams in both Python and Bun parsers.
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
        RALPH_PROVIDER="claude" \
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

  # Basic Claude assistant message with completion promise
  run_one "json_completion" 10 "hello" \
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hello <promise>DONE</promise>"}]}}'

  # Non-JSON fallback still works
  run_one "non_json_completion" 10 "noise" \
    'noise <promise>DONE</promise>'

  # System messages should not trigger completion
  run_one "system_message_with_promise" 0 "" \
    '{"type":"system","session_id":"abc123","message":{"content":[{"type":"text","text":"<promise>DONE</promise>"}]}}'

  # User messages should not trigger completion
  run_one "user_message_with_promise" 0 "" \
    '{"type":"user","message":{"content":[{"type":"text","text":"<promise>DONE</promise>"}]}}'

  # Multiple assistant messages - should use the LAST one with the promise
  run_one "multiple_messages_last_wins" 10 "final message" \
    '{"type":"assistant","message":{"content":[{"type":"text","text":"first <promise>DONE</promise>"}]}}' \
    '{"type":"assistant","message":{"content":[{"type":"text","text":"final message <promise>DONE</promise>"}]}}'

  # Assistant message with multiple content blocks
  run_one "multiple_content_blocks" 10 "hello
world" \
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"text","text":"world <promise>DONE</promise>"}]}}'

  # Tool use blocks should be ignored (only text blocks matter)
  run_one "mixed_content_with_tool_use" 10 "done" \
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"123","name":"test"},{"type":"text","text":"done <promise>DONE</promise>"}]}}'

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

echo "claude jsonl parser tests: ok"
