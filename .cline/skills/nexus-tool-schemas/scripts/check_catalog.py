#!/usr/bin/env python3
"""Validate an exported Nexus CLI-first tool catalog.

The exporter prints counts and exits 0 whether or not the file it wrote is the
one anything reads, so "it ran" is not evidence. This checks the artifact
itself: the header is self-consistent with the tools array, every entry carries
the fields the consumers index on (command, usage, arguments with name/flag/
type/required/positional), commands are unique and sorted, and no tool flag ends
in a CLI transport suffix -- the collision rule is read out of cli/commandLine.ts
rather than hardcoded here, so it cannot drift from the CLI.

It also reports placement: which consumer, if any, reads the path you passed.
A catalog written to the default scratch path is a valid catalog that no test
and no shipped doc will ever see, and that is the failure worth catching early.

No tool, agent or flag names are hardcoded. Everything is derived from the file
under test and from the repo source, so this check does not rot as tools change.

Usage:
  python check_catalog.py PATH_TO_CATALOG_JSON [--repo-root PATH] [--quiet]

Exit codes:
  0  the catalog is well formed
  1  violations found
  2  usage error / unreadable file
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

CATALOG_NAME = "cli-first-tool-schemas.json"
DEFAULT_OUTPUT = Path("docs") / "generated" / CATALOG_NAME
COMMAND_LINE_REL = Path("cli") / "commandLine.ts"
TRANSPORT_RE_SRC = re.compile(
    r"TRANSPORT_FLAG_RE\s*=\s*/(?P<pattern>[^/\n]+)/", re.MULTILINE
)
HEADER_FIELDS = ("generatedAt", "selector", "toolCount", "agentCount", "agents", "tools")
ARG_FIELDS = ("name", "flag", "type", "required", "positional")
FLAG = re.compile(r"^--[a-z0-9]+(-[a-z0-9]+)*$")
COMMAND = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)* [a-z0-9]+(-[a-z0-9]+)*$")


def find_repo_root(start: Path) -> Path | None:
    """Walk up from `start` looking for the CLI source that owns the flag rule."""
    for candidate in [start, *start.parents]:
        if (candidate / COMMAND_LINE_REL).is_file():
            return candidate
    return None


def transport_pattern(repo_root: Path | None) -> tuple[re.Pattern[str] | None, str | None]:
    """Read the CLI's transport-flag regex from source. Returns (regex, note)."""
    if repo_root is None:
        return None, "repo root not found; skipped the transport-suffix check"
    source = repo_root / COMMAND_LINE_REL
    if not source.is_file():
        return None, f"{COMMAND_LINE_REL} not found under {repo_root}; skipped the transport-suffix check"
    match = TRANSPORT_RE_SRC.search(source.read_text(encoding="utf-8"))
    if not match:
        return None, f"could not read TRANSPORT_FLAG_RE from {COMMAND_LINE_REL}; skipped that check"
    try:
        return re.compile(match.group("pattern")), None
    except re.error as exc:
        return None, f"TRANSPORT_FLAG_RE is not portable to Python ({exc}); skipped that check"


def check_header(data: dict) -> list[str]:
    problems: list[str] = []
    for field in HEADER_FIELDS:
        if field not in data:
            problems.append(f"header: missing `{field}`")
    tools = data.get("tools")
    if not isinstance(tools, list):
        problems.append("header: `tools` is not an array")
        return problems
    if not tools:
        problems.append("header: `tools` is empty -- the selector matched nothing")
        return problems

    if data.get("toolCount") != len(tools):
        problems.append(f"header: toolCount {data.get('toolCount')} != {len(tools)} tools in the array")

    agents = data.get("agents")
    if isinstance(agents, dict):
        tally: dict[str, int] = {}
        for tool in tools:
            if isinstance(tool, dict) and isinstance(tool.get("agent"), str):
                tally[tool["agent"]] = tally.get(tool["agent"], 0) + 1
        if tally != agents:
            for name in sorted(set(tally) | set(agents)):
                if tally.get(name) != agents.get(name):
                    problems.append(
                        f"header: agents['{name}'] = {agents.get(name)} but the array holds {tally.get(name, 0)}"
                    )
        if data.get("agentCount") != len(agents):
            problems.append(f"header: agentCount {data.get('agentCount')} != {len(agents)} agent keys")
    else:
        problems.append("header: `agents` is not an object")
    return problems


def check_tools(tools: list, transport: re.Pattern[str] | None) -> list[str]:
    problems: list[str] = []
    seen: dict[str, int] = {}
    commands: list[str] = []

    for index, tool in enumerate(tools):
        where = f"tools[{index}]"
        if not isinstance(tool, dict):
            problems.append(f"{where}: not an object")
            continue
        command = tool.get("command")
        label = command if isinstance(command, str) and command else where

        for field in ("agent", "tool", "description", "command"):
            if not isinstance(tool.get(field), str) or not tool[field].strip():
                problems.append(f"{where}: missing or empty `{field}`")
        if not isinstance(command, str) or not command:
            continue

        commands.append(command)
        if command in seen:
            problems.append(f"{label}: duplicate command (also at tools[{seen[command]}])")
        else:
            seen[command] = index

        if not COMMAND.match(command):
            problems.append(f"{label}: command is not `<agent-alias> <tool-name>` in kebab-case")

        if not isinstance(tool.get("usage"), str) or not tool["usage"]:
            problems.append(
                f"{label}: no `usage` -- this is a COMPACT entry, so the file was not written by the exporter"
            )
        elif not tool["usage"].startswith(command):
            problems.append(f"{label}: usage does not start with the command")

        arguments = tool.get("arguments")
        if not isinstance(arguments, list):
            problems.append(f"{label}: `arguments` missing or not an array")
            continue

        flags: set[str] = set()
        for arg in arguments:
            if not isinstance(arg, dict):
                problems.append(f"{label}: an argument entry is not an object")
                continue
            missing = [f for f in ARG_FIELDS if f not in arg]
            if missing:
                problems.append(f"{label}: argument `{arg.get('name', '?')}` missing {', '.join(missing)}")
                continue
            flag = arg["flag"]
            if flag == "--":
                problems.append(
                    f"{label}: argument `{arg['name']}` advertises the bare flag `--` -- its name "
                    "kebab-cased to nothing (toKebabCase strips a trailing Manager/Agent/Tools). "
                    "`--` is the CLI's own separator, and flag lookup takes the first match, so a "
                    "second such argument is unreachable. Rename the parameter in the tool's schema."
                )
                continue
            if not isinstance(flag, str) or not FLAG.match(flag):
                problems.append(f"{label}: argument `{arg['name']}` flag `{flag}` is not a kebab-case long option")
                continue
            if flag in flags:
                problems.append(f"{label}: duplicate flag {flag}")
            flags.add(flag)
            if not isinstance(arg["required"], bool) or not isinstance(arg["positional"], bool):
                problems.append(f"{label}: {flag} has a non-boolean required/positional")
            if transport is not None and transport.match(flag[2:]):
                problems.append(
                    f"{label}: flag {flag} collides with a CLI content transport suffix; "
                    "the CLI would hydrate it away before the server saw it -- rename the argument"
                )

    if commands != sorted(commands):
        problems.append("tools: not sorted by command -- the exporter sorts, so this file was edited or merged")
    return problems


def placement_note(target: Path, repo_root: Path | None) -> str:
    resolved = target.resolve()
    if repo_root is not None and resolved == (repo_root / CATALOG_NAME).resolve():
        return "placement: repo-root catalog -- this is the file the drift and shipped-guidance tests read."
    if repo_root is not None and resolved == (repo_root / DEFAULT_OUTPUT).resolve():
        return (
            "placement: the exporter's default scratch path. It is gitignored and no test or shipped doc "
            f"reads it. To refresh the real catalog:\n"
            f"  npm run schemas:tools -- --output {CATALOG_NAME}"
        )
    return f"placement: {resolved} is not a path any consumer reads; treat this export as scratch."


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("catalog", help="path to an exported catalog JSON file")
    parser.add_argument("--repo-root", help="repo root (default: found by walking up from the catalog)")
    parser.add_argument("--quiet", action="store_true", help="suppress the placement note on success")
    args = parser.parse_args()

    target = Path(args.catalog)
    if not target.is_file():
        print(f"error: no such file: {target}", file=sys.stderr)
        return 2
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        print(f"error: {target} is not readable JSON: {exc}", file=sys.stderr)
        return 2
    if not isinstance(data, dict):
        print(f"error: {target} is not a catalog object", file=sys.stderr)
        return 2

    repo_root = Path(args.repo_root) if args.repo_root else find_repo_root(target.resolve().parent)
    transport, note = transport_pattern(repo_root)
    if note:
        print(f"note: {note}")

    problems = check_header(data)
    tools = data.get("tools")
    if isinstance(tools, list) and tools:
        problems.extend(check_tools(tools, transport))

    for problem in problems:
        print(f"{target}: {problem}")

    if problems:
        print(f"\n{len(problems)} violation(s)")
        return 1

    print(f"clean: {data.get('toolCount')} tools across {data.get('agentCount')} agents, selector {data.get('selector')!r}")
    if not args.quiet:
        print(placement_note(target, repo_root))
    return 0


if __name__ == "__main__":
    sys.exit(main())
