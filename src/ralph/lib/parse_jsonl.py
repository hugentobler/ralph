#!/usr/bin/env python3
"""
JSONL parser for ralph - supports Codex, Claude, and pi streaming formats.

Provider:
- RALPH_PROVIDER env var: "codex", "claude", or "pi"

Codex format:
  {"type": "item.completed", "item": {"type": "assistant_message", "text": "..."}}

Claude format:
  {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}], "stop_reason": "end_turn"}}

Pi format (pi --mode json):
  {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "..."}]}}
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

TEXT_BLOCK_TYPES = {"text"}

# Raw log receives the unbuffered stream (avoids tee delays).
raw_log_path = os.environ.get("RALPH_RAW_LOG_PATH")
raw_log_file = None
completion_message: Optional[str] = None

# We record completion but defer exit until EOF to avoid broken-pipe panics
# when the CLI continues writing after the parser closes stdout.

if raw_log_path:
    try:
        raw_log_file = open(raw_log_path, "a", encoding="utf-8", buffering=1)
    except OSError:
        raw_log_file = None


def extract_text_from_blocks(
    content: Any,
    *,
    allowed_types: Optional[set[str]] = None,
    text_keys: tuple[str, ...] = ("text", "content"),
) -> Optional[str]:
    """Extract text from content blocks or strings."""
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if allowed_types is not None and block.get("type") not in allowed_types:
                continue
            block_text = None
            for key in text_keys:
                value = block.get(key)
                if isinstance(value, str) and value.strip():
                    block_text = value
                    break
            if block_text:
                parts.append(block_text)
        if parts:
            return "\n".join(parts)
    elif isinstance(content, str):
        return content

    return None


def extract_text_from_message(
    message: dict[str, Any], *, require_role: Optional[str] = None
) -> Optional[str]:
    """Extract text from a message with optional role filtering."""
    if require_role and message.get("role") != require_role:
        return None
    return extract_text_from_blocks(
        message.get("content"),
        allowed_types=TEXT_BLOCK_TYPES,
        text_keys=("text",),
    )


def extract_text_codex(item: dict[str, Any]) -> Optional[str]:
    """Extract text from Codex item format."""
    text = item.get("text")
    if isinstance(text, str) and text.strip():
        return text
    return extract_text_from_blocks(item.get("content"), allowed_types=None)


def extract_text_claude(obj: dict[str, Any]) -> Optional[str]:
    """
    Extract text from Claude CLI format.
    Format: {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}}
    """
    message = obj.get("message", {})
    return extract_text_from_message(message)


def extract_text_pi_message(message: dict[str, Any]) -> Optional[str]:
    """Extract text from a pi assistant message."""
    return extract_text_from_message(message, require_role="assistant")


def is_codex_assistant_item(item: dict[str, Any]) -> bool:
    item_type = item.get("item_type") or item.get("type") or ""
    if item_type in {"assistant_message", "agent_message"}:
        return True
    return item_type == "message" and item.get("role") == "assistant"


def record_completion(text: Optional[str]) -> None:
    """Record completion - keeps the LAST message containing the promise."""
    global completion_message
    if text:
        completion_message = text


def extract_codex_event_text(obj: dict[str, Any]) -> Optional[str]:
    """Extract completion text from Codex JSONL events."""
    if obj.get("type") != "item.completed":
        return None
    item = obj.get("item", {})
    if not is_codex_assistant_item(item):
        return None
    return extract_text_codex(item)


def extract_claude_event_text(obj: dict[str, Any]) -> Optional[str]:
    """Extract completion text from Claude JSONL events."""
    if obj.get("type") != "assistant":
        return None
    return extract_text_claude(obj)


def extract_pi_event_text(obj: dict[str, Any]) -> Optional[str]:
    """Extract completion text from pi JSON events."""
    if obj.get("type") != "message_end":
        return None
    return extract_text_pi_message(obj.get("message", {}))


def extract_nothing(_: dict[str, Any]) -> Optional[str]:
    return None


PROVIDERS: dict[str, dict[str, Any]] = {
    "codex": {
        "skip_event_types": {"item.updated"},
        "accumulate_text": False,
        "extract_text": extract_codex_event_text,
    },
    "claude": {
        "skip_event_types": set(),
        "accumulate_text": True,
        "extract_text": extract_claude_event_text,
    },
    "pi": {
        "skip_event_types": {"message_update", "tool_execution_update"},
        "accumulate_text": False,
        "extract_text": extract_pi_event_text,
    },
}
DEFAULT_PROVIDER = {
    "skip_event_types": set(),
    "accumulate_text": False,
    "extract_text": extract_nothing,
}
provider_config = PROVIDERS.get(provider, DEFAULT_PROVIDER)
provider_state = {
    "accumulated_text": "",
}


def handle_extracted_text(extracted: Optional[str]) -> None:
    if not extracted:
        return
    if provider_config["accumulate_text"]:
        provider_state["accumulated_text"] += extracted + "\n"
    if completion_promise and completion_promise in extracted:
        record_completion(extracted)
    elif provider_config["accumulate_text"] and completion_promise in provider_state["accumulated_text"]:
        record_completion(provider_state["accumulated_text"])


try:
    for line in sys.stdin:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            if raw_log_file:
                raw_log_file.write(line)
            # Fast-path in case the stream isn't JSONL.
            if completion_promise and completion_promise in line and completion_message is None:
                if raw_log_file:
                    raw_log_file.flush()
                record_completion(line)
            continue

        if raw_log_file:
            event_type = obj.get("type", "")
            if event_type not in provider_config["skip_event_types"]:
                raw_log_file.write(line)

        extracted = provider_config["extract_text"](obj)
        handle_extracted_text(extracted)

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
