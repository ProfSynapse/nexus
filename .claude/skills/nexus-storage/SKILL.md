---
name: nexus-storage
description: How to read, write, migrate and recover Nexus persisted data safely. Use when adding a SQLite table or column, resolving a vault or plugin storage path, writing anything that must survive a restart, or debugging sync, hydration, cold-cache or rebuild problems.
---

# Working on Nexus Storage

## The model, and what it forbids

**The sharded JSONL event store is the source of truth. SQLite is a rebuildable
query/vector cache.** Everything in SQLite must be reconstructible from JSONL,
because "Nexus: Rebuild cache" deletes the cache and replays the event store.

Three consequences that constrain what you may write:

1. **Never treat SQLite as authoritative.** A write that lands only in the cache is
   a write that disappears on the next rebuild.
2. **Never hardcode a storage root.** Resolve it — the root is a user setting, and
   the plugin folder name varies by install.
3. **Never assume the cache is warm.** On a cold start the cache is empty while the
   event store is fine; a read that does not wait reports "no data" for data that
   exists.

## Find where data actually lives

Ask the tree rather than trusting a path written down anywhere:

```bash
grep -rn "resolveVaultRoot\|resolvePluginStorageRoot" src/database/storage/
grep -rn "streamPath\|<category>" src/database/storage/EventStreamUtilities.ts
```

Stream directories are **prefixed** — the logical id is not the directory name.
Repositories build a logical `<category>/<id>` path and the event store turns it
into a directory of shard files. If a glob finds nothing, check the prefix before
concluding the data is missing.

Path resolution has exactly two entry points, and which you want depends on the
data: `resolveVaultRoot(settings, { configDir })` for the configured synced event
root, `resolvePluginStorageRoot(app, plugin)` for plugin-scoped compatibility and
cache paths. Legacy locations are read/migration fallbacks only and must never be a
write target.

## Add a SQLite table or column

This is the procedure most likely to cause real damage if done from memory. The
authoritative rules are in the header comment at the top of `SchemaMigrator.ts` —
read it before writing a migration.

**Three steps, not two:**

1. Bump `CURRENT_SCHEMA_VERSION` in `SchemaMigrator.ts`
2. Append an entry to the `MIGRATIONS` array in the same file
3. **Update `SCHEMA_SQL` in `src/database/schema/schema.ts`** so fresh installs get
   it too

**Migrations are additive and idempotent.** `CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` (the migrator skips an ADD
COLUMN whose column already exists). **Never edit an existing migration.** Drops,
renames and type changes are not supported — if you need data reshaped in JS, use
the optional `migrationFn` hook rather than reaching for DDL that destroys.

**Verify both paths, because they fail independently:**

- **Upgrade:** open an existing vault and confirm the migration ran and the column
  or table is present.
- **Fresh install:** delete the cache (or use a clean vault), let it build from
  `SCHEMA_SQL`, and confirm the same shape.

Skipping step 3 is invisible on any dev machine that already has a cache — the
upgrade path works, and only new users get a broken schema.

## Recover and rebuild

Two user-facing commands, both registered in
`src/core/commands/MaintenanceCommandManager.ts`:

- **Nexus: Refresh synced data** — re-reads the event store; for vaults that sync
  after init
- **Nexus: Rebuild cache** — stops autosave, closes and removes the cache blob,
  reinitializes, and replays from JSONL. The synced event store is never touched.

Rebuild is the correct answer to a corrupted or suspect cache, and it is safe by
design. If rebuilding loses something, that something was only ever in the cache —
which is the bug.

## Gotchas

**"The migration works on my machine but new installs are broken."** You updated
`MIGRATIONS` and forgot `SCHEMA_SQL`. Upgraders get the table, fresh installs never
do, and no dev machine with an existing cache will show it.

**"I need to drop a column / change a type."** Not supported. Migrations are
additive; reshape in JS via `migrationFn`, or add a new column and leave the old one
alone.

**"My data came back after a rebuild / vanished after a rebuild."** Something is
writing to SQLite without a corresponding event, or reading a field that only exists
in the cache. Write through the repository, not the cache.

**"The view says 'no tasks' but the data is there."** A read raced startup. Await
the adapter's readiness (`waitForQueryReady()` — optional on `IStorageAdapter`,
implemented by `HybridStorageAdapter`) before querying, as
`TaskBoardDataController`, `TaskService`, `DualBackendExecutor` and
`ProjectsManagerView` do. Without it a cold cache renders as "no data" rather than
"not ready".

**"A filter silently misses records that obviously match."** A metadata fast-path
skipped the JSONL content fetch, and the field being filtered on lives only in
content. An archive-visibility bug came from exactly this. If a filter needs a
field, denormalize it into the metadata — do not skip the fetch.

**"My glob over the event store finds nothing."** Stream directories carry a
category prefix; the bare id is not the directory name. Check
`EventStreamUtilities.ts`.

**"Boot hangs, or the cache keeps getting corrupted."** The cache must never live
under a cloud-synced path — that is the entire reason desktop uses IndexedDB and
mobile uses the vault adapter, chosen by `createCacheBlobStore`. The documented
trigger was a large `cache.db` inside a Google Drive Shared Drive conflict-copying
mid-write and timing out hydration. See
`docs/architecture/cloud-sync-cache-backend.md`. Do not move cache data back under a
synced path.

**"A conflict copy was not recognised."** `CONFLICT_COPY_PATTERNS` in
`CacheBackendMigration.ts` does not match the parenthesised Dropbox form — tracked
in [#334](https://github.com/ProfSynapse/nexus/issues/334). If you touch that list,
verify by *running* the patterns against real filenames; the example in one
pattern's own trailing comment does not match the pattern it annotates, which is how
the gap survived review.

**"I hardcoded the storage root and it works fine."** It works on your vault. The
root is a user setting with a default, and legacy installs use different plugin
folder names. Use the resolvers.
