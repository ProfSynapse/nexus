# What a migration may and may not do

The authoritative rules are the header comment at the top of
src/database/schema/SchemaMigrator.ts. Read it. This file adds the reasoning the
header does not spell out, and the one step it omits.

## Why a schema change has three homes

There are two independent ways a database comes to exist:

- **Upgrade path.** An existing cache is loaded, `SchemaMigrator.migrate()` runs
  every entry in `MIGRATIONS` whose `version` exceeds the recorded version, and
  stamps `schema_version` as it goes.
- **Fresh-install path.** `SQLitePersistenceService.createFreshDatabase` executes
  `SCHEMA_SQL` in one shot.

They do not overlap, and here is the part that is easy to miss: **SCHEMA_SQL ends
with `INSERT OR IGNORE INTO schema_version VALUES (N, ...)`.** A fresh install is
therefore stamped at N immediately, `getCurrentVersion()` returns N, and
`migrate()` early-returns without applying a single migration.

So a table added to `MIGRATIONS` but not to `SCHEMA_SQL` exists for upgraders and
does not exist for new users — and no developer machine with an existing cache can
see the difference. That version literal at the bottom of SCHEMA_SQL is a fourth
edit that the header comment's three steps do not mention; if it lags
`CURRENT_SCHEMA_VERSION`, fresh installs replay migrations they should not, and if
it runs ahead they skip migrations they need.

`scripts/check_schema_consistency.py` checks all four of these mechanically.

## Additive and idempotent, always

The migrator applies each statement in order and skips an `ALTER TABLE … ADD
COLUMN` whose column already exists (it checks `PRAGMA table_info`). Everything
else must carry its own idempotence:

- `CREATE TABLE IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS`
- `CREATE VIRTUAL TABLE IF NOT EXISTS` (vec0 / fts5)
- `ALTER TABLE … ADD COLUMN`

Not supported, per the migrator header: **removing a column, renaming a column,
changing a column type.** SQLite makes them impractical and the migrator has no
machinery for them. If data must be reshaped, add the new column and populate it
in the optional `migrationFn` hook, which receives the database and can run
arbitrary JS — the workspaceId/sessionId and workflow-metadata backfills are the
worked examples in the file.

One historical migration does contain `DROP TABLE IF EXISTS`: it removed tables
that had only ever existed on fresh installs of an intermediate version. That is
the narrow case the script warns about rather than forbids. It is not licence to
drop a table users have data in.

## Never edit an existing migration

An entry that has already shipped has already run on user databases. Editing it
changes nothing for them and silently diverges their schema from a fresh install's.
Append a new entry instead — always.

## Denormalize what you want to filter on

Several migrations exist purely because a field lived inside `metadataJson` and a
query needed to filter on it: workspaceId/sessionId on conversations, the workflow
run columns, `isArchived` on workspaces. Each pairs new columns with a `migrationFn`
that backfills them out of the JSON.

Take the lesson forward: if a filter needs a field, give the field a column and
backfill it. Do not add a query path that reads a field the SQL cannot see, and do
not "optimize" a read by skipping the content fetch a filter depends on — that
produces a filter which silently omits records that obviously match.

## The version literal is pinned by a test

tests/unit/SchemaMigrator.test.ts asserts the exact value of
`CURRENT_SCHEMA_VERSION` and asserts additive-only DDL for the most recent
migrations. Bumping the version without updating that test fails the Jest lane —
which is the intended behaviour, not an obstacle. Add assertions for your migration
in the same shape.
