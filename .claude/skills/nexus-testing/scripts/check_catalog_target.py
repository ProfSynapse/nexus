#!/usr/bin/env python3
"""Check current schema aliases match the version selected by the manifest.

The shipped-docs tests still load the repo-root CLI alias, while release and eval
consumers resolve the versioned pair through `schemas/manifest.json`. This check
proves those paths identify the same current release. Scratch exports under
docs/generated are deliberately ignored; selectors make them valid subsets.

Checks:
  1. The manifest has a latest entry with CLI and MCP artifact paths.
  2. Both versioned artifacts and repo-root aliases parse and contain tools.
  3. Each alias exactly matches its versioned current artifact.

It compares CONTENT, not paths or timestamps, so it does not care how either
file got there.

Exit 0 when clean, 1 when an artifact is missing/malformed or aliases disagree,
2 on usage error.

Usage:
  python3 check_catalog_target.py                  # repo root inferred
  python3 check_catalog_target.py /path/to/repo
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CLI_ALIAS = "cli-first-tool-schemas.json"
MCP_ALIAS = "tool-schemas.json"
REGEN_HINT = (
    "  npm run schemas:release\n"
    "  (regeneration needs npm install, not a running vault -- see the nexus-tool-schemas skill)"
)


def infer_repo_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / "package.json").is_file():
            return candidate
    return start


def load(path: Path) -> tuple[dict | None, str | None]:
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except OSError as exc:
        return None, f"cannot read ({exc})"
    except json.JSONDecodeError as exc:
        return None, f"is not valid JSON ({exc})"


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
    args = parser.parse_args()

    root = Path(args.repo_root).resolve() if args.repo_root else infer_repo_root(
        Path(__file__).resolve().parent
    )
    problems: list[str] = []
    manifest_path = root / "schemas" / "manifest.json"
    manifest, err = load(manifest_path)
    if err or not isinstance(manifest, dict):
        problems.append(f"schemas/manifest.json:1: {err or 'is not an object'}")
    else:
        latest = manifest.get("latest")
        entry = manifest.get("versions", {}).get(latest) if isinstance(manifest.get("versions"), dict) else None
        if not isinstance(entry, dict):
            problems.append(f"schemas/manifest.json:1: latest release {latest!r} has no entry")
        else:
            for kind, alias_name in (("cli", CLI_ALIAS), ("mcp", MCP_ALIAS)):
                relative = entry.get(kind)
                versioned_path = root / "schemas" / relative if isinstance(relative, str) else None
                alias_path = root / alias_name
                if versioned_path is None:
                    problems.append(f"schemas/manifest.json:1: latest release has no {kind} path")
                    continue
                versioned, versioned_err = load(versioned_path)
                alias, alias_err = load(alias_path)
                if versioned_err:
                    problems.append(f"{versioned_path.relative_to(root)}:1: {versioned_err}")
                if alias_err:
                    problems.append(f"{alias_name}:1: {alias_err}")
                if versioned_err or alias_err:
                    continue
                if not isinstance(versioned, dict) or not isinstance(versioned.get("tools"), list):
                    problems.append(f"{versioned_path.relative_to(root)}:1: has no `tools` array")
                if alias != versioned:
                    problems.append(f"{alias_name}:1: differs from current {versioned_path.relative_to(root)}")

    if problems:
        print("\n".join(problems))
        print("\nFix: regenerate the release bundle:\n" + REGEN_HINT)
        return 1

    print("OK: current CLI and MCP schema aliases match schemas/manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
