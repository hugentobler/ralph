#!/usr/bin/env python3
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
            if item_type in ("assistant_message", "agent_message"):
                if event_type == "item.completed":
                    extracted = extract_text(item)
                    if extracted and completion_promise in extracted:
                        record_completion(extracted)
            elif item_type == "message" and item.get("role") == "assistant":
                if event_type == "item.completed":
                    extracted = extract_text(item)
                    if extracted and completion_promise in extracted:
                        record_completion(extracted)
finally:
    if completion_message:
        cleaned = completion_message.replace(completion_promise, "").strip()
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

if completion_message:
    raise SystemExit(completion_exit_code)
