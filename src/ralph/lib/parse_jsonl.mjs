import readline from "node:readline";

let status = "starting...";
let completionMessage = null;
// Defer exit until EOF to avoid broken-pipe panics if codex keeps writing.
const heartbeatSecs = Number.parseFloat(process.env.RALPH_HEARTBEAT_SECS ?? "30");
const completionPromise = process.env.RALPH_COMPLETION_PROMISE ?? "<promise>DONE</promise>";
const completionExitCode = Number.parseInt(
  process.env.RALPH_COMPLETION_EXIT_CODE ?? "10",
  10,
);
// Raw log receives the unbuffered stream (avoids tee delays).
const rawLogPath = process.env.RALPH_RAW_LOG_PATH ?? null;
const rawLogStream = rawLogPath
  ? (await import("node:fs")).createWriteStream(rawLogPath, { flags: "a" })
  : null;

setInterval(() => {
  process.stderr.write(`${status}\n`);
}, heartbeatSecs * 1000).unref();

function extractText(item) {
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

function recordCompletion(text) {
  if (!completionMessage && text) {
    completionMessage = text;
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

  const eventType = obj?.type ?? "";
  if (eventType === "item.started" || eventType === "item.updated" || eventType === "item.completed") {
    const item = obj?.item ?? {};
    const itemType = item?.item_type ?? item?.type ?? "working";
    if (itemType === "command_execution") {
      status = `running: ${(item?.command ?? "").trim()}`;
    } else if (itemType === "reasoning") {
      status = item?.text ?? "thinking...";
    } else if (itemType === "file_change") {
      status = "writing files";
    } else if (itemType === "assistant_message" || itemType === "agent_message") {
      status = "final response ready";
      if (eventType === "item.completed") {
        const extracted = extractText(item);
        if (extracted) {
          if (completionPromise && extracted.includes(completionPromise)) {
            recordCompletion(extracted);
          }
        }
      }
    } else if (itemType === "message" && item?.role === "assistant") {
      status = "final response ready";
      if (eventType === "item.completed") {
        const extracted = extractText(item);
        if (extracted) {
          if (completionPromise && extracted.includes(completionPromise)) {
            recordCompletion(extracted);
          }
        }
      }
    } else {
      status = itemType;
    }
  }
}

if (rawLogStream) {
  rawLogStream.end();
}

if (completionMessage) {
  const cleaned = String(completionMessage).replace(completionPromise, "").trim();
  if (cleaned) {
    process.stdout.write(`${cleaned}\n`);
  }
  process.exit(completionExitCode);
}
