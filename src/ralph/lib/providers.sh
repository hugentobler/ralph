#!/usr/bin/env bash
# Provider abstraction layer for ralph
# Supports: codex, claude
# Compatible with bash 3.2+ (no associative arrays)

# Claude disallowed tools (blacklist approach)
# Always block curl/wget via Bash
CLAUDE_DISALLOWED_BASH='"Bash(curl *)" "Bash(wget *)"'
# Block web tools by default (removed when --web is used)
CLAUDE_DISALLOWED_WEB='"WebFetch" "WebSearch"'

detect_provider() {
  # Auto-detect: prefer codex if available, fall back to claude
  if command -v codex >/dev/null 2>&1; then
    echo "codex"
  elif command -v claude >/dev/null 2>&1; then
    echo "claude"
  fi
}

validate_provider() {
  local provider="$1"
  case "$provider" in
    codex)
      command -v codex >/dev/null 2>&1 || { echo "Error: codex CLI not found" >&2; return 1; }
      ;;
    claude)
      command -v claude >/dev/null 2>&1 || { echo "Error: claude CLI not found" >&2; return 1; }
      ;;
    *)
      echo "Error: Unknown provider '$provider'. Supported: codex, claude" >&2
      return 1
      ;;
  esac
}

get_cli_command() {
  echo "$1"  # provider name = cli command
}

# Build execution args
# Usage: build_exec_args <provider> <web_enabled: 0|1>
build_exec_args() {
  local provider="$1"
  local web_enabled="${2:-0}"
  case "$provider" in
    codex)
      if [[ "$web_enabled" == "1" ]]; then
        echo "exec --full-auto --json --skip-git-repo-check --config history.persistence=none"
      else
        echo "exec --full-auto --json --skip-git-repo-check --config history.persistence=none --config web_search=disabled"
      fi
      ;;
    claude)
      local disallowed="$CLAUDE_DISALLOWED_BASH"
      if [[ "$web_enabled" != "1" ]]; then
        disallowed="$disallowed $CLAUDE_DISALLOWED_WEB"
      fi
      echo "--verbose --dangerously-skip-permissions --no-session-persistence --output-format stream-json --disallowedTools $disallowed -p"
      ;;
  esac
}

# Build summary args (for heartbeat, uses cheap/fast model)
build_summary_args() {
  case "$1" in
    codex)
      echo "exec --full-auto --skip-git-repo-check --config history.persistence=none --config model_reasoning_effort=low --config web_search=disabled"
      ;;
    claude)
      # Use haiku for fast/cheap summaries, no tools needed
      echo "--model haiku --no-session-persistence --output-format text --tools \"\" -p"
      ;;
  esac
}