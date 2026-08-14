#!/usr/bin/env python3
"""List the commands a model is told to use but is graded for using.

The eval system prompt is the production one: fixtures/system-prompt.ts feeds a
tool catalog through the real SystemPromptBuilder, so the model is told about
every agent in that catalog. The mock executor, however, only knows the domain
tools defined in fixtures/tools.ts. A command in the first list and not the
second is a trap: the model does exactly what its system prompt says, the
executor cannot resolve the command to a known tool, and the hallucination
assertion fails the scenario with "not in the defined tool set".

Run this before attributing any `Hallucinated tool call` failure. If the command
in the failure appears below, the model was obeying its prompt and the failure
belongs to the harness, not the model.

This answers a grading question only. Whether a *scenario* is satisfiable is a
harness question — use `nexus-eval-harness/scripts/check_scenarios.py` for that.

Usage:
  python check_advertised_tools.py [--repo PATH] [--quiet-ok]

Exit codes:
  0  ran successfully (gaps, if any, are printed — a gap is a fact to know, not
     a defect to fail on)
  2  usage error, or a fixture file could not be found
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

TOOLS_REL = Path("tests/eval/fixtures/tools.ts")
PROMPT_REL = Path("tests/eval/fixtures/system-prompt.ts")
EXECUTOR_REL = Path("tests/eval/EvalToolExecutor.ts")

NAME_RE = re.compile(r"name:\s*'([A-Za-z0-9_]+)'")
CATALOG_ENTRY_RE = re.compile(r"\{\s*agent:\s*'([A-Za-z0-9_]+)'\s*,\s*tools:\s*\[([^\]]*)\]")
QUOTED_RE = re.compile(r"'([^']+)'")
SUFFIX_STRIP_RE = re.compile(r"\.replace\(\s*/([A-Za-z]+)\$/i\s*,\s*''\s*\)")


def find_repo_root(start: Path) -> Path | None:
    for candidate in [start, *start.parents]:
        if (candidate / TOOLS_REL).is_file():
            return candidate
    return None


def read_const_block(source: str, const_name: str) -> str:
    """Return the text of `export const NAME ...` up to the next export."""
    start = source.find(f"export const {const_name}")
    if start == -1:
        return ""
    nxt = source.find("export const ", start + 1)
    return source[start:] if nxt == -1 else source[start:nxt]


def load_kebab_suffixes(repo: Path) -> list[str]:
    """Read the suffixes stripped before kebab-casing, from the executor itself.

    Reading them out of toKebabCase in EvalToolExecutor.ts means this script
    cannot drift from the transform that decides what the model types.
    """
    path = repo / EXECUTOR_REL
    if not path.is_file():
        return ["Manager", "Agent"]
    body = path.read_text(encoding="utf-8")
    start = body.find("function toKebabCase")
    if start == -1:
        return ["Manager", "Agent"]
    end = body.find("\n}", start)
    return SUFFIX_STRIP_RE.findall(body[start:end]) or ["Manager", "Agent"]


def kebab(value: str, suffixes: list[str]) -> str:
    for suffix in suffixes:
        if value.lower().endswith(suffix.lower()):
            value = value[: -len(suffix)]
            break
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", value)
    value = re.sub(r"[_\s]+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    return value.lower()


def cli_form(function_name: str, suffixes: list[str]) -> str:
    agent, _, tool = function_name.partition("_")
    return f"{kebab(agent, suffixes)} {kebab(tool, suffixes)}".strip()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="List commands the eval system prompt advertises that the mock executor cannot run.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--repo", default=".", help="repo root (default: search upward from cwd)")
    parser.add_argument("--quiet-ok", action="store_true", help="print nothing when there is no gap")
    args = parser.parse_args()

    repo = find_repo_root(Path(args.repo).resolve())
    if repo is None:
        print(f"error: {TOOLS_REL} not found from {Path(args.repo).resolve()}", file=sys.stderr)
        return 2

    prompt_path = repo / PROMPT_REL
    if not prompt_path.is_file():
        print(f"error: {PROMPT_REL} not found", file=sys.stderr)
        return 2

    domain = set(NAME_RE.findall(read_const_block((repo / TOOLS_REL).read_text(encoding="utf-8"), "NEXUS_TOOLS")))
    if not domain:
        print(f"error: could not read NEXUS_TOOLS from {TOOLS_REL}", file=sys.stderr)
        return 2

    suffixes = load_kebab_suffixes(repo)
    catalog_block = read_const_block(prompt_path.read_text(encoding="utf-8"), "DEFAULT_TOOL_CATALOG")
    if not catalog_block:
        print(f"error: could not read DEFAULT_TOOL_CATALOG from {PROMPT_REL}", file=sys.stderr)
        return 2

    gaps: list[tuple[str, list[str]]] = []
    advertised = 0
    for agent, tools_blob in CATALOG_ENTRY_RE.findall(catalog_block):
        commands = QUOTED_RE.findall(tools_blob)
        advertised += len(commands)
        absent = [cli_form(f"{agent}_{tool}", suffixes) for tool in commands if f"{agent}_{tool}" not in domain]
        if absent:
            gaps.append((agent, absent))

    if not gaps:
        if not args.quiet_ok:
            print(f"No gap: all {advertised} advertised command(s) are backed by a fixture tool.")
        return 0

    total = sum(len(absent) for _, absent in gaps)
    print(f"{total} of {advertised} advertised command(s) have no fixture tool behind them.")
    print("A model that calls one of these is graded as hallucinating:\n")
    for agent, absent in gaps:
        print(f"  {agent}:")
        for command in absent:
            print(f"    {command}")
    print("\nAttribute any `Hallucinated tool call` naming one of these as harness-artifact.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
