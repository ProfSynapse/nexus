#!/usr/bin/env python3
"""Check Nexus provider model registries for the mistakes TypeScript cannot catch.

A `ModelSpec` is a plain object literal, so the compiler proves the fields are
present and typed. It proves nothing about the things that actually break:

  * a `provider:` value that does not match the directory it lives in -- the
    aggregators label the model from the field, not the key, so it lands under
    the wrong provider in the picker;
  * a `*_DEFAULT_MODEL` pointing at an id no entry in that file declares --
    nothing throws, the provider just defaults to a model that does not exist;
  * an adapter constructor hard-coding a default model literal that has drifted
    from the registry's default -- two sources of truth, silently disagreeing;
  * a registry wired into one aggregator but not the other -- `ModelRegistry`
    drives cost and `listModels`, `StaticModelsService` drives the model picker,
    and a registry in only one is half-visible;
  * a duplicate `apiName` inside one registry -- lookup returns the first match,
    so the second entry is unreachable unless the provider's `findModel` has an
    explicit disambiguation rule.

Every provider, registry and model id is discovered from the tree. This script
hardcodes no model list, no price and no provider name, so it cannot rot as
models come and go -- which is the whole point, since the subject is a list that
changes weekly.

Usage:
  # Gate: check every registry. Non-zero exit on any error.
  python3 check_model_registry.py --repo-root .

  # Scope to the provider(s) you touched.
  python3 check_model_registry.py --repo-root . openai openrouter

  # Also gate on warnings (variant pairs, half-wired registries).
  python3 check_model_registry.py --repo-root . --strict

  # Inventory: what the tree currently declares, no checking.
  python3 check_model_registry.py --repo-root . --list

Exit codes:
  0  clean (or --list)
  1  errors found (warnings too, under --strict)
  2  usage error
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ADAPTERS_SUBDIR = Path("src/services/llm/adapters")
MODEL_REGISTRY = ADAPTERS_SUBDIR / "ModelRegistry.ts"
STATIC_MODELS = Path("src/services/StaticModelsService.ts")
TYPES_SUBDIR = Path("src/types")

# The provider/model pair a fresh install starts on, declared in the settings
# defaults. It is a fourth place a "default model" is written and nothing else
# checks it against the registries.
SHIPPED_DEFAULT = re.compile(
    r"\bdefaultModel\s*:\s*\{\s*provider\s*:\s*'([^']*)'\s*,\s*model\s*:\s*'([^']*)'"
)

# `export const FOO_MODELS: ModelSpec[] = [` -- the exact declared type matters.
# Files using a provider-specific spec type (WebLLM) are a different contract and
# are deliberately out of scope.
REGISTRY_DECL = re.compile(
    r"export\s+const\s+([A-Z0-9_]+)\s*:\s*ModelSpec\[\]\s*=\s*\["
)
DEFAULT_DECL = re.compile(r"export\s+const\s+([A-Z0-9_]+_DEFAULT_MODEL)\s*=\s*'([^']*)'")

# Second positional argument of a `super(...)` call, when it is a string literal.
SUPER_LITERAL = re.compile(r"\bsuper\s*\(\s*[^,()]+,\s*'([^']*)'")

# Adapters for non-chat modalities carry their own model literals and are not
# governed by the chat registry default.
NON_CHAT_ADAPTER = re.compile(
    r"(Image|Transcription|Speech|Video|Realtime)Adapter\.ts$"
)

# A URL whose path ends at `/models` -- a model *listing* endpoint. A provider
# whose adapter calls one refreshes its catalog at runtime, which makes the
# static registry a fallback rather than the source of truth, so shape problems
# in it are warnings rather than errors. Detected structurally so no provider
# name is hardcoded. `/models/{id}:generateContent` (a per-model call, not a
# listing) does not match.
DISCOVERY_ENDPOINT = re.compile(r"""['"`][^'"`\s]*/models(\?[^'"`]*)?['"`]""")

REQUIRED_FIELDS = (
    "provider",
    "name",
    "apiName",
    "contextWindow",
    "maxTokens",
    "inputCostPerMillion",
    "outputCostPerMillion",
    "capabilities",
)
REQUIRED_CAPABILITIES = (
    "supportsJSON",
    "supportsImages",
    "supportsFunctions",
    "supportsStreaming",
    "supportsThinking",
)


def strip_trailing_comment(value: str) -> str:
    """Drop a `//` line comment that is outside single quotes.

    Registry entries routinely carry a trailing note after the value
    (`apiName: 'x', // real slug`), and a naive read swallows it.
    """
    in_quote = False
    for i, ch in enumerate(value):
        if ch == "'":
            in_quote = not in_quote
        elif ch == "/" and not in_quote and value[i : i + 2] == "//":
            return value[:i]
    return value


class Entry:
    def __init__(self, line: int, body: str) -> None:
        self.line = line
        self.body = body

    def field(self, name: str) -> str | None:
        m = re.search(rf"(?m)^\s*{name}\s*:\s*(.+?)\s*$", self.body)
        if not m:
            return None
        return strip_trailing_comment(m.group(1)).strip().rstrip(",").strip()

    def has(self, name: str) -> bool:
        return re.search(rf"(?m)^\s*{name}\s*:", self.body) is not None

    def string_field(self, name: str) -> str | None:
        raw = self.field(name)
        if raw is None:
            return None
        m = re.fullmatch(r"'([^']*)'", raw)
        return m.group(1) if m else None


class Registry:
    def __init__(self, path: Path, provider_dir: str, export: str) -> None:
        self.path = path
        self.provider_dir = provider_dir
        self.export = export
        self.entries: list[Entry] = []
        self.default_name: str | None = None
        self.default_value: str | None = None
        self.runtime_discovery = False


def parse_registry(path: Path, provider_dir: str) -> Registry | None:
    text = path.read_text(encoding="utf-8", errors="replace")
    decl = REGISTRY_DECL.search(text)
    if not decl:
        return None

    reg = Registry(path, provider_dir, decl.group(1))

    # Walk from the opening bracket, splitting the array's top-level object
    # literals by brace depth. Nested arrays (betaHeaders) are unaffected.
    i = decl.end()
    depth = 0
    start = -1
    while i < len(text):
        ch = text[i]
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                reg.entries.append(
                    Entry(text.count("\n", 0, start) + 1, text[start : i + 1])
                )
                start = -1
        elif ch == "]" and depth == 0:
            break
        i += 1

    dm = DEFAULT_DECL.search(text)
    if dm:
        reg.default_name, reg.default_value = dm.group(1), dm.group(2)
    return reg


def discover(root: Path) -> list[Registry]:
    base = root / ADAPTERS_SUBDIR
    found: list[Registry] = []
    for d in sorted(p for p in base.iterdir() if p.is_dir()):
        discovery = any(
            DISCOVERY_ENDPOINT.search(a.read_text(encoding="utf-8", errors="replace"))
            for a in d.glob("*Adapter.ts")
        )
        for ts in sorted(d.glob("*Models.ts")):
            reg = parse_registry(ts, d.name)
            if reg is not None:
                reg.runtime_discovery = discovery
                found.append(reg)
    return found


FALLBACK_NOTE = (
    " (this provider's adapter queries a model-listing endpoint, so its static "
    "list is a fallback -- reported as a warning, not an error)"
)


def check_entries(reg: Registry, errors: list[str], warnings: list[str]) -> None:
    soft = warnings if reg.runtime_discovery else errors
    note = FALLBACK_NOTE if reg.runtime_discovery else ""
    seen: dict[str, list[tuple[int, str | None]]] = {}
    for entry in reg.entries:
        where = f"{reg.path}:{entry.line}"
        for field in REQUIRED_FIELDS:
            if not entry.has(field):
                errors.append(f"{where}: entry is missing required field `{field}`")
        for cap in REQUIRED_CAPABILITIES:
            if not entry.has(cap):
                errors.append(
                    f"{where}: entry is missing capability flag `{cap}` -- the flag "
                    f"gates UI affordances, and an absent flag reads as false"
                )

        declared = entry.string_field("provider")
        if declared is not None and declared != reg.provider_dir:
            errors.append(
                f"{where}: provider is '{declared}' but the registry lives in "
                f"{reg.provider_dir}/ -- aggregators label the model from this "
                f"field, so it will surface under the wrong provider"
            )

        api = entry.string_field("apiName")
        if api:
            seen.setdefault(api, []).append((entry.line, entry.field("contextWindow")))

    for api, hits in seen.items():
        if len(hits) < 2:
            continue
        windows = {w for _, w in hits}
        lines = ", ".join(str(ln) for ln, _ in hits)
        if len(windows) == 1:
            soft.append(
                f"{reg.path}:{hits[1][0]}: duplicate apiName '{api}' (lines {lines}) "
                f"with identical contextWindow -- lookup returns the first, so the "
                f"rest are dead entries{note}"
            )
        else:
            warnings.append(
                f"{reg.path}:{hits[1][0]}: apiName '{api}' declared more than once "
                f"(lines {lines}) with differing contextWindow -- reachable only "
                f"where the provider's findModel has an explicit disambiguation "
                f"rule for the variant suffix"
            )


def check_default(reg: Registry, errors: list[str], warnings: list[str]) -> None:
    if reg.default_value is None:
        warnings.append(
            f"{reg.path}: no `*_DEFAULT_MODEL` export -- callers fall back to "
            f"whatever literal the adapter constructor carries"
        )
        return
    ids = {e.string_field("apiName") for e in reg.entries}
    if reg.default_value not in ids:
        sink = warnings if reg.runtime_discovery else errors
        note = FALLBACK_NOTE if reg.runtime_discovery else ""
        sink.append(
            f"{reg.path}: {reg.default_name} is '{reg.default_value}', which no "
            f"entry in this registry declares as apiName{note}"
        )


def check_adapter_literals(
    root: Path, reg: Registry, errors: list[str]
) -> None:
    if reg.default_value is None:
        return
    provider_dir = root / ADAPTERS_SUBDIR / reg.provider_dir
    for ts in sorted(provider_dir.glob("*Adapter.ts")):
        if NON_CHAT_ADAPTER.search(ts.name):
            continue
        text = ts.read_text(encoding="utf-8", errors="replace")
        m = SUPER_LITERAL.search(text)
        if not m:
            continue  # passes the registry export through, which is the good case
        literal = m.group(1)
        if literal != reg.default_value:
            line = text.count("\n", 0, m.start()) + 1
            errors.append(
                f"{ts}:{line}: constructor hard-codes default model '{literal}' "
                f"but {reg.default_name} is '{reg.default_value}' -- the adapter "
                f"wins at runtime, so the registry default is a lie"
            )


def check_aggregators(
    root: Path, registries: list[Registry], warnings: list[str], errors: list[str]
) -> None:
    reg_path = root / MODEL_REGISTRY
    static_path = root / STATIC_MODELS
    if not reg_path.is_file() or not static_path.is_file():
        errors.append(
            f"{reg_path} or {static_path} not found -- the aggregator layout moved; "
            f"re-read it before trusting this check"
        )
        return

    reg_text = reg_path.read_text(encoding="utf-8", errors="replace")
    static_text = static_path.read_text(encoding="utf-8", errors="replace")

    for reg in registries:
        in_registry = re.search(rf"\b{reg.export}\b", reg_text) is not None
        in_static = re.search(rf"\b{reg.export}\b", static_text) is not None
        if in_registry and not in_static:
            warnings.append(
                f"{reg.path}: {reg.export} is imported by {MODEL_REGISTRY.name} but "
                f"not by {STATIC_MODELS.name} -- cost and listModels see it, the "
                f"model picker does not"
            )
        elif in_static and not in_registry:
            warnings.append(
                f"{reg.path}: {reg.export} is imported by {STATIC_MODELS.name} but "
                f"not by {MODEL_REGISTRY.name} -- the picker offers it, cost "
                f"calculation returns null for every call"
            )
        elif not in_registry and not in_static:
            warnings.append(
                f"{reg.path}: {reg.export} is imported by neither aggregator -- "
                f"either it is adapter-local by design or the wiring was forgotten"
            )

        if reg.default_name and not re.search(rf"\b{reg.default_name}\b", reg_text):
            warnings.append(
                f"{reg.path}: {reg.default_name} is not imported by "
                f"{MODEL_REGISTRY.name}, so it is absent from DEFAULT_MODELS and "
                f"the live smoke lane cannot resolve a default for this provider"
            )


def check_shipped_default(
    root: Path, registries: list[Registry], scope: set[str] | None, warnings: list[str]
) -> None:
    """The settings default a fresh install starts on must name a real model."""
    types_dir = root / TYPES_SUBDIR
    if not types_dir.is_dir():
        return
    by_dir = {r.provider_dir: r for r in registries}
    for ts in sorted(types_dir.rglob("*.ts")):
        text = ts.read_text(encoding="utf-8", errors="replace")
        for m in SHIPPED_DEFAULT.finditer(text):
            provider, model = m.group(1), m.group(2)
            if scope is not None and provider not in scope:
                continue
            line = text.count("\n", 0, m.start()) + 1
            reg = by_dir.get(provider)
            if reg is None:
                warnings.append(
                    f"{ts}:{line}: shipped default provider '{provider}' has no "
                    f"ModelSpec[] registry under {ADAPTERS_SUBDIR}"
                )
                continue
            if model not in {e.string_field("apiName") for e in reg.entries}:
                warnings.append(
                    f"{ts}:{line}: shipped default model '{model}' is not declared "
                    f"by {reg.export} -- a fresh install starts on a model the "
                    f"registry does not know, so the picker cannot match it and "
                    f"cost calculation returns null"
                )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "providers",
        nargs="*",
        help="provider directory name(s) to scope to; omit to check all",
    )
    parser.add_argument(
        "--repo-root", default=".", help="path to the Nexus repo root (default: .)"
    )
    parser.add_argument(
        "--strict", action="store_true", help="exit non-zero on warnings too"
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="print what the tree declares and exit 0 without checking",
    )
    args = parser.parse_args()

    root = Path(args.repo_root)
    if not (root / ADAPTERS_SUBDIR).is_dir():
        print(
            f"error: {root / ADAPTERS_SUBDIR} not found -- pass --repo-root",
            file=sys.stderr,
        )
        return 2

    registries = discover(root)
    if not registries:
        print("error: no ModelSpec[] registry found under adapters/", file=sys.stderr)
        return 2

    if args.providers:
        wanted = set(args.providers)
        known = {r.provider_dir for r in registries}
        unknown = wanted - known
        if unknown:
            print(
                f"error: no ModelSpec[] registry for: {', '.join(sorted(unknown))}\n"
                f"known: {', '.join(sorted(known))}",
                file=sys.stderr,
            )
            return 2
        scoped = [r for r in registries if r.provider_dir in wanted]
    else:
        scoped = registries

    if args.list:
        for reg in scoped:
            default = reg.default_value or "(none)"
            print(
                f"{reg.provider_dir:24} {len(reg.entries):3} models  "
                f"default={default}  {reg.path}"
            )
        return 0

    errors: list[str] = []
    warnings: list[str] = []
    for reg in scoped:
        check_entries(reg, errors, warnings)
        check_default(reg, errors, warnings)
        check_adapter_literals(root, reg, errors)
    check_aggregators(root, scoped, warnings, errors)
    check_shipped_default(
        root, registries, set(args.providers) if args.providers else None, warnings
    )

    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")

    checked = f"{len(scoped)} registr{'y' if len(scoped) == 1 else 'ies'}"
    if errors:
        print(f"\n{len(errors)} error(s), {len(warnings)} warning(s) across {checked}")
        print("See references/registry-anatomy.md and references/consumers.md.")
        return 1
    if warnings and args.strict:
        print(f"\n0 errors, {len(warnings)} warning(s) across {checked} (--strict)")
        return 1
    print(f"\nclean: {checked} checked, {len(warnings)} warning(s)")
    print("Next: protocols/verify-model.md -- static structure proves nothing about")
    print("whether the provider accepts the id.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
