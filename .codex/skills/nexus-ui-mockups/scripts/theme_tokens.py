#!/usr/bin/env python3
"""Extract the CSS custom properties Nexus production styling relies on.

A mockup under docs/mockups/ is standalone: it loads neither Obsidian's
stylesheet nor the plugin's styles.css, so every variable production inherits has
to be declared in the mockup's own :root or it renders as nothing. This script
reads the current styles.css and splits its variables into the two groups a
mockup author needs, so the list is derived from the tree instead of being
copied into a document that rots.

  inherited     used by production, defined nowhere in styles.css. Mostly
                Obsidian theme tokens; a few are set on an element at runtime by
                the plugin's TypeScript. Declare all of them in the mockup with
                values approximating Obsidian's default theme.
  nexus-defined declared in styles.css itself (the --space-* scale, the --glass-*
                material tokens). Copy these verbatim so spacing and material
                match what production will produce.

Usage:
  python3 theme_tokens.py                    # both groups, names only
  python3 theme_tokens.py --emit             # nexus-defined printed as CSS
  python3 theme_tokens.py --group inherited
  python3 theme_tokens.py path/to/styles.css

Run from the repo root; the default target is ./styles.css.

Exit codes:
  0  printed
  2  usage error / target missing
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

VAR_USE = re.compile(r"var\(\s*(--[A-Za-z0-9_-]+)")
VAR_DEF = re.compile(r"(--[A-Za-z0-9_-]+)\s*:")


def declaration_at(text: str, start: int) -> str:
    """Return the full declaration beginning at `start`, up to its terminating
    semicolon at paren depth zero. Values such as --glass-backdrop span several
    lines and contain nested parentheses, so a naive split on ';' truncates."""
    depth = 0
    for i in range(start, len(text)):
        ch = text[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == ";" and depth == 0:
            return text[start:i + 1]
    return text[start:].strip()


def collect(css: str) -> tuple[list[str], dict[str, str]]:
    used = {m.group(1) for m in VAR_USE.finditer(css)}
    defined: dict[str, str] = {}
    for m in VAR_DEF.finditer(css):
        name = m.group(1)
        if name not in defined:
            defined[name] = " ".join(declaration_at(css, m.start()).split())
    inherited = sorted(used - set(defined))
    return inherited, dict(sorted(defined.items()))


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "target", nargs="?", default="styles.css",
        help="stylesheet to read (default: ./styles.css)",
    )
    parser.add_argument(
        "--group", choices=["inherited", "nexus", "both"], default="both",
        help="which group to print (default: both)",
    )
    parser.add_argument(
        "--emit", action="store_true",
        help="print the nexus-defined group as pasteable CSS declarations",
    )
    args = parser.parse_args()

    target = Path(args.target)
    if not target.is_file():
        print(f"error: no such file: {target} (run from the repo root)", file=sys.stderr)
        return 2

    inherited, defined = collect(target.read_text(encoding="utf-8", errors="replace"))

    if args.group in ("inherited", "both"):
        print(f"# inherited — declare these in the mockup's :root ({len(inherited)})")
        for name in inherited:
            print(f"  {name}")
        print()

    if args.group in ("nexus", "both"):
        print(f"# nexus-defined in {target} — copy verbatim ({len(defined)})")
        if args.emit:
            print(":root {")
            for decl in defined.values():
                print(f"  {decl}")
            print("}")
        else:
            for name in defined:
                print(f"  {name}")

    print(
        "\nNEXT: declare the inherited group with Obsidian default-theme values, "
        "paste the nexus-defined group, then validate with:\n"
        "  python3 .claude/skills/nexus-ui-mockups/scripts/check_mockup.py docs/mockups/<name>.html"
    )
    return 0


if __name__ == "__main__":
    try:
        code = main()
        sys.stdout.flush()
    except BrokenPipeError:
        # Piping into `head` closes the pipe early; do not spew a traceback.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        code = 0
    sys.exit(code)
