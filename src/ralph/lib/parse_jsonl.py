#!/usr/bin/env python3
import json
import os
import sys
import threading
import time
from typing import Any, Optional


status = "starting..."


heartbeat_secs = float(os.environ.get("RALPH_HEARTBEAT_SECS", "30"))
completion_promise = os.environ.get("RALPH_COMPLETION_PROMISE") or "<promise>DONE</promise>"
completion_exit_code = int(os.environ.get("RALPH_COMPLETION_EXIT_CODE", "10"))
# Raw log receives the unbuffered stream (avoids tee delays).
raw_log_path = os.environ.get("RALPH_RAW_LOG_PATH")
raw_log_file = None
completion_message: Optional[str] = None
# We record completion but defer exit until EOF to avoid broken-pipe panics
# when codex continues writing after the parser closes stdout.

if raw_log_path:
    try:
        raw_log_file = open(raw_log_path, "a", encoding="utf-8", buffering=1)
    except OSError:
        raw_log_file = None


def heartbeat() -> None:
    while True:
        time.sleep(heartbeat_secs)
        print(status, file=sys.stderr, flush=True)


threading.Thread(target=heartbeat, daemon=True).start()


def extract_text(item: dict[str, Any]) -> Optional[str]:
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


def record_completion(text: Optional[str]) -> None:
    global completion_message
    if completion_message is None and text:
        completion_message = text


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

        event_type = obj.get("type") or ""
        if event_type in ("item.started", "item.updated", "item.completed"):
            item = obj.get("item", {})
            item_type = item.get("item_type") or item.get("type") or "working"
            if item_type == "command_execution":
                status = f"running: {item.get('command', '').strip()}"
            elif item_type == "reasoning":
                status = item.get("text", "thinking...")
            elif item_type == "file_change":
                status = "writing files"
            elif item_type in ("assistant_message", "agent_message"):
                status = "final response ready"
                if event_type == "item.completed":
                    extracted = extract_text(item)
                    if extracted and completion_promise in extracted:
                        record_completion(extracted)
            elif item_type == "message" and item.get("role") == "assistant":
                status = "final response ready"
                if event_type == "item.completed":
                    extracted = extract_text(item)
                    if extracted and completion_promise in extracted:
                        record_completion(extracted)
            else:
                status = item_type
finally:
    if raw_log_file:
        raw_log_file.close()

if completion_message:
    cleaned = completion_message.replace(completion_promise, "").strip()
    if cleaned:
        print(cleaned, flush=True)
    raise SystemExit(completion_exit_code)
