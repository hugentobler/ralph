from __future__ import annotations

import os
import subprocess
import sys
from importlib import resources


def main() -> int:
    try:
        ralph_bin = resources.files("ralph").joinpath("bin/ralph")
    except Exception as exc:
        print(f"ralph executable not found in package: {exc}", file=sys.stderr)
        return 1

    if not ralph_bin.exists():
        print(f"ralph executable not found: {ralph_bin}", file=sys.stderr)
        return 1

    args = ["bash", str(ralph_bin), *sys.argv[1:]]
    result = subprocess.run(args, cwd=os.getcwd())
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
