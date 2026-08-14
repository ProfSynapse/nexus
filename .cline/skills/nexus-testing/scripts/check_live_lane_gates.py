#!/usr/bin/env python3
"""Check that every live Jest lane makes itself inert without an env gate.

Why this exists: Jest is configured with roots ['<rootDir>/tests'] and
testMatch ['**/*.test.ts'], so `npm run test` collects EVERY lane, including the
ones that drive a real vault or a paid provider. Those lanes stay out of CI only
because each file selects `describe.skip` (or `it.skip`) when its own env var is
unset. That is a per-file property nothing else enforces, and a live lane that
forgets it runs in CI against someone's vault.

What counts as a live lane (no hardcoded file list -- that would rot):
  * any *.test.ts under tests/debug/, unconditionally -- the directory IS the
    convention; and
  * any *.test.ts elsewhere under tests/ that looks like it shells out to the
    real `nexus` binary: a child-process API, a quoted 'nexus' literal, and no
    `jest.mock(` anywhere in the file. That last clause is what separates a lane
    that spawns a process from the many unit tests that mock one.

What each one must have, both mechanical and stable:
  1. at least one `process.env.<VAR>` read, and
  2. a conditional-skip construct: `describe.skip` or `it.skip`.

It deliberately does NOT check gate NAMES. An enumerated list of allowed env
vars cannot generalize and rots; the gate's identity is the file's business and
belongs in its header comment.

Exit 0 when clean, 1 when a lane is ungated, 2 on usage error.

Usage:
  python3 check_live_lane_gates.py                 # repo root inferred
  python3 check_live_lane_gates.py /path/to/repo
  python3 check_live_lane_gates.py --tests-dir tests
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ENV_READ = re.compile(r"process\.env\.[A-Za-z_][A-Za-z0-9_]*")
SKIP = re.compile(r"\b(?:describe|it|test)\.skip\b")
CHILD_PROCESS = re.compile(r"\b(?:execFile|execFileSync|spawn|spawnSync|execSync)\w*")
NEXUS_BINARY = re.compile(r"""['"]nexus['"]""")
JEST_MOCK = re.compile(r"\bjest\.mock\(")


def infer_repo_root(start: Path) -> Path:
    """Walk up from this script until a directory with package.json appears."""
    for candidate in [start, *start.parents]:
        if (candidate / "package.json").is_file():
            return candidate
    return start


def is_live_lane(rel: Path, text: str) -> bool:
    if rel.parts[:2] == ("tests", "debug"):
        return True
    if JEST_MOCK.search(text):
        return False  # a file that mocks is not spawning the real thing
    return bool(CHILD_PROCESS.search(text)) and bool(NEXUS_BINARY.search(text))


def check_file(rel: Path, text: str) -> list[str]:
    violations: list[str] = []
    if not ENV_READ.search(text):
        violations.append(
            f"{rel}:1: live lane reads no process.env gate -- it will run in CI"
        )
    if not SKIP.search(text):
        violations.append(
            f"{rel}:1: live lane has no describe.skip/it.skip -- nothing makes it "
            f"inert when its gate is unset"
        )
    return violations


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "repo_root",
        nargs="?",
        default=None,
        help="repository root (default: inferred from this script's location)",
    )
    parser.add_argument(
        "--tests-dir",
        default="tests",
        help="tests directory relative to the repo root (default: tests)",
    )
    args = parser.parse_args()

    root = Path(args.repo_root).resolve() if args.repo_root else infer_repo_root(
        Path(__file__).resolve().parent
    )
    tests = root / args.tests_dir
    if not tests.is_dir():
        print(f"error: no tests directory at {tests}", file=sys.stderr)
        return 2

    violations: list[str] = []
    scanned = 0
    for path in sorted(tests.rglob("*.test.ts")):
        rel = path.relative_to(root)
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:  # unreadable file is a real problem, not a skip
            violations.append(f"{rel}:1: cannot read ({exc})")
            continue
        if not is_live_lane(rel, text):
            continue
        scanned += 1
        violations.extend(check_file(rel, text))

    for v in violations:
        print(v)

    if violations:
        print(f"\nUNGATED: {len(violations)} violation(s) across {scanned} live lane(s)")
        print("Fix: gate the describe on an env var, as tests/debug/ lanes do.")
        return 1

    print(f"OK: {scanned} live lane(s) gated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
