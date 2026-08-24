#!/usr/bin/env python3
"""Check that every Nexus command written in a doc resolves against the catalog.

The repo's shipped-docs gate (tests/unit/shippedGuidanceCommands.test.ts) reads
README, the CLI entry point, the packaged skill, its playbooks and the guide
directory -- it does not read .claude/skills/**. A command written in a skill
file is therefore unguarded, and a slug rename or a kebab-transform change makes
it silently wrong.

This script closes that gap for any file you point it at. It extracts
`nexus tools <selector>` and `nexus use ... -- <agent> <tool>` invocations from
markdown (fenced or inline) and checks each against the generated tool catalog,
which is the caller's-eye view of what exists. No tool list is hardcoded here:
regenerate the catalog and this check follows.

Placeholders are skipped, not failed: any command containing <angle>, {brace},
$var or an ellipsis is treated as a template.

Usage:
  python check_documented_commands.py TARGET [TARGET ...] [--catalog PATH] [--verbose]

  TARGET   a markdown file, or a directory scanned recursively for *.md

Exit codes:
  0  every resolvable command was found in the catalog
  1  at least one command does not resolve
  2  usage error, or no catalog (regenerate it, see the message)
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import shlex
import sys
from pathlib import Path

CATALOG_NAME = "cli-first-tool-schemas.json"
CATALOG_FALLBACK = Path("docs/generated") / CATALOG_NAME
REGEN = "npm run schemas:release"

# Flags that take no value, per cli/commandLine.ts CONTEXT_BOOLEAN_FLAGS.
BOOLEAN_FLAGS = {"--json", "--dry-run", "--help", "--recursive"}
SUBCOMMANDS = {"tools", "use", "doctor", "vaults", "playbook", "install", "uninstall"}
PLACEHOLDER = re.compile(r"[<>{}$\[\]]|\.\.\.|…")
NEXUS_LINE = re.compile(r"(?:^|[\s`(])nexus\s")


def load_catalog(explicit: str | None, start: Path) -> tuple[set[str], set[str], Path]:
    """Return (full commands, agent aliases, catalog path)."""
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    else:
        for base in [start, *start.parents]:
            candidates.append(base / CATALOG_NAME)
            candidates.append(base / CATALOG_FALLBACK)

    for candidate in candidates:
        if candidate.is_file():
            data = json.loads(candidate.read_text(encoding="utf-8"))
            commands = {
                str(tool["command"]).strip()
                for tool in data.get("tools", [])
                if isinstance(tool, dict) and tool.get("command")
            }
            aliases = {command.split(" ", 1)[0] for command in commands}
            return commands, aliases, candidate
    raise FileNotFoundError(
        f"no {CATALOG_NAME} found. Generate it with:\n  {REGEN}"
    )


def logical_lines(text: str) -> list[tuple[int, str]]:
    """Join backslash-continued lines, keeping the first line's number."""
    out: list[tuple[int, str]] = []
    buffer, start = "", 0
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.rstrip()
        if not buffer:
            start = number
        if line.endswith("\\"):
            buffer += line[:-1] + " "
            continue
        out.append((start, buffer + line))
        buffer = ""
    if buffer:
        out.append((start, buffer))
    return out


def strip_flags(tokens: list[str]) -> list[str]:
    """Drop CLI flags (and their values) from a token list."""
    out: list[str] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.startswith("--") and token != "--":
            if "=" in token or token in BOOLEAN_FLAGS:
                index += 1
            else:
                index += 2
            continue
        out.append(token)
        index += 1
    return out


def split_selector(tokens: list[str]) -> list[list[str]]:
    """Split a `nexus tools` selector, which may arrive as one quoted string.

    `nexus tools "storage list, content read"` is a single shlex token, so the
    comma split has to happen inside the token as well as between tokens.
    """
    joined = " ".join(tokens)
    return [segment.split() for segment in joined.split(",") if segment.split()]


def split_commands(tokens: list[str]) -> list[list[str]]:
    """Split a token list on the trailing-comma command separator."""
    commands: list[list[str]] = [[]]
    for token in tokens:
        if token.endswith(",") and len(token) > 1:
            commands[-1].append(token[:-1])
            commands.append([])
        elif token == ",":
            commands.append([])
        else:
            commands[-1].append(token)
    return [c for c in commands if c]


def invocations(line: str) -> list[str]:
    """Return each `nexus …` command text on the line, prose trimmed off.

    Docs put commands inline in backticks and in help tables where two or more
    spaces start a comment column. Cutting at the closing backtick and at the
    first run of two spaces keeps the surrounding prose from being parsed as
    arguments.
    """
    found: list[str] = []
    for match in NEXUS_LINE.finditer(line):
        segment = line[match.start():].lstrip("`$ ")
        segment = segment.split("`", 1)[0]
        segment = re.split(r"\s{2,}", segment)[0]
        segment = segment.split(" #", 1)[0].rstrip(".;:")
        if segment.startswith("nexus"):
            found.append(segment)
    return found


def extract(command_text: str) -> list[tuple[str, list[str]]]:
    """Return (kind, tokens) for one nexus invocation."""
    try:
        tokens = shlex.split(command_text, comments=True)
    except ValueError:
        return []
    if not tokens or tokens[0] != "nexus":
        return []

    rest = tokens[1:]
    kind: str | None = None
    cursor = 0
    while cursor < len(rest):
        token = rest[cursor]
        if token.startswith("--"):
            cursor += 1 if ("=" in token or token in BOOLEAN_FLAGS) else 2
            continue
        if token in SUBCOMMANDS:
            kind = token
            cursor += 1
        break
    if kind not in {"tools", "use"}:
        return []

    remainder = rest[cursor:]
    if kind == "use":
        if "--" not in remainder:
            return []
        remainder = remainder[remainder.index("--") + 1:]
    else:
        return [(kind, command) for command in split_selector(strip_flags(remainder))]
    return [(kind, command) for command in split_commands(remainder)]


def check_command(
    where: str, kind: str, tokens: list[str], commands: set[str], aliases: set[str]
) -> tuple[str | None, bool]:
    """Return (violation or None, counted) for one parsed command."""
    if not tokens or PLACEHOLDER.search(" ".join(tokens)):
        return None, False
    agent = tokens[0]
    if agent == "--help":
        return None, False
    tool = tokens[1] if len(tokens) > 1 and not tokens[1].startswith("-") else None

    if agent not in aliases:
        close = difflib.get_close_matches(agent, sorted(aliases), n=2)
        suggestion = " or ".join(f"'{c}'" for c in close)
        hint = f" Did you mean {suggestion}?" if close else ""
        return f"{where}: unknown agent alias '{agent}'.{hint}", True
    if tool is None:
        if kind == "use":
            return f"{where}: 'nexus use -- {agent}' names no tool", True
        return None, True

    full = f"{agent} {tool}"
    if full not in commands:
        close = difflib.get_close_matches(
            full, sorted(c for c in commands if c.startswith(agent + " ")), n=2
        )
        suggestion = " or ".join(f"'{c}'" for c in close)
        hint = f" Did you mean {suggestion}?" if close else ""
        return f"{where}: no such command '{full}'.{hint}", True
    return None, True


def check_file(path: Path, commands: set[str], aliases: set[str]) -> tuple[list[str], int, int]:
    violations: list[str] = []
    checked = skipped = 0
    for number, line in logical_lines(path.read_text(encoding="utf-8")):
        for command_text in invocations(line):
            for kind, tokens in extract(command_text):
                violation, counted = check_command(
                    f"{path}:{number}", kind, tokens, commands, aliases
                )
                if counted:
                    checked += 1
                elif tokens:
                    skipped += 1
                if violation:
                    violations.append(violation)
    return violations, checked, skipped


def gather(targets: list[str]) -> list[Path]:
    files: list[Path] = []
    for target in targets:
        path = Path(target)
        if path.is_dir():
            files.extend(sorted(path.rglob("*.md")))
        elif path.is_file():
            files.append(path)
        else:
            raise FileNotFoundError(f"no such path: {target}")
    return files


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("target", nargs="+", help="markdown file(s) or directory")
    parser.add_argument("--catalog", help=f"path to {CATALOG_NAME}")
    parser.add_argument("--verbose", action="store_true", help="report skipped templates")
    args = parser.parse_args()

    try:
        files = gather(args.target)
        commands, aliases, catalog = load_catalog(args.catalog, Path(args.target[0]).resolve())
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    violations: list[str] = []
    checked = skipped = 0
    for path in files:
        found, n_checked, n_skipped = check_file(path, commands, aliases)
        violations.extend(found)
        checked += n_checked
        skipped += n_skipped

    for violation in violations:
        print(violation)

    summary = (
        f"{checked} command(s) checked in {len(files)} file(s) "
        f"against {catalog}"
    )
    if args.verbose:
        summary += f"; {skipped} template(s) skipped"

    if violations:
        print(f"\n{len(violations)} violation(s). {summary}")
        print(f"If the catalog is stale, regenerate it:\n  {REGEN}")
        return 1
    print(f"clean: {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
