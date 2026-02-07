# ralph

Run codex or claude in a loop until everything in `RALPH.md` is complete.
Auto-detects which CLI is available (prefers codex).

## Install

```bash
uv tool install {path to repo}
# or
bun install -g {path to repo}
```

Requires Python or Node/Bun for JSONL parsing.

## Usage

```bash
ralph            # auto-detect provider (prefers codex)
ralph --claude   # use claude
ralph --codex    # use codex
ralph --web      # enable web search/fetch
```

## Behavior

- Loops until task complete (max 8 iterations).
- Auto-summarized progress via heartbeat.
- Logs to `.ralph/loop-YYYYMMDD-HHMMSS.log`.
- No session persistence - each run starts fresh.
- Web search/fetch disabled by default.

## TODO
- [x] Support codex.
- [x] Support claude.
- [ ] Support pi-mono.
- [ ] Support worktrees?
