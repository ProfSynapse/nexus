# Symptom → cause → fix

Each entry names the invariant it violates (see `storage-model.md`). Confirm the
cause before fixing; several of these look identical from the UI.

## "The migration works on my machine but new installs are broken"

`MIGRATIONS` was updated and `SCHEMA_SQL` was not — or the version literal at the
bottom of `SCHEMA_SQL` was not bumped with `CURRENT_SCHEMA_VERSION`. Fresh installs
never run migrations (`schema-rules.md`), so nothing on a dev machine with an
existing cache can reveal this.

Fix: run `scripts/check_schema_consistency.py`, then re-verify both install paths.

## "I need to drop a column or change a type"

Unsupported. Add a new column and reshape in `migrationFn`, or leave the old column
in place unused. Never edit a shipped migration to make it look right.

## "Data vanished after a rebuild"

A write reached SQLite without a corresponding JSONL event, or the event has a type
no applier in src/database/sync handles — appliers `switch` on `event.type` with no
default, so an unknown type is dropped in silence during replay.

Fix: write through the repository (event first, then cache) and add the `case` to
the applier. Re-verify by rebuilding the cache again and confirming survival.

## "Data reappeared after a rebuild"

The inverse: something deleted from SQLite without appending a deletion event.
Replay faithfully restores what the event store still says exists.

## "The view says 'no tasks' but the data is there"

A read raced startup hydration. Await `waitForQueryReady()` (optional on
`IStorageAdapter`, implemented by `HybridStorageAdapter`) before querying, guarding
with `typeof adapter.waitForQueryReady === 'function'`. TaskBoardDataController,
TaskService, DualBackendExecutor and ProjectsManagerView all do this correctly.

## "I awaited `waitForQueryReady()` and it still raced / hung for two minutes"

Awaiting the gate is only half of it. Two ways it still bites:

- **The gate never opens.** `isQueryReady()` is false while the hydration phase is
  `running`, and `onProgress` is what puts it there. A rebuild path that reports
  progress must also end the phase (`complete()`), or every waiter burns
  `DEFAULT_STARTUP_REBUILD_IDLE_TIMEOUT_MS` (120s) and resolves **false** for the
  rest of the session. This shipped once: only the blocking rebuild completed the
  phase, so the background one — the fresh-vault path — left the adapter
  permanently not-query-ready.
- **The boolean is discarded.** `waitForQueryReady()` returns false on timeout and
  on a failed init. `await adapter.waitForQueryReady()` with the result thrown away
  reads as a gate but is a sleep. Branch on it: if `isReady()` is also false the
  connection does not exist, so report `getInitError()` rather than letting the
  first statement fail with the generic "Database not initialized".

Verify with a real cold start, not a plugin reload: delete the cache
(`indexedDB` database `nexus-cache-blob-store` on desktop) so init takes the
full-rebuild branch, then restart.

## "A filter silently misses records that obviously match"

The query filtered on a column while the field it needs lives only in JSON content,
or a read path skipped the content fetch a filter depends on. Denormalize the field
into a column and backfill it (`schema-rules.md`), rather than making the read path
cleverer.

## "My glob over the event store finds nothing"

Stream directories carry a category prefix and the id names a **directory** of
shard files, not a `.jsonl` file: `<dataPath>/<category>/<id>/shard-NNNNNN.jsonl`.
See `paths-and-layout.md`.

## "Boot hangs, or the cache keeps getting corrupted"

The cache blob is under a cloud-synced path. Desktop must use IndexedDB and mobile
the vault adapter, selected by `createCacheBlobStore`; the trigger incident was a
large cache.db in a Google Drive Shared Drive conflict-copying mid-write and timing
out hydration. Do not move cache data back under a synced path.
docs/architecture/cloud-sync-cache-backend.md has the full design.

## "A conflict copy was not recognised"

`CONFLICT_COPY_PATTERNS` in src/database/migration/CacheBackendMigration.ts does not
match the parenthesised Dropbox form — the pattern requires the filename to end in
`conflicted copy YYYY-MM-DD.db`, while the real name closes the parenthesis after
the date. Tracked as issue #334 in the ProfSynapse/nexus repo.

If you touch that list, verify by **running** the regexes against real filenames.
The example in one pattern's own trailing comment does not match the pattern it
annotates, which is exactly how the gap survived review.

## "I hardcoded the storage root and it works fine"

It works on your vault. The vault root is a user setting and the plugin folder name
differs between installs. Use `resolveVaultRoot` / `resolvePluginStorageRoot`, and
treat `compatibilityDataRoots` as read-only.

## "Sync brought changes but the UI is stale"

Two user-facing commands, both in src/core/commands/MaintenanceCommandManager.ts:
**Nexus: Refresh synced data** re-reconciles the event store into the cache (the
answer when a vault finishes syncing after init), and **Nexus: Rebuild cache**
wipes and replays it. Prefer refresh first; rebuild is the bigger hammer and is
safe, because everything it destroys is rebuildable by definition.
