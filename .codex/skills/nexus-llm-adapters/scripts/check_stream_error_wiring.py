#!/usr/bin/env python3
"""Check that every Nexus LLM adapter which parses an SSE stream wires `extractError`.

The rule: a provider can deliver a fatal error as a data frame over HTTP 200. The
shared stream processor only turns that into a thrown error when the adapter
supplies an `extractError` extractor in its stream options. Without one the pump
drains, the generator ends, the chat bubble stays blank, and nothing is logged.

This is mechanical and stable, so it is a script rather than a prose reminder. It
discovers adapters from the tree -- it hardcodes no provider list, so it cannot
rot as providers come and go.

Usage:
  # Gate: check the adapter(s) you touched. Non-zero exit if any is unwired.
  python check_stream_error_wiring.py --repo-root . lmstudio
  python check_stream_error_wiring.py --repo-root . src/services/llm/adapters/groq

  # Inventory: current wiring state of every streaming adapter (exit 0).
  python check_stream_error_wiring.py --repo-root .

  # Inventory as a gate (fails while any streaming adapter is unwired).
  python check_stream_error_wiring.py --repo-root . --strict

Exit codes:
  0  clean / inventory printed
  1  a checked adapter parses an SSE stream without wiring extractError
  2  usage error (bad path, no adapters found)
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ADAPTERS_SUBDIR = Path("src/services/llm/adapters")

# The incremental SSE path -- the ONLY processor that consults `extractError`.
# `processSSEStream` / `processBufferedSSEText` accept the option in their type but
# never read it, and `processStream` uses an option type that does not declare it,
# so flagging those would demand a fix that cannot be made in the adapter. The
# trailing `(` keeps `processNodeStreamJsonLines` (a different contract) out.
SSE_ENTRYPOINTS = re.compile(r"\bprocessNodeStream\s*\(")
# The extractor being supplied as a stream option.
EXTRACT_ERROR = re.compile(r"\bextractError\s*:")

# Directories under adapters/ that are shared plumbing, not a provider.
NON_PROVIDER_DIRS = {"shared"}


def adapter_dirs(root: Path) -> list[Path]:
    base = root / ADAPTERS_SUBDIR
    if not base.is_dir():
        return []
    return sorted(
        d
        for d in base.iterdir()
        if d.is_dir() and d.name not in NON_PROVIDER_DIRS and not d.name.startswith(".")
    )


def resolve_target(root: Path, token: str) -> Path | None:
    """Accept a bare provider directory name or a path to one."""
    candidates = [
        root / ADAPTERS_SUBDIR / token,
        root / token,
        Path(token),
    ]
    for c in candidates:
        if c.is_dir():
            return c
    return None


def scan(adapter: Path) -> tuple[list[str], list[str]]:
    """Return (streaming files missing extractError, streaming files with it)."""
    missing: list[str] = []
    wired: list[str] = []
    for ts in sorted(adapter.rglob("*.ts")):
        text = ts.read_text(encoding="utf-8", errors="replace")
        if not SSE_ENTRYPOINTS.search(text):
            continue
        if EXTRACT_ERROR.search(text):
            wired.append(str(ts))
        else:
            line = next(
                (
                    i
                    for i, ln in enumerate(text.splitlines(), 1)
                    if SSE_ENTRYPOINTS.search(ln)
                ),
                1,
            )
            missing.append(f"{ts}:{line}")
    return missing, wired


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "adapters",
        nargs="*",
        help="provider directory name(s) or path(s); omit to inventory all",
    )
    parser.add_argument(
        "--repo-root", default=".", help="path to the Nexus repo root (default: .)"
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="in inventory mode, exit 1 if any streaming adapter is unwired",
    )
    args = parser.parse_args()

    root = Path(args.repo_root)
    if not (root / ADAPTERS_SUBDIR).is_dir():
        print(
            f"error: {root / ADAPTERS_SUBDIR} not found -- pass --repo-root",
            file=sys.stderr,
        )
        return 2

    if args.adapters:
        targets = []
        for token in args.adapters:
            resolved = resolve_target(root, token)
            if resolved is None:
                print(f"error: no such adapter directory: {token}", file=sys.stderr)
                return 2
            targets.append(resolved)
        gate = True
    else:
        targets = adapter_dirs(root)
        gate = args.strict
        if not targets:
            print("error: no adapter directories found", file=sys.stderr)
            return 2

    violations: list[str] = []
    streaming = 0
    for adapter in targets:
        missing, wired = scan(adapter)
        if not missing and not wired:
            if args.adapters:
                print(f"{adapter.name}: no SSE stream parsing found -- nothing to check")
            continue
        streaming += 1
        if missing:
            for loc in missing:
                violations.append(
                    f"{loc}: parses an SSE stream without `extractError` -- a provider "
                    f"error frame over HTTP 200 will end the stream silently"
                )
        else:
            print(f"OK   {adapter.name}: extractError wired")

    for v in violations:
        print(v)

    if violations:
        print(f"\n{len(violations)} unwired stream site(s) across {streaming} streaming adapter(s)")
        if gate:
            print(
                "Fix: add `extractError` to the stream options. "
                "See references/streaming-contract.md."
            )
            return 1
        print(
            "Inventory mode: not failing. Re-run with the adapter name to gate a "
            "specific one, or --strict to gate the whole tree."
        )
        return 0

    if streaming == 0:
        print("\nclean: no SSE-streaming adapter in scope, nothing to check")
    else:
        print(f"\nclean: {streaming} streaming adapter(s) checked, all wire extractError")
    return 0


if __name__ == "__main__":
    sys.exit(main())
