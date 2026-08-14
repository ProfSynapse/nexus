#!/usr/bin/env python3
"""Print the CLI name a Nexus slug or agent name advertises as.

Slugs are not CLI names. `toKebabCase` in
src/agents/toolManager/services/ToolCliNormalizer.ts strips a trailing
Manager/Agent/Tools suffix before kebab-casing, so the slug `subagent` on
`promptManager` is typed `prompt sub`. Guessing that transform from memory is
how docs end up naming commands that do not resolve.

This script does not hardcode the suffix list: it reads the `toKebabCase` body
out of the TypeScript source and applies the suffix strips it finds there, so it
cannot drift from the implementation. If that function grows a step this script
does not model, it says so and exits 1 rather than printing a confident wrong
answer.

Usage:
  python cli_name.py SLUG [SLUG ...] [--agent AGENT_NAME] [--source PATH]

Examples:
  python cli_name.py subagent --agent promptManager     -> prompt sub
  python cli_name.py searchManager                      -> search

Exit codes:
  0  printed a name for every input
  1  the source transform contains a step this script does not implement
  2  usage error / source file not found
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

SOURCE_REL = Path("src/agents/toolManager/services/ToolCliNormalizer.ts")
FUNC_START = re.compile(r"export function toKebabCase\s*\(")
REPLACE_CALL = re.compile(r"\.replace\(\s*/(?P<pat>(?:[^/\\]|\\.)+)/(?P<flags>[a-z]*)\s*,\s*(?P<repl>'[^']*'|\"[^\"]*\"|`[^`]*`)\s*\)")

# The generic (non-suffix) steps this script models, as they appear in source.
KNOWN_GENERIC = {
    r"([a-z0-9])([A-Z])": "camel_split",
    r"[_\s]+": "collapse_separators",
    r"--+": "collapse_dashes",
}


def find_repo_root(start: Path) -> Path | None:
    """Walk up from `start` looking for the normalizer source."""
    for candidate in [start, *start.parents]:
        if (candidate / SOURCE_REL).is_file():
            return candidate
    return None


def read_transform(source: Path) -> tuple[list[str], list[str]]:
    """Return (suffixes stripped, unmodeled steps) parsed from toKebabCase."""
    text = source.read_text(encoding="utf-8")
    match = FUNC_START.search(text)
    if not match:
        raise LookupError("could not find `export function toKebabCase` in the source")
    body = text[match.end():]
    end = body.find("\n}")
    if end != -1:
        body = body[:end]

    suffixes: list[str] = []
    unmodeled: list[str] = []
    for call in REPLACE_CALL.finditer(body):
        pattern = call.group("pat")
        if pattern.endswith("$") and re.fullmatch(r"[A-Za-z]+\$", pattern):
            suffixes.append(pattern[:-1])
        elif pattern in KNOWN_GENERIC:
            continue
        else:
            unmodeled.append(pattern)
    return suffixes, unmodeled


def to_kebab(value: str, suffixes: list[str]) -> str:
    out = value
    for suffix in suffixes:
        out = re.sub(re.escape(suffix) + r"$", "", out, flags=re.IGNORECASE)
    out = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", out)
    out = re.sub(r"[_\s]+", "-", out)
    out = re.sub(r"--+", "-", out)
    return out.lower()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("slug", nargs="+", help="tool slug(s) or agent name(s)")
    parser.add_argument("--agent", help="agent name to prefix, e.g. promptManager")
    parser.add_argument("--source", help=f"path to {SOURCE_REL} (default: found by walking up)")
    args = parser.parse_args()

    if args.source:
        source = Path(args.source)
    else:
        root = find_repo_root(Path.cwd().resolve())
        if root is None:
            print(
                f"error: could not find {SOURCE_REL} from {Path.cwd()}; "
                f"run inside the repo or pass --source",
                file=sys.stderr,
            )
            return 2
        source = root / SOURCE_REL

    if not source.is_file():
        print(f"error: no such file: {source}", file=sys.stderr)
        return 2

    try:
        suffixes, unmodeled = read_transform(source)
    except LookupError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    prefix = f"{to_kebab(args.agent, suffixes)} " if args.agent else ""
    for slug in args.slug:
        print(f"{prefix}{to_kebab(slug, suffixes)}")

    if unmodeled:
        print(
            f"\n{source}: toKebabCase contains step(s) this script does not model: "
            + ", ".join(f"/{p}/" for p in unmodeled)
            + "\nThe answers above may be wrong. Update cli_name.py to match the source.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
