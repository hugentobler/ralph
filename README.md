# ralph

Run codex, claude, or pi in a loop until everything in `RALPH.md` is complete.
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
ralph --pi       # use pi
ralph --web      # enable web search/fetch (codex/claude only)
```

Copy `RALPH.example.md` to `RALPH.md` and describe the task before running.

## Behavior

- Loops until task complete.
- Auto-summarized progress via heartbeat.
- Logs to `.ralph/loop-YYYYMMDD-HHMMSS.log`.
- No session persistence - each run starts fresh.
- Web search/fetch disabled by default (codex/claude only; pi ignores --web).

## TODO
- [x] Support codex.
- [x] Support claude.
- [x] Support pi.
- [ ] Cleanup JSONL parsing.
- [ ] Support worktrees?
