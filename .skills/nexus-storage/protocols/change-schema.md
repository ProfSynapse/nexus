# Protocol: change the SQLite schema

Context: run this for any new table, column, index, or virtual table in the SQLite
cache. Getting it wrong ships a broken schema to one half of the user base and is
invisible on the machine you develop on.

## Mission
Land a schema change that is present and correct on **both** the upgrade path and
the fresh-install path, proven by a static check and by running both paths.

## Steps

1. Read `../references/schema-rules.md` and the header comment at the top of
   src/database/schema/SchemaMigrator.ts. Confirm the change is expressible
   additively — new table, new index, new column with a default. If it needs a
   drop, rename, or type change, STOP and redesign: add a new column and backfill
   it in `migrationFn`.
2. Confirm the data belongs in SQLite at all. The cache holds only what can be
   rebuilt from the JSONL event store; if this is new persisted state, run
   `persist-new-data.md` first and come back for the cache columns.
3. Bump `CURRENT_SCHEMA_VERSION` in src/database/schema/SchemaMigrator.ts.
4. Append a new entry to the `MIGRATIONS` array in the same file — never edit an
   existing entry. Use `IF NOT EXISTS` on every CREATE, `ALTER TABLE … ADD COLUMN`
   for columns, and put any data reshaping in the optional `migrationFn`.
5. Update src/database/schema/schema.ts so fresh installs get the same shape:
   add the table/column/index to `SCHEMA_SQL`, **and** bump the version literal in
   the `INSERT OR IGNORE INTO schema_version VALUES (…)` statement at the end of
   the template so it matches `CURRENT_SCHEMA_VERSION`. Update the `Current
   Version` line in that file's header comment too.
6. Update tests/unit/SchemaMigrator.test.ts: it pins the exact
   `CURRENT_SCHEMA_VERSION` and asserts additive-only DDL for recent migrations.
   Add assertions for your migration in the same shape as the existing ones.
7. Run the mechanical check from the repo root and fix everything it reports:
   ```bash
   python3 .claude/skills/nexus-storage/scripts/check_schema_consistency.py .
   npm run test -- SchemaMigrator
   ```
8. Verify both runtime paths. They fail independently and a green script proves
   neither of them ran:
   - **Upgrade:** open a vault that already has a cache, confirm the migration
     applied and the new object is present.
   - **Fresh install:** run "Nexus: Rebuild cache" (or start on a vault with no
     cache) so the database is built from `SCHEMA_SQL` alone, and confirm the same
     shape.
   Use `nexus-testing` for the in-app loop — loading the plugin in a real vault,
   driving it, and reading the logs.
9. Stop condition: the check exits clean, the Jest lane passes, and you have
   observed the new object present on both paths. Anything less and the change is
   not done.

## Guidelines
- Pattern: write the migration and the `SCHEMA_SQL` edit in the same commit, in
  that order, then run the script before anything else.
- Pattern: prefer a nullable column with a default over a NOT NULL column; the
  migrator adds columns to tables that already hold rows.
- Anti-pattern: "the migration handles it, SCHEMA_SQL is just documentation." It is
  the only thing a new user ever executes.
- Anti-pattern: reusing an existing migration entry because the version has not
  shipped yet. Version numbers are cheap; a diverged user database is not.

## Next
If the change was made to support new persisted data, continue with
`persist-new-data.md` to confirm the write path and the replay path agree. If you
are debugging rather than building, go to `diagnose-storage.md`. Otherwise this is
terminal — run `self-refine.md` at the end of the session.
