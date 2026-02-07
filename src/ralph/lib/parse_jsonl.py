#!/usr/bin/env python3
"""
JSONL parser for ralph - supports both Codex and Claude streaming formats.

Provider detection:
- RALPH_PROVIDER env var: "codex" or "claude"
- Auto-detect from stream format if not specified

Codex format:
  {"type": "item.completed", "item": {"type": "assistant_message", "text": "..."}}

Claude format:
  {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}], "stop_reason": "end_turn"}}
"""
import json
import os
import sys
import time
from typing import Any, Optional


completion_promise = os.environ.get("RALPH_COMPLETION_PROMISE") or "<promise>DONE</promise>"
completion_exit_code = int(os.environ.get("RALPH_COMPLETION_EXIT_CODE", "10"))
run_start_epoch = int(os.environ.get("RALPH_RUN_START_EPOCH", "0") or "0")
final_output_header = os.environ.get("RALPH_FINAL_OUTPUT_HEADER", "1").lower() not in {
    "0",
    "false",
    "no",
    "off",
}
provider = os.environ.get("RALPH_PROVIDER", "").lower()

# Raw log receives the unbuffered stream (avoids tee delays).
raw_log_path = os.environ.get("RALPH_RAW_LOG_PATH")
raw_log_file = None
completion_message: Optional[str] = None
# We record completion but defer exit until EOF to avoid broken-pipe panics
# when the CLI continues writing after the parser closes stdout.

# For Claude, we accumulate text from assistant messages
claude_accumulated_text = ""

if raw_log_path:
    try:
        raw_log_file = open(raw_log_path, "a", encoding="utf-8", buffering=1)
    except OSError:
        raw_log_file = None


def extract_text_codex(item: dict[str, Any]) -> Optional[str]:
    """Extract text from Codex item format."""
    text = item.get("text")
    if isinstance(text, str) and text.strip():
        return text
    content = item.get("content")
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            block_text = block.get("text") or block.get("content")
            if isinstance(block_text, str) and block_text.strip():
                parts.append(block_text)
        if parts:
            return "\n".join(parts)
    return None


def extract_text_claude(obj: dict[str, Any]) -> Optional[str]:
    """
    Extract text from Claude CLI format.
    Format: {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}}
    """
    message = obj.get("message", {})
    content = message.get("content", [])

    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "")
                if text:
                    parts.append(text)
        if parts:
            return "\n".join(parts)
    elif isinstance(content, str):
        return content

    return None


def detect_provider_from_event(obj: dict[str, Any]) -> str:
    """Auto-detect provider from event structure."""
    event_type = obj.get("type", "")

    # Codex uses item.* event types
    if event_type.startswith("item."):
        return "codex"

    # Claude uses "assistant", "user", "system" types with message structure
    if event_type in ("assistant", "user", "system") and "message" in obj:
        return "claude"

    # Claude system init event
    if event_type == "system" and "session_id" in obj:
        return "claude"

    return ""


def record_completion(text: Optional[str]) -> None:
    """Record completion - keeps the LAST message containing the promise."""
    global completion_message
    if text:
        completion_message = text


def process_codex_event(obj: dict[str, Any]) -> None:
    """Process a Codex JSONL event."""
    event_type = obj.get("type") or ""
    if event_type in ("item.started", "item.updated", "item.completed"):
        item = obj.get("item", {})
        item_type = item.get("item_type") or item.get("type") or "working"
        if item_type in ("assistant_message", "agent_message"):
            if event_type == "item.completed":
                extracted = extract_text_codex(item)
                if extracted and completion_promise in extracted:
                    record_completion(extracted)
        elif item_type == "message" and item.get("role") == "assistant":
            if event_type == "item.completed":
                extracted = extract_text_codex(item)
                if extracted and completion_promise in extracted:
                    record_completion(extracted)


def process_claude_event(obj: dict[str, Any]) -> None:
    """
    Process a Claude JSONL event.
    Look for assistant messages containing the completion promise.
    """
    global claude_accumulated_text

    event_type = obj.get("type", "")

    # Only process assistant messages
    if event_type != "assistant":
        return

    # Extract text from this assistant message
    text = extract_text_claude(obj)
    if text:
        claude_accumulated_text += text + "\n"

        # Check for completion promise
        if completion_promise in text:
            record_completion(text)
        elif completion_promise in claude_accumulated_text:
            record_completion(claude_accumulated_text)


detected_provider = provider

try:
    for line in sys.stdin:
        if raw_log_file:
            raw_log_file.write(line)
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            # Fast-path in case the stream isn't JSONL.
            if completion_promise and completion_promise in line and completion_message is None:
                if raw_log_file:
                    raw_log_file.flush()
                record_completion(line)
            continue

        # Auto-detect provider if not set
        if not detected_provider:
            detected_provider = detect_provider_from_event(obj)

        # Route to appropriate handler
        if detected_provider == "claude":
            process_claude_event(obj)
        else:
            # Default to codex format
            process_codex_event(obj)

finally:
    msg = completion_message  # local copy for type narrowing
    if msg:
        cleaned = msg.replace(completion_promise, "").strip()
        if cleaned:
            if final_output_header:
                print("\r\033[2K", end="", file=sys.stderr, flush=True)
            if final_output_header and run_start_epoch:
                elapsed_secs = max(0, int(time.time()) - run_start_epoch)
                header = f"--- final output | {elapsed_secs // 60}:{elapsed_secs % 60:02d} ---"
                if raw_log_file:
                    raw_log_file.write("\n")
                    raw_log_file.write(f"{header}\n")
                    raw_log_file.flush()
                print("", flush=True)
                print(header, flush=True)
            print(cleaned, flush=True)
    if raw_log_file:
        raw_log_file.close()
    sys.exit(completion_exit_code if msg else 0)
