/**
 * JSONL parser for ralph - supports Codex, Claude, and pi streaming formats.
 *
 * Provider:
 * - RALPH_PROVIDER env var: "codex", "claude", or "pi"
 *
 * Codex format:
 *   {"type": "item.completed", "item": {"type": "assistant_message", "text": "..."}}
 *
 * Claude format:
 *   {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}], "stop_reason": "end_turn"}}
 *
 * Pi format (pi --mode json):
 *   {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "..."}]}}
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
const provider = (process.env.RALPH_PROVIDER ?? "").toLowerCase();

const TEXT_BLOCK_TYPES = new Set(["text"]);
const EMPTY_SKIP_SET = new Set();

// Raw log receives the unbuffered stream (avoids tee delays).
const rawLogPath = process.env.RALPH_RAW_LOG_PATH ?? null;
const fs = await import("node:fs");
const rawLogStream = rawLogPath ? fs.createWriteStream(rawLogPath, { flags: "a" }) : null;

/**
 * Extract text from content blocks or strings.
 */
function extractTextFromBlocks(
  content,
  { allowedTypes = null, textKeys = ["text", "content"] } = {},
) {
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (allowedTypes && !allowedTypes.has(block.type)) continue;
      let blockText = null;
      for (const key of textKeys) {
        const value = block[key];
        if (typeof value === "string" && value.trim()) {
          blockText = value;
          break;
        }
      }
      if (blockText) parts.push(blockText);
    }
    if (parts.length) return parts.join("\n");
  } else if (typeof content === "string") {
    return content;
  }
  return null;
}

function extractTextFromMessage(message, { requireRole = null } = {}) {
  if (requireRole && message?.role !== requireRole) {
    return null;
  }
  return extractTextFromBlocks(message?.content, {
    allowedTypes: TEXT_BLOCK_TYPES,
    textKeys: ["text"],
  });
}

/**
 * Extract text from Codex item format.
 */
function extractTextCodex(item) {
  const text = item?.text;
  if (typeof text === "string" && text.trim()) return text;
  return extractTextFromBlocks(item?.content, {
    allowedTypes: null,
    textKeys: ["text", "content"],
  });
}

/**
 * Extract text from Claude CLI format.
 * Format: {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}}
 */
function extractTextClaude(obj) {
  const message = obj?.message ?? {};
  return extractTextFromMessage(message);
}

function extractTextPiMessage(message) {
  return extractTextFromMessage(message, { requireRole: "assistant" });
}

function isCodexAssistantItem(item) {
  const itemType = item?.item_type ?? item?.type ?? "";
  if (itemType === "assistant_message" || itemType === "agent_message") {
    return true;
  }
  return itemType === "message" && item?.role === "assistant";
}

/**
 * Record completion - keeps the LAST message containing the promise.
 */
function recordCompletion(text) {
  if (text) {
    completionMessage = text;
  }
}

const PROVIDERS = {
  codex: {
    skipEventTypes: new Set(["item.updated"]),
    accumulateText: false,
    extractText(obj) {
      if (obj?.type !== "item.completed") return null;
      const item = obj?.item ?? {};
      if (!isCodexAssistantItem(item)) return null;
      return extractTextCodex(item);
    },
  },
  claude: {
    skipEventTypes: new Set(),
    accumulateText: true,
    extractText(obj) {
      if (obj?.type !== "assistant") return null;
      return extractTextClaude(obj);
    },
  },
  pi: {
    skipEventTypes: new Set(["message_update", "tool_execution_update"]),
    accumulateText: false,
    extractText(obj) {
      if (obj?.type !== "message_end") return null;
      return extractTextPiMessage(obj?.message ?? {});
    },
  },
};

const providerConfig = PROVIDERS[provider] ?? {
  skipEventTypes: EMPTY_SKIP_SET,
  accumulateText: false,
  extractText: () => null,
};
const providerState = {
  accumulatedText: "",
};

function handleExtractedText(text) {
  if (!text) return;
  if (providerConfig.accumulateText) {
    providerState.accumulatedText += `${text}\n`;
  }
  if (completionPromise && text.includes(completionPromise)) {
    recordCompletion(text);
  } else if (
    providerConfig.accumulateText &&
    completionPromise &&
    providerState.accumulatedText.includes(completionPromise)
  ) {
    recordCompletion(providerState.accumulatedText);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of rl) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    if (rawLogStream) {
      rawLogStream.write(`${line}\n`);
    }
    // Fast-path in case the stream isn't JSONL.
    if (completionPromise && line.includes(completionPromise) && !completionMessage) {
      recordCompletion(line);
    }
    continue;
  }

  if (rawLogStream) {
    const eventType = obj?.type ?? "";
    const skipSet = providerConfig.skipEventTypes ?? EMPTY_SKIP_SET;
    if (!skipSet.has(eventType)) {
      rawLogStream.write(`${line}\n`);
    }
  }

  const extracted = providerConfig.extractText(obj);
  handleExtractedText(extracted);
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
