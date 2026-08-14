#!/usr/bin/env python3
"""Walk the static import graph from the plugin entry and report what mobile init loads.

The crash class this exists for: Nexus ships `isDesktopOnly: false`, so `main.js`
runs on phones where Node built-ins do not exist. A *static* `import` executes
during module init, before any `Platform.isDesktop` check, so a top-level import
of a Node built-in — or of an npm package that pulls one in — kills the plugin at
launch. The same import is harmless in a module nothing loads at startup, which is
why grep cannot answer this question and reachability can: the property that keeps
the tree safe is a shape of the import graph, and any new import can change it.

What the script decides (mechanical, stable):
  * which modules are reachable from the entry through static imports only
    (`await import()` defers init, so dynamic edges are NOT followed);
  * whether any reachable module statically imports a Node built-in.

What it hands to you instead of deciding (judgment):
  * the npm packages on that reachable graph. Whether a package drags Node in is
    a fact about published bytes, not about this repo, so the script lists them
    and protocols/vet-a-dependency.md tells you how to check one.

Stdlib only. Does NOT require node_modules — it never resolves package internals.

Usage:
  python check_mobile_imports.py [REPO_ROOT]
  python check_mobile_imports.py --trace src/server/MCPServer.ts
  python check_mobile_imports.py --packages
  python check_mobile_imports.py --json

Exit codes:
  0  no reachable Node built-in import
  1  violations found
  2  usage error
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import deque
from pathlib import Path

# Node core module names. A language-owned enum, not a curated list of
# real-world things: it changes only when Node adds a core module.
NODE_BUILTINS = {
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
    "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
    "events", "fs", "http", "http2", "https", "inspector", "module", "net",
    "os", "path", "perf_hooks", "process", "punycode", "querystring",
    "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls",
    "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads",
    "zlib",
}

# Provided by the Obsidian runtime and marked external in the esbuild config, so
# they never resolve to Node code in main.js.
HOST_PROVIDED_PREFIXES = ("obsidian", "electron", "@codemirror/")

SOURCE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
RESOLVE_SUFFIXES = (".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs")

# `import ... from '<spec>'` / `export ... from '<spec>'`, allowing the binding
# list to span lines. The body may not contain `;`, which keeps the non-greedy
# match from leaping across statements into an unrelated `from` in a string.
FROM_IMPORT = re.compile(
    r"(?:^|\n)[ \t]*(?P<kw>import|export)\b(?P<body>[^;]{0,600}?)\bfrom[ \t\r\n]*"
    r"(?P<q>['\"])(?P<spec>[^'\"]+)(?P=q)"
)
# Side-effect import: `import '<spec>'`.
BARE_IMPORT = re.compile(
    r"(?:^|\n)[ \t]*import[ \t]+(?P<q>['\"])(?P<spec>[^'\"]+)(?P=q)"
)


def blank_comments(text: str) -> str:
    """Replace comment bodies with spaces, preserving length and newlines.

    String-aware, so a `//` inside a quoted path is not mistaken for a comment.
    Offsets stay valid, so line numbers computed on the result are real.
    """
    out = list(text)
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in "'\"`":
            quote, i = c, i + 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == quote:
                    i += 1
                    break
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                out[i], i = " ", i + 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            while i < n and not (text[i] == "*" and i + 1 < n and text[i + 1] == "/"):
                if text[i] != "\n":
                    out[i] = " "
                i += 1
            for j in range(i, min(i + 2, n)):
                out[j] = " "
            i += 2
            continue
        i += 1
    return "".join(out)


def is_type_only(kw: str, body: str) -> bool:
    """True when the statement is erased before it can execute.

    `import type` / `export type` never emit. A brace list whose every specifier
    is `type`-prefixed is elided too, and there is no default or namespace
    binding to keep it alive.
    """
    body = body.strip()
    if body.startswith("type ") or body == "type":
        return True
    if not body.startswith("{") or not body.rstrip().endswith("}"):
        return False
    inner = body.strip()[1:-1].strip()
    if not inner:
        return False
    return all(part.strip().startswith("type ") for part in inner.split(",") if part.strip())


def parse_imports(path: Path) -> list[tuple[str, int, bool]]:
    """Return (specifier, line, is_static) for every import statement in a file.

    Only static edges are returned; dynamic `import()` never matches these
    patterns because the statement forms require `import <bindings> from` or
    `import '<spec>'`.
    """
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    text = blank_comments(raw)
    found: list[tuple[str, int, bool]] = []
    seen: set[tuple[str, int]] = set()

    for m in FROM_IMPORT.finditer(text):
        if is_type_only(m.group("kw"), m.group("body")):
            continue
        line = text.count("\n", 0, m.start()) + 1
        key = (m.group("spec"), line)
        if key not in seen:
            seen.add(key)
            found.append((m.group("spec"), line, True))
    for m in BARE_IMPORT.finditer(text):
        line = text.count("\n", 0, m.start()) + 1
        key = (m.group("spec"), line)
        if key not in seen:
            seen.add(key)
            found.append((m.group("spec"), line, True))
    return found


def builtin_name(spec: str) -> str | None:
    """Return the Node core module a specifier names, or None."""
    base = spec[5:] if spec.startswith("node:") else spec
    base = base.split("/", 1)[0]
    return base if base in NODE_BUILTINS else None


def resolve_local(spec: str, importer: Path, src_root: Path) -> Path | None:
    """Resolve a relative or `@/`-aliased specifier to a file on disk."""
    if spec.startswith("@/"):
        base = src_root / spec[2:]
    elif spec.startswith("."):
        base = (importer.parent / spec).resolve()
    else:
        return None

    # TS source imported through its emitted `.js` specifier.
    if base.suffix in (".js", ".jsx", ".mjs", ".cjs"):
        for alt in (".ts", ".tsx"):
            cand = base.with_suffix(alt)
            if cand.is_file():
                return cand
    if base.is_file() and base.suffix in SOURCE_SUFFIXES:
        return base
    for suffix in RESOLVE_SUFFIXES:
        cand = base.with_name(base.name + suffix)
        if cand.is_file():
            return cand
    if base.is_dir():
        for suffix in RESOLVE_SUFFIXES:
            cand = base / ("index" + suffix)
            if cand.is_file():
                return cand
    return None


def walk(entry: Path, src_root: Path):
    """BFS the static import graph. Returns (parents, builtin_hits, packages)."""
    parents: dict[Path, Path | None] = {entry: None}
    builtin_hits: list[dict] = []
    packages: dict[str, list[str]] = {}
    queue: deque[Path] = deque([entry])

    while queue:
        current = queue.popleft()
        for spec, line, _static in parse_imports(current):
            node = builtin_name(spec)
            if node:
                builtin_hits.append(
                    {"file": str(current), "line": line, "specifier": spec, "builtin": node}
                )
                continue
            target = resolve_local(spec, current, src_root)
            if target is not None:
                if target not in parents:
                    parents[target] = current
                    queue.append(target)
                continue
            if spec.startswith(("http://", "https://")):
                continue
            parts = spec.split("/")
            pkg = "/".join(parts[:2]) if spec.startswith("@") else parts[0]
            packages.setdefault(pkg, [])
            entry_note = f"{current}:{line}"
            if entry_note not in packages[pkg]:
                packages[pkg].append(entry_note)
    return parents, builtin_hits, packages


def chain(parents: dict[Path, Path | None], target: Path) -> list[str]:
    """Shortest import chain from the entry down to target, as printable paths."""
    path: list[str] = []
    node: Path | None = target
    while node is not None:
        path.append(str(node))
        node = parents.get(node)
    return list(reversed(path))


def rel_site(site: str, root: Path) -> str:
    """Turn an absolute `path:line` import site into a repo-relative one."""
    head, _, tail = site.rpartition(":")
    return f"{Path(head).relative_to(root)}:{tail}"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("repo_root", nargs="?", default=".", help="repository root")
    parser.add_argument("--entry", default="src/main.ts", help="plugin entry point")
    parser.add_argument("--src", default="src", help="source root for the @/ alias")
    parser.add_argument(
        "--trace",
        metavar="PATH",
        help="report whether PATH is on the startup path and print the import chain",
    )
    parser.add_argument(
        "--packages",
        action="store_true",
        help="list the npm packages reachable from init, for dependency vetting",
    )
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    root = Path(args.repo_root).resolve()
    entry = (root / args.entry).resolve()
    src_root = (root / args.src).resolve()
    if not entry.is_file():
        print(f"error: no entry point at {entry}", file=sys.stderr)
        return 2

    parents, builtin_hits, packages = walk(entry, src_root)
    reachable = sorted(str(p.relative_to(root)) for p in parents)

    third_party = {
        pkg: sites
        for pkg, sites in packages.items()
        if not pkg.startswith(HOST_PROVIDED_PREFIXES)
    }

    if args.trace:
        target = (root / args.trace).resolve()
        on_path = target in parents
        if args.json:
            print(json.dumps({
                "target": args.trace,
                "reachable_from_init": on_path,
                "chain": [str(Path(p).relative_to(root)) for p in chain(parents, target)] if on_path else [],
            }, indent=2))
        elif on_path:
            print(f"{args.trace} IS statically reachable from {args.entry}:")
            for i, step in enumerate(chain(parents, target)):
                print(f"  {'  ' * i}{Path(step).relative_to(root)}")
            print("\nIts top-level imports run during mobile init.")
        else:
            print(f"{args.trace} is NOT statically reachable from {args.entry}.")
            print("Its top-level imports do not run at init today. That is a property")
            print("of the current graph, not of the code: one static import from a")
            print("reachable module pulls it onto the startup path.")
        return 0

    if args.json:
        print(json.dumps({
            "entry": args.entry,
            "reachable_module_count": len(reachable),
            "node_builtin_violations": [
                {**h, "file": str(Path(h["file"]).relative_to(root))} for h in builtin_hits
            ],
            "reachable_packages": {
                k: [rel_site(s, root) for s in v] for k, v in sorted(third_party.items())
            },
            "host_provided": sorted(p for p in packages if p.startswith(HOST_PROVIDED_PREFIXES)),
        }, indent=2))
        return 1 if builtin_hits else 0

    for hit in builtin_hits:
        rel = Path(hit["file"]).relative_to(root)
        print(f"{rel}:{hit['line']}: static import of Node built-in '{hit['specifier']}' "
              f"on the startup path — crashes the plugin at init on mobile")
        for i, step in enumerate(chain(parents, Path(hit["file"]))):
            print(f"    {'  ' * i}{Path(step).relative_to(root)}")

    if args.packages or not builtin_hits:
        print(f"\n{len(reachable)} modules statically reachable from {args.entry}.")
        if third_party:
            print("\nnpm packages on the startup path — each must be browser-safe "
                  "(see protocols/vet-a-dependency.md):")
            for pkg, sites in sorted(third_party.items()):
                print(f"  {pkg}")
                for site in sites[:3]:
                    print(f"      {rel_site(site, root)}")
                if len(sites) > 3:
                    print(f"      ... and {len(sites) - 3} more import site(s)")
        else:
            print("\nNo third-party packages on the startup path.")

    if builtin_hits:
        print(f"\n{len(builtin_hits)} violation(s)")
        return 1
    print("\nclean: no Node built-in is statically reachable from init")
    return 0


if __name__ == "__main__":
    sys.exit(main())
