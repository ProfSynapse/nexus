#!/usr/bin/env python3
"""Check a Nexus UI mockup for the failures a browser hides.

Mockups under docs/mockups/ are outside every automated check in this repo:
eslint ignores docs/, the plugin bundle never includes it, and no test opens
them. This script covers the mechanical part of that gap. It does not judge the
design — only whether the page can render standalone and follows the folder's
naming and theming conventions.

Errors (exit 1):
  - a var(--x) with no fallback whose custom property is defined nowhere in the
    mockup's own files: the declaration is dropped and the page renders wrong
  - a local <link>/<script>/<img> asset that does not resolve on disk
  - an asset loaded from the network: a mockup must render offline
  - a filename that is not kebab-case

Warnings (do not fail):
  - no light/dark story: production carries body.theme-light overrides, so a
    dark-only mockup leaves the light palette to be improvised later
  - color literals in ordinary declarations rather than in a custom property; a
    few (shadows, overlays) are normal, a pile of them means the mockup invented
    a palette instead of using theme tokens
  - a .css/.js file in the folder that no mockup page references

Usage:
  python3 check_mockup.py                          # all of docs/mockups
  python3 check_mockup.py docs/mockups/foo.html
  python3 check_mockup.py docs/mockups --quiet-next

Run from the repo root.

Exit codes:
  0  clean (warnings allowed)
  1  errors found
  2  usage error
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

VAR_USE = re.compile(r"var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?")
VAR_DEF = re.compile(r"(--[A-Za-z0-9_-]+)\s*:")
LINK = re.compile(r"""<link\b[^>]*?href\s*=\s*["']([^"']+)["']""", re.I)
SRC = re.compile(r"""<(?:script|img)\b[^>]*?src\s*=\s*["']([^"']+)["']""", re.I)
CSS_IMPORT = re.compile(r"""@import\s+(?:url\()?["']([^"']+)["']""", re.I)
KEBAB_FILE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*\.(html|css|js)$")
COLOR_DECL = re.compile(
    r"(^|[;{\s])(color|background|background-color|border|border-color|fill|stroke)"
    r"\s*:\s*([^;{}]+)"
)
COLOR_LITERAL = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d")
THEME_HOOK = re.compile(r"theme-light|prefers-color-scheme|data-theme", re.I)
REMOTE = re.compile(r"^(?:https?:)?//", re.I)


def show(path: Path) -> str:
    """Path as typed where possible, so output is copy-pasteable."""
    try:
        return str(path.resolve().relative_to(Path.cwd()))
    except ValueError:
        return str(path)


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, path: Path, line: int, message: str) -> None:
        self.errors.append(f"{show(path)}:{line}: {message}")

    def warn(self, path: Path, line: int, message: str) -> None:
        self.warnings.append(f"{show(path)}:{line}: {message}")


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def asset_refs(text: str) -> list[tuple[str, int]]:
    refs = []
    for pattern in (LINK, SRC, CSS_IMPORT):
        for m in pattern.finditer(text):
            refs.append((m.group(1).strip(), m.start()))
    return refs


def check_page(page: Path, report: Report) -> None:
    """Check one mockup entry page together with the assets it pulls in."""
    text = read(page)
    group: dict[Path, str] = {page: text}

    for ref, pos in asset_refs(text):
        if ref.startswith(("data:", "#")):
            continue
        if REMOTE.match(ref):
            report.error(page, line_of(text, pos),
                         f"asset loaded from the network ({ref}); mockups must render offline")
            continue
        target = (page.parent / ref).resolve()
        if not target.exists():
            report.error(page, line_of(text, pos), f"asset does not resolve: {ref}")
        elif target not in group:
            group[target] = read(target)

    defined: set[str] = set()
    for content in group.values():
        defined.update(m.group(1) for m in VAR_DEF.finditer(content))

    seen: set[tuple[Path, str]] = set()
    for path, content in group.items():
        for m in VAR_USE.finditer(content):
            name, fallback = m.group(1), m.group(2)
            if fallback or name in defined or (path, name) in seen:
                continue
            seen.add((path, name))
            report.error(path, line_of(content, m.start()),
                         f"var({name}) is used but never defined in this mockup; "
                         f"the declaration is dropped at render time")

    if not any(THEME_HOOK.search(c) for c in group.values()):
        report.warn(page, 1, "no light/dark story (no theme-light, prefers-color-scheme "
                             "or data-theme); production has light-theme overrides")

    for path, content in group.items():
        if path.suffix not in {".html", ".css"}:
            continue
        hits = [m for m in COLOR_DECL.finditer(content) if COLOR_LITERAL.search(m.group(3))]
        if hits:
            report.warn(path, line_of(content, hits[0].start(2)),
                        f"{len(hits)} color literal(s) in ordinary declarations "
                        f"(first here); a few overlays and shadows are normal, "
                        f"a pile means the mockup invented a palette instead of "
                        f"using theme tokens")


def kebab_check(path: Path, report: Report) -> None:
    if not KEBAB_FILE.match(path.name):
        report.error(path, 1, "filename should be lowercase kebab-case (.html/.css/.js)")


def check_directory(directory: Path, report: Report) -> None:
    pages = sorted(directory.glob("*.html"))
    if not pages:
        print(f"error: no .html mockups found in {directory}", file=sys.stderr)
        raise SystemExit(2)

    referenced: set[Path] = set()
    for page in pages:
        kebab_check(page, report)
        check_page(page, report)
        for ref, _ in asset_refs(read(page)):
            if not REMOTE.match(ref) and not ref.startswith(("data:", "#")):
                referenced.add((page.parent / ref).resolve())

    for asset in sorted(directory.iterdir()):
        if asset.suffix not in {".css", ".js"}:
            continue
        kebab_check(asset, report)
        if asset.resolve() not in referenced:
            report.warn(asset, 1, "no mockup page references this file")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("target", nargs="?", default="docs/mockups",
                        help="a mockup .html file or the mockups directory "
                             "(default: docs/mockups)")
    parser.add_argument("--quiet-next", action="store_true",
                        help="suppress the hand-off printed on success")
    args = parser.parse_args()

    target = Path(args.target)
    if not target.exists():
        print(f"error: no such path: {target} (run from the repo root)", file=sys.stderr)
        return 2

    report = Report()
    if target.is_dir():
        check_directory(target, report)
    elif target.suffix == ".html":
        kebab_check(target, report)
        check_page(target, report)
    else:
        print(f"error: expected a .html mockup or a directory, got {target}", file=sys.stderr)
        return 2

    for line in report.errors:
        print(f"ERROR {line}")
    for line in report.warnings:
        print(f"warn  {line}")

    if report.errors:
        print(f"\n{len(report.errors)} error(s), {len(report.warnings)} warning(s)")
        return 1

    print(f"\nclean: 0 errors, {len(report.warnings)} warning(s)")
    if not args.quiet_next:
        print("NEXT: a clean checker is not a reviewed mockup. Serve it and get eyes on it:\n"
              "  node scripts/serve-mockups.mjs <name>.html\n"
              "Then follow .claude/skills/nexus-ui-mockups/references/handoff.md")
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
