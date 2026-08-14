#!/usr/bin/env python3
"""Check the generated tool catalog landed where the shipped-docs gate reads it.

Why this exists: `scripts/generate-tool-schemas.mjs` writes to
docs/generated/cli-first-tool-schemas.json by DEFAULT, but
tests/unit/shippedGuidanceCommands.test.ts and
tests/unit/ToolManagerCliSyntax.test.ts both load the REPO-ROOT
cli-first-tool-schemas.json. Regenerating without --output therefore produces a
fresh catalog that the gate never sees, and the failure looks identical to the
one you just tried to fix. This is the single most repeated confusion in that
workflow, and it is mechanical, so it is a script rather than a paragraph.

Checks:
  1. The repo-root catalog exists and parses as JSON with a `tools` array.
  2. If a catalog also exists under the generator's default output directory,
     its content matches the repo-root one. A mismatch means a regeneration
     landed at the default path.

It compares CONTENT, not paths or timestamps, so it does not care how either
file got there.

Exit 0 when clean, 1 when the catalog is missing/malformed or the two copies
disagree, 2 on usage error.

Usage:
  python3 check_catalog_target.py                  # repo root inferred
  python3 check_catalog_target.py /path/to/repo
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CATALOG_NAME = "cli-first-tool-schemas.json"
DEFAULT_OUTPUT_DIR = Path("docs") / "generated"
REGEN_HINT = (
    "  node scripts/generate-tool-schemas.mjs --output " + CATALOG_NAME + "\n"
    "  (regeneration needs a running vault -- see the nexus-tool-schemas skill)"
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
    gate_path = root / CATALOG_NAME
    generated_path = root / DEFAULT_OUTPUT_DIR / CATALOG_NAME

    problems: list[str] = []

    if not gate_path.is_file():
        problems.append(
            f"{CATALOG_NAME}:1: missing at the repo root -- the shipped-docs gate "
            f"loads this file and cannot run without it"
        )
        print("\n".join(problems))
        print("\nFix: regenerate to the path the gate reads:\n" + REGEN_HINT)
        return 1

    gate_data, err = load(gate_path)
    if err:
        problems.append(f"{CATALOG_NAME}:1: {err}")
    elif not isinstance(gate_data, dict) or not isinstance(gate_data.get("tools"), list):
        problems.append(f"{CATALOG_NAME}:1: has no `tools` array -- not a tool catalog")

    if generated_path.is_file():
        gen_data, gen_err = load(generated_path)
        rel_gen = generated_path.relative_to(root)
        if gen_err:
            problems.append(f"{rel_gen}:1: {gen_err}")
        elif gen_data != gate_data:
            problems.append(
                f"{rel_gen}:1: differs from the repo-root {CATALOG_NAME} -- a "
                f"regeneration landed at the generator's DEFAULT path, which the "
                f"shipped-docs gate does not read"
            )

    if problems:
        print("\n".join(problems))
        print("\nFix: regenerate to the path the gate reads:\n" + REGEN_HINT)
        return 1

    tool_count = len(gate_data["tools"])  # type: ignore[index]
    print(f"OK: repo-root {CATALOG_NAME} is the catalog the gate reads ({tool_count} tools)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
