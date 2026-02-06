import readline from "node:readline";

let completionMessage = null;
// Defer exit until EOF to avoid broken-pipe panics if codex keeps writing.
const completionPromise = process.env.RALPH_COMPLETION_PROMISE ?? "<promise>DONE</promise>";
const completionExitCode = Number.parseInt(
  process.env.RALPH_COMPLETION_EXIT_CODE ?? "10",
  10,
);
const runStartEpoch = Number.parseInt(process.env.RALPH_RUN_START_EPOCH ?? "0", 10) || 0;
const finalOutputHeader = !["0", "false", "no", "off"].includes(
  String(process.env.RALPH_FINAL_OUTPUT_HEADER ?? "1").toLowerCase(),
);
// Raw log receives the unbuffered stream (avoids tee delays).
const rawLogPath = process.env.RALPH_RAW_LOG_PATH ?? null;
const rawLogStream = rawLogPath
  ? (await import("node:fs")).createWriteStream(rawLogPath, { flags: "a" })
  : null;

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
    if (itemType === "assistant_message" || itemType === "agent_message") {
      if (eventType === "item.completed") {
        const extracted = extractText(item);
        if (extracted) {
          if (completionPromise && extracted.includes(completionPromise)) {
            recordCompletion(extracted);
          }
        }
      }
    } else if (itemType === "message" && item?.role === "assistant") {
      if (eventType === "item.completed") {
        const extracted = extractText(item);
        if (extracted) {
          if (completionPromise && extracted.includes(completionPromise)) {
            recordCompletion(extracted);
          }
        }
      }
    }
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
