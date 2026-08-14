#!/usr/bin/env python3
"""Check that the three SQLite schema definitions in Nexus agree with each other.

A schema change has to land in three places or it ships broken to one half of the
users, and the failure is invisible on any machine that already has a cache:

  1. CURRENT_SCHEMA_VERSION in src/database/schema/SchemaMigrator.ts
  2. an entry appended to the MIGRATIONS array in the same file  (upgrade path)
  3. SCHEMA_SQL in src/database/schema/schema.ts                 (fresh-install path),
     including the version literal that SCHEMA_SQL stamps into schema_version

Step 3 matters because SCHEMA_SQL ends with
`INSERT OR IGNORE INTO schema_version VALUES (N, ...)`. A fresh install is stamped
at N, so the migrator early-returns and NEVER runs a migration on it. Whatever is
missing from SCHEMA_SQL simply does not exist for new users, while every developer
machine -- which upgrades through MIGRATIONS -- looks fine.

This script parses both files and reports the drift. It checks mechanical
agreement only; whether a migration is semantically right is a judgment call the
model makes (see ../references/schema-rules.md).

Usage:
  python3 check_schema_consistency.py [REPO_ROOT] [--quiet]

Exit codes:
  0  the three definitions agree (warnings may still print)
  1  drift found
  2  usage error (paths missing / files unparseable)
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

MIGRATOR_REL = "src/database/schema/SchemaMigrator.ts"
SCHEMA_REL = "src/database/schema/schema.ts"

RE_CURRENT_VERSION = re.compile(r"export\s+const\s+CURRENT_SCHEMA_VERSION\s*=\s*(\d+)")
RE_MIGRATIONS_START = re.compile(r"export\s+const\s+MIGRATIONS\s*:\s*Migration\[\]\s*=\s*\[")
RE_ENTRY_VERSION = re.compile(r"^\s*version:\s*(\d+)\s*,", re.MULTILINE)
RE_SCHEMA_SQL_START = re.compile(r"export\s+const\s+SCHEMA_SQL\s*=\s*`")
RE_STAMP = re.compile(
    r"INSERT\s+OR\s+IGNORE\s+INTO\s+schema_version\s+VALUES\s*\(\s*(\d+)", re.IGNORECASE
)

RE_CREATE_TABLE = re.compile(
    r"CREATE\s+(VIRTUAL\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)",
    re.IGNORECASE,
)
RE_CREATE_INDEX = re.compile(
    r"CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)",
    re.IGNORECASE,
)
RE_ADD_COLUMN = re.compile(
    r"ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)",
    re.IGNORECASE,
)
RE_DROP_TABLE = re.compile(
    r"DROP\s+TABLE\s+(IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE
)
RE_DROP_INDEX = re.compile(
    r"DROP\s+INDEX\s+(IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE
)
RE_RENAME = re.compile(r"ALTER\s+TABLE\s+\w+\s+RENAME", re.IGNORECASE)


def slice_block(text: str, start_match: re.Match, closer: str) -> str:
    """Return the text from the end of start_match up to the first line that is
    exactly `closer` (e.g. '];' or '`;') at column 0."""
    tail = text[start_match.end():]
    lines = tail.splitlines()
    out: list[str] = []
    for line in lines:
        if line.rstrip() == closer:
            break
        out.append(line)
    return "\n".join(out)


def parse_migrations(src: str) -> tuple[int, list[tuple[int, str]]]:
    """Return (CURRENT_SCHEMA_VERSION, [(version, entry_text), ...])."""
    m = RE_CURRENT_VERSION.search(src)
    if not m:
        raise ValueError("CURRENT_SCHEMA_VERSION not found")
    current = int(m.group(1))

    start = RE_MIGRATIONS_START.search(src)
    if not start:
        raise ValueError("MIGRATIONS array not found")
    block = slice_block(src, start, "];")

    hits = list(RE_ENTRY_VERSION.finditer(block))
    entries: list[tuple[int, str]] = []
    for i, hit in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(block)
        entries.append((int(hit.group(1)), block[hit.start():end]))
    return current, entries


def parse_schema_sql(src: str) -> str:
    start = RE_SCHEMA_SQL_START.search(src)
    if not start:
        raise ValueError("SCHEMA_SQL template literal not found")
    return slice_block(src, start, "`;")


def schema_tables(schema_sql: str) -> dict[str, str]:
    """Map table name -> the text of its CREATE statement (through the next ');')."""
    tables: dict[str, str] = {}
    for m in RE_CREATE_TABLE.finditer(schema_sql):
        name = m.group(3)
        rest = schema_sql[m.end():]
        end = rest.find(");")
        body = rest[: end if end != -1 else len(rest)]
        tables[name] = body
    return tables


def schema_indexes(schema_sql: str) -> set[str]:
    return {m.group(3) for m in RE_CREATE_INDEX.finditer(schema_sql)}


def table_has_column(body: str, column: str) -> bool:
    return re.search(rf"(^|[(,\s]){re.escape(column)}\s", body) is not None



def strip_comments(src: str) -> str:
    """Blank out /* */ and // comments so DDL inside documentation is not read
    as real DDL. IStorageBackend.ts carries a `CREATE TABLE users` in an
    @example block; treating that as a schema defect would be a false alarm
    nobody could silence."""
    src = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def stray_table_definitions(repo: Path, schema_sql: str) -> list[str]:
    """Every CREATE TABLE outside src/database/schema/ must name a table the
    schema also declares.

    A mirrored copy is tolerated -- NotesIndexService keeps one, and a parity
    test pins it to SCHEMA_SQL. What is not tolerated is a table that exists
    ONLY outside the schema, because every database-creating path other than
    that one code path will lack it. That is exactly how `notes` and
    `note_properties` came to be destroyed by `rebuildCache()`: the service
    issued its own DDL once at start-up, the rebuild recreated the database
    from SCHEMA_SQL alone, and the builder went on writing to tables that were
    no longer there.
    """
    known = set(schema_tables(schema_sql))
    problems: list[str] = []
    src_root = repo / "src"
    if not src_root.is_dir():
        return problems
    for path in sorted(src_root.rglob("*.ts")):
        if "database/schema/" in path.as_posix():
            continue
        try:
            text = strip_comments(path.read_text(encoding="utf-8"))
        except OSError:
            continue
        for m in re.finditer(
            r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`\"\[]?(\w+)", text, re.I
        ):
            table = m.group(1)
            if table not in known:
                rel = path.relative_to(repo).as_posix()
                line = text[: m.start()].count("\n") + 1
                problems.append(
                    f"{rel}:{line}: creates table '{table}', which SCHEMA_SQL does not "
                    f"declare. A table the schema does not own is dropped by any "
                    f"rebuild -- add it to SCHEMA_SQL and a migration "
                    f"(protocols/change-schema.md)"
                )
    return problems


def check(repo: Path) -> tuple[list[str], list[str]]:
    """Return (errors, warnings)."""
    errors: list[str] = []
    warnings: list[str] = []

    migrator_path = repo / MIGRATOR_REL
    schema_path = repo / SCHEMA_REL
    current, entries = parse_migrations(migrator_path.read_text(encoding="utf-8"))
    schema_sql = parse_schema_sql(schema_path.read_text(encoding="utf-8"))

    # --- 1. version agreement -------------------------------------------------
    versions = [v for v, _ in entries]
    if versions != sorted(set(versions)):
        errors.append(
            f"{MIGRATOR_REL}: MIGRATIONS versions are not unique and ascending: {versions}"
        )
    if versions and max(versions) > current:
        errors.append(
            f"{MIGRATOR_REL}: CURRENT_SCHEMA_VERSION is {current} but the highest "
            f"migration is v{max(versions)} -- the new migration will never run"
        )
    if versions and max(versions) < current:
        warnings.append(
            f"{MIGRATOR_REL}: CURRENT_SCHEMA_VERSION is {current} with no migration at "
            f"that version (highest is v{max(versions)}); intentional only if the bump "
            f"is fresh-install-only"
        )

    stamp = RE_STAMP.search(schema_sql)
    if not stamp:
        errors.append(
            f"{SCHEMA_REL}: SCHEMA_SQL does not stamp schema_version -- fresh installs "
            f"would replay every migration"
        )
    elif int(stamp.group(1)) != current:
        errors.append(
            f"{SCHEMA_REL}: SCHEMA_SQL stamps schema_version {stamp.group(1)} but "
            f"CURRENT_SCHEMA_VERSION is {current} -- fresh installs land on the wrong "
            f"version and either replay or skip migrations"
        )

    # --- 2. every migrated object exists in SCHEMA_SQL -------------------------
    tables = schema_tables(schema_sql)
    indexes = schema_indexes(schema_sql)

    dropped_tables: dict[str, int] = {}
    dropped_indexes: dict[str, int] = {}
    for version, text in entries:
        for m in RE_DROP_TABLE.finditer(text):
            dropped_tables[m.group(2)] = version
        for m in RE_DROP_INDEX.finditer(text):
            dropped_indexes[m.group(2)] = version

    for version, text in entries:
        for m in RE_CREATE_TABLE.finditer(text):
            name = m.group(3)
            if dropped_tables.get(name, -1) > version:
                continue
            if name not in tables:
                errors.append(
                    f"{SCHEMA_REL}: table '{name}' is created by migration v{version} but "
                    f"is missing from SCHEMA_SQL -- upgraders get it, fresh installs never do"
                )
        for m in RE_CREATE_INDEX.finditer(text):
            name = m.group(3)
            if dropped_indexes.get(name, -1) > version:
                continue
            if name not in indexes:
                errors.append(
                    f"{SCHEMA_REL}: index '{name}' is created by migration v{version} but "
                    f"is missing from SCHEMA_SQL"
                )
        for m in RE_ADD_COLUMN.finditer(text):
            table, column = m.group(1), m.group(2)
            if dropped_tables.get(table, -1) > version:
                continue
            body = tables.get(table)
            if body is None:
                errors.append(
                    f"{SCHEMA_REL}: migration v{version} adds column '{column}' to unknown "
                    f"table '{table}'"
                )
            elif not table_has_column(body, column):
                errors.append(
                    f"{SCHEMA_REL}: column '{table}.{column}' is added by migration "
                    f"v{version} but is missing from SCHEMA_SQL -- upgraders get it, fresh "
                    f"installs never do"
                )

    # --- 3. additive-and-idempotent heuristics --------------------------------
    for version, text in entries:
        if RE_DROP_TABLE.search(text) or RE_DROP_INDEX.search(text):
            warnings.append(
                f"{MIGRATOR_REL}: migration v{version} contains a DROP -- migrations are "
                f"additive; confirm this is removing an object that only ever existed on "
                f"fresh installs"
            )
        if RE_RENAME.search(text):
            warnings.append(
                f"{MIGRATOR_REL}: migration v{version} contains a RENAME -- unsupported; "
                f"add a new column and backfill via migrationFn instead"
            )
        for m in RE_CREATE_TABLE.finditer(text):
            if not m.group(2):
                warnings.append(
                    f"{MIGRATOR_REL}: migration v{version} creates table '{m.group(3)}' "
                    f"without IF NOT EXISTS -- not idempotent"
                )
        for m in RE_CREATE_INDEX.finditer(text):
            if not m.group(2):
                warnings.append(
                    f"{MIGRATOR_REL}: migration v{version} creates index '{m.group(3)}' "
                    f"without IF NOT EXISTS -- not idempotent"
                )

    # --- 5. no table may live outside the schema ------------------------------
    errors.extend(stray_table_definitions(repo, schema_sql))

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "repo", nargs="?", default=".", help="Nexus repo root (default: current directory)"
    )
    parser.add_argument("--quiet", action="store_true", help="suppress warnings")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    for rel in (MIGRATOR_REL, SCHEMA_REL):
        if not (repo / rel).is_file():
            print(f"error: {repo / rel} not found; pass the Nexus repo root", file=sys.stderr)
            return 2

    try:
        errors, warnings = check(repo)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    for w in warnings:
        if not args.quiet:
            print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")

    if errors:
        print(f"\nDRIFT: {len(errors)} error(s). Fix SCHEMA_SQL and re-run.")
        return 1
    print("\nOK: CURRENT_SCHEMA_VERSION, MIGRATIONS and SCHEMA_SQL agree.")
    print("Next: verify both runtime paths -- upgrade an existing vault AND build a "
          "cache from scratch. See protocols/change-schema.md; a static check cannot "
          "prove either path ran.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
