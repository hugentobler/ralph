# ralph

Run claude (wip), codex, or pi-mono (wip) in a loop until everything in `RALPH.md` is complete.
Install with either `uv` or `bun`, then run `ralph` in any directory with a `RALPH.md` file.
Python or JS runtime required.

## Install

1. Clone this repo.
2. Install:
    - With uv: `uv tool install {path to this repo}`
    - With bun: `bun install -g {path to this repo}`

## Behavior

- Runs for 10 max iterations until the everything in `RALPH.md` is complete.
- Shows auto-summarized progress.
- Logs transcript to `.ralph/loop-YYYYMMDD-HHMMSS.log`.

## TODO
- [x] Support codex.
- [ ] Support claude.
- [ ] Support pi-mono.
- [ ] Support worktrees?
