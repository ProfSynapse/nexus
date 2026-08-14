#!/usr/bin/env python3
"""Check that the schema exporter can see every agent the plugin registers.

scripts/generate-tool-schemas.mjs builds its registry by constructing agent
classes by hand. An agent the plugin registers but that list omits produces no
error and no empty section -- it is simply absent from every export, and from
the catalog the shipped-docs gate validates against. The symptom surfaces later
and somewhere else, as a drift-test failure or a doc that "names a tool that
does not exist".

This compares the classes constructed in the exporter against the classes
constructed in the plugin's own registration sites. Both sides are read from
source; nothing is hardcoded but the file paths, and a missing path fails loudly
rather than passing vacuously.

The tool manager agent is excluded: discovery filters it out of the registry, so
it is correctly absent from the exporter.

Usage:
  python check_exporter_coverage.py [--repo-root PATH]

Exit codes:
  0  the exporter covers every registered agent
  1  an agent is missing from one side
  2  usage error, or a source file has moved
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

EXPORTER = Path("scripts") / "generate-tool-schemas.mjs"
REGISTRATION_SITES = (
    Path("src") / "services" / "agent" / "AgentInitializationService.ts",
    Path("src") / "services" / "apps" / "AppManager.ts",
)
CONSTRUCTED = re.compile(r"\bnew\s+([A-Z][A-Za-z0-9]*Agent)\s*\(")
EXCLUDED = {"ToolManagerAgent"}


def find_repo_root(start: Path) -> Path | None:
    for candidate in [start, *start.parents]:
        if (candidate / EXPORTER).is_file():
            return candidate
    return None


def constructed_in(path: Path) -> set[str]:
    return set(CONSTRUCTED.findall(path.read_text(encoding="utf-8"))) - EXCLUDED


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--repo-root", help="repo root (default: found by walking up from this script)")
    args = parser.parse_args()

    root = Path(args.repo_root) if args.repo_root else find_repo_root(Path(__file__).resolve().parent)
    if root is None or not (root / EXPORTER).is_file():
        print(f"error: could not find {EXPORTER}; pass --repo-root", file=sys.stderr)
        return 2

    missing_sources = [rel for rel in REGISTRATION_SITES if not (root / rel).is_file()]
    if missing_sources:
        for rel in missing_sources:
            print(f"error: registration source not found: {rel}", file=sys.stderr)
        print("Registration moved. Update REGISTRATION_SITES in this script before trusting it.", file=sys.stderr)
        return 2

    exported = constructed_in(root / EXPORTER)
    registered: set[str] = set()
    for rel in REGISTRATION_SITES:
        registered |= constructed_in(root / rel)

    problems: list[str] = []
    for name in sorted(registered - exported):
        problems.append(
            f"{EXPORTER}: {name} is registered by the plugin but never constructed here -- "
            "its tools are silently absent from every export. Add it to instantiateAgents()."
        )
    for name in sorted(exported - registered):
        problems.append(
            f"{EXPORTER}: {name} is constructed here but no registration site constructs it -- "
            "the export advertises tools the plugin may no longer expose."
        )

    for problem in problems:
        print(problem)
    if problems:
        print(f"\n{len(problems)} violation(s)")
        return 1

    print(f"clean: {len(exported)} agent classes, exporter and registration agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
