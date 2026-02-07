/**
 * JSONL parser for ralph - supports both Codex and Claude streaming formats.
 *
 * Provider detection:
 * - RALPH_PROVIDER env var: "codex" or "claude"
 * - Auto-detect from stream format if not specified
 *
 * Codex format:
 *   {"type": "item.completed", "item": {"type": "assistant_message", "text": "..."}}
 *
 * Claude format:
 *   {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}], "stop_reason": "end_turn"}}
 */
import readline from "node:readline";

let completionMessage = null;
// Defer exit until EOF to avoid broken-pipe panics if CLI keeps writing.
const completionPromise = process.env.RALPH_COMPLETION_PROMISE ?? "<promise>DONE</promise>";
const completionExitCode = Number.parseInt(
  process.env.RALPH_COMPLETION_EXIT_CODE ?? "10",
  10,
);
const runStartEpoch = Number.parseInt(process.env.RALPH_RUN_START_EPOCH ?? "0", 10) || 0;
const finalOutputHeader = !["0", "false", "no", "off"].includes(
  String(process.env.RALPH_FINAL_OUTPUT_HEADER ?? "1").toLowerCase(),
);
const configuredProvider = (process.env.RALPH_PROVIDER ?? "").toLowerCase();

// Raw log receives the unbuffered stream (avoids tee delays).
const rawLogPath = process.env.RALPH_RAW_LOG_PATH ?? null;
const rawLogStream = rawLogPath
  ? (await import("node:fs")).createWriteStream(rawLogPath, { flags: "a" })
  : null;

// For Claude, we accumulate text from assistant messages
let claudeAccumulatedText = "";
let detectedProvider = configuredProvider;

/**
 * Extract text from Codex item format.
 */
function extractTextCodex(item) {
  const text = item?.text;
  if (typeof text === "string" && text.trim()) return text;
  const content = item?.content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const blockText = block.text ?? block.content;
      if (typeof blockText === "string" && blockText.trim()) {
        parts.push(blockText);
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return null;
}

/**
 * Extract text from Claude CLI format.
 * Format: {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}}
 */
function extractTextClaude(obj) {
  const message = obj?.message ?? {};
  const content = message.content;

  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text") {
        const text = block.text ?? "";
        if (text) {
          parts.push(text);
        }
      }
    }
    if (parts.length) return parts.join("\n");
  } else if (typeof content === "string") {
    return content;
  }

  return null;
}

/**
 * Auto-detect provider from event structure.
 */
function detectProviderFromEvent(obj) {
  const eventType = obj?.type ?? "";

  // Codex uses item.* event types
  if (eventType.startsWith("item.")) {
    return "codex";
  }

  // Claude uses "assistant", "user", "system" types with message structure
  if (["assistant", "user", "system"].includes(eventType) && obj?.message) {
    return "claude";
  }

  // Claude system init event
  if (eventType === "system" && obj?.session_id) {
    return "claude";
  }

  return "";
}

/**
 * Record completion - keeps the LAST message containing the promise.
 */
function recordCompletion(text) {
  if (text) {
    completionMessage = text;
  }
}

/**
 * Process a Codex JSONL event.
 */
function processCodexEvent(obj) {
  const eventType = obj?.type ?? "";
  if (
    eventType === "item.started" ||
    eventType === "item.updated" ||
    eventType === "item.completed"
  ) {
    const item = obj?.item ?? {};
    const itemType = item?.item_type ?? item?.type ?? "working";
    if (itemType === "assistant_message" || itemType === "agent_message") {
      if (eventType === "item.completed") {
        const extracted = extractTextCodex(item);
        if (extracted && completionPromise && extracted.includes(completionPromise)) {
          recordCompletion(extracted);
        }
      }
    } else if (itemType === "message" && item?.role === "assistant") {
      if (eventType === "item.completed") {
        const extracted = extractTextCodex(item);
        if (extracted && completionPromise && extracted.includes(completionPromise)) {
          recordCompletion(extracted);
        }
      }
    }
  }
}

/**
 * Process a Claude JSONL event.
 * Look for assistant messages containing the completion promise.
 */
function processClaudeEvent(obj) {
  const eventType = obj?.type ?? "";

  // Only process assistant messages
  if (eventType !== "assistant") {
    return;
  }

  // Extract text from this assistant message
  const text = extractTextClaude(obj);
  if (text) {
    claudeAccumulatedText += text + "\n";

    // Check for completion promise
    if (completionPromise && text.includes(completionPromise)) {
      recordCompletion(text);
    } else if (completionPromise && claudeAccumulatedText.includes(completionPromise)) {
      recordCompletion(claudeAccumulatedText);
    }
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of rl) {
  if (rawLogStream) {
    rawLogStream.write(`${line}\n`);
  }
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    // Fast-path in case the stream isn't JSONL.
    if (completionPromise && line.includes(completionPromise) && !completionMessage) {
      recordCompletion(line);
    }
    continue;
  }

  // Auto-detect provider if not set
  if (!detectedProvider) {
    detectedProvider = detectProviderFromEvent(obj);
  }

  // Route to appropriate handler
  if (detectedProvider === "claude") {
    processClaudeEvent(obj);
  } else {
    // Default to codex format
    processCodexEvent(obj);
  }
}

if (completionMessage) {
  const cleaned = String(completionMessage).replace(completionPromise, "").trim();
  if (cleaned) {
    if (finalOutputHeader) {
      process.stderr.write("\r\u001b[2K");
    }
    if (finalOutputHeader && runStartEpoch) {
      const elapsedSecs = Math.max(0, Math.floor(Date.now() / 1000) - runStartEpoch);
      const header = `--- final output | ${Math.floor(elapsedSecs / 60)}:${String(
        elapsedSecs % 60,
      ).padStart(2, "0")} ---`;
      if (rawLogStream) {
        rawLogStream.write("\n");
        rawLogStream.write(`${header}\n`);
      }
      process.stdout.write("\n");
      process.stdout.write(`${header}\n`);
    }
    process.stdout.write(`${cleaned}\n`);
  }
  if (rawLogStream) {
    rawLogStream.end();
  }
  process.exit(completionExitCode);
}

if (rawLogStream) {
  rawLogStream.end();
}
