#!/usr/bin/env python3
"""Check that every Nexus LLM adapter which parses provider frames wires error extraction.

The rule: a provider can deliver a fatal error as a data frame over HTTP 200. The
stream layer only turns that into a thrown `LLMProviderError` when the adapter says
how to recognise it. Without that the pump drains, the generator ends, the chat
bubble stays blank, and nothing is logged.

Every frame-parsing processor now honours the same `extractError` option --
`processNodeStream`, `processSSEStream`, `processBufferedSSEText`, `processStream`
and `processNodeStreamJsonLines` alike -- so the option means one thing wherever it
appears and this check applies uniformly. Adapters that hand-roll their own
`createParser` loop (the OpenAI Responses family) satisfy the same rule by calling
a shared extractor from `src/services/llm/streaming/streamErrorFrames.ts`.

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
  1  a checked adapter parses provider frames without wiring error extraction
  2  usage error (bad path, no adapters found)
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ADAPTERS_SUBDIR = Path("src/services/llm/adapters")

# Every entrypoint that parses provider frames off a streaming HTTP 200 response.
# All of the BaseAdapter processors honour `extractError`; `createParser(` catches
# the adapters that hand-roll an eventsource-parser loop of their own. The trailing
# `(` keeps `processStreamChunk` and friends from matching by prefix.
FRAME_ENTRYPOINTS = re.compile(
    r"\b(?:"
    r"processNodeStream|"
    r"processNodeStreamJsonLines|"
    r"processSSEStream|"
    r"processBufferedSSEText|"
    r"processStream|"
    r"createParser"
    r")\s*\("
)
# Evidence that the frame parser can recognise an error frame: the option supplied
# to a shared processor, or a call to one of the shared extractors from a
# hand-rolled parser.
ERROR_WIRING = re.compile(
    r"\bextractError\s*:"
    r"|\bextractStreamErrorMessage\s*\("
    r"|\bextractResponsesApiStreamError\s*\("
)

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
    """Return (frame-parsing files missing error wiring, files that have it)."""
    missing: list[str] = []
    wired: list[str] = []
    for ts in sorted(adapter.rglob("*.ts")):
        text = ts.read_text(encoding="utf-8", errors="replace")
        if not FRAME_ENTRYPOINTS.search(text):
            continue
        if ERROR_WIRING.search(text):
            wired.append(str(ts))
        else:
            line = next(
                (
                    i
                    for i, ln in enumerate(text.splitlines(), 1)
                    if FRAME_ENTRYPOINTS.search(ln)
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
                print(f"{adapter.name}: no provider frame parsing found -- nothing to check")
            continue
        streaming += 1
        if missing:
            for loc in missing:
                violations.append(
                    f"{loc}: parses provider frames without error extraction -- a provider "
                    f"error frame over HTTP 200 will end the stream silently"
                )
        else:
            print(f"OK   {adapter.name}: error extraction wired")

    for v in violations:
        print(v)

    if violations:
        print(f"\n{len(violations)} unwired stream site(s) across {streaming} streaming adapter(s)")
        if gate:
            print(
                "Fix: add `extractError` to the stream options, or call "
                "extractStreamErrorMessage / extractResponsesApiStreamError from a "
                "hand-rolled parser. See references/streaming-contract.md."
            )
            return 1
        print(
            "Inventory mode: not failing. Re-run with the adapter name to gate a "
            "specific one, or --strict to gate the whole tree."
        )
        return 0

    if streaming == 0:
        print("\nclean: no streaming adapter in scope, nothing to check")
    else:
        print(f"\nclean: {streaming} streaming adapter(s) checked, all wire error extraction")
    return 0


if __name__ == "__main__":
    sys.exit(main())
