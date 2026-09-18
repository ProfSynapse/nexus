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

## "A list tool returns an entity, but loading it by ID or name says not found"

Check `pluginStorage.migration.state` before blaming the point lookup. Affected
builds could keep legacy roots readable but disable `VaultEventStore` reads
during a pending or failed cutover, even though writes already went to the
vault-root destination. SQLite could still contain metadata replayed from those
shards. The result was a split read path: list queries saw the SQLite row, while
repositories that needed the JSONL body saw only legacy files and returned null.
A just-created entity could appear healthy until reload because its body was
still in the repository's in-memory write cache.

Confirm all three facts before changing data: the metadata row lists, the event
body exists under the resolved vault-root stream, and the persisted migration
state is `pending` or `failed`. Do not hand-copy or edit shards. Fix the cutover
read policy or resolve the migration conflict, then verify a cold point lookup;
an in-session lookup can be a cache hit and is not proof.

The runtime invariant is: read the configured vault-root destination first at
every migration phase, retain legacy roots only as fallbacks until verification,
and let `StorageRouter` deduplicate by event ID. After verified cutover, remove
the legacy fallbacks but keep destination reads enabled.

## "Data reappeared after a rebuild"

The inverse: something deleted from SQLite without appending a deletion event.
Replay faithfully restores what the event store still says exists.

**Appending the deletion event is not sufficient, and stopping there is how this
ships twice.** Three further things have to hold, and a delete has failed on all
of them at once:

- **The applier must delete as much as the delete did.** Replay reaches the
  tombstone only after re-applying every event that created the entity's
  children, so an applier narrower than the live delete leaves those children as
  orphans on every rebuild.
- **Nothing cascades in SQLite.** The schema declares `ON DELETE CASCADE` in
  several places, but FK enforcement is off — SQLite's per-connection default,
  and nothing turns it on (`grep -rn "foreign_keys" src/` returns nothing). A
  `DELETE FROM workspaces` removes exactly one row. Delete children explicitly,
  child-before-parent, and put the statement list in ONE place both the
  repository and the applier call, or the two drift.
- **One entity can own more than one stream.** A workspace owns
  `workspaces/ws_<id>` *and* `tasks/tasks_<id>`; a tombstone in the first says
  nothing about the second, and `fullRebuild` replays every stream it lists.
  Derive the set from the repositories' `jsonlPath`, do not assume one.

Do not settle for "the row is gone from the UI". The check is
`adapter.rebuildCache()` followed by a count per table, in the running app.

## "There is no deletion event to fix — the type does not exist"

Do not assume a delete writes an event just because its siblings do. Session
deletion had no `session_deleted` type at all: `SessionRepository.delete` ran one
`DELETE FROM sessions` and touched JSONL never, so a deleted session was measured
coming back on the next rebuild (`sessions 0 → 1`), with its states and traces
still in the cache from before. Start every deletion investigation with
`grep -rn "<entity>_deleted" src/`; an empty result is the diagnosis.

Adding the type is a three-place change — the interface plus both union/guard
lists in `StorageEvents.ts`, the applier `case`, and the repository write — and
then two questions have to be answered explicitly:

- **Which stream does the tombstone go in, and does this entity own one?** A
  session owns none: its events live in the *parent workspace's* stream, shared
  with the workspace and its sibling sessions. There is nothing to remove from
  disk and removing that file would destroy the parent — the tombstone IS the
  removal. Contrast a workspace, which owns two streams that must both go.
- **Does old JSONL need a backfill?** For a brand-new deletion type, no, and
  synthesising one is dangerous: the only signal that a pre-fix delete happened
  is "present in JSONL, absent from SQLite", which is also what a cold, partial
  or mid-hydration cache looks like. Writing tombstones from that inference turns
  a rebuildable cache state into permanent data loss, inverting the invariant in
  `storage-model.md`. Old streams simply have no tombstone; the entity comes back
  once and the user's next delete is permanent.

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

## "no such table: <something>" after a cache rebuild

**Nexus: Rebuild cache is a fresh-install path, not a data-clearing path.**
`StorageMaintenanceService.rebuildCache()` calls `close()`, deletes the cache blob,
then `initialize()` — which creates a **brand-new database from `SCHEMA_SQL`**.
Anything not defined there is gone: not its rows, the table itself.

A table created ad hoc by a service (`exec(SOME_DDL)` at startup) therefore
survives exactly until the first rebuild, after which every write to it throws
`SQLite3Error: no such table: …` for the rest of the session — the service holds
the same `SQLiteCacheManager` object, so nothing looks disconnected, and a
still-subscribed event handler keeps writing. This shipped once: the notes query
index kept the DDL to itself on the "it's rebuildable, it doesn't need a
migration" reasoning (fixed in migration v14; see docs/plans/notes-query-index-plan.md §5).

Rebuildable describes where the *data* comes from. It says nothing about who owns
the *table*. If any code issues SQL against a table, that table belongs in
`schema.ts` **and** in `MIGRATIONS` — run `change-schema.md`, never a private DDL
constant.

The second half of the same failure is quieter: after a rebuild the table exists
but is empty, and an index whose source is the vault (not the JSONL event store)
is not repopulated by the replay. Subscribe to the adapter's `onCacheRebuilt`
signal and rebuild, or the index silently answers "nothing" until the next load.

Reproduce it in the running app — no Jest lane covers this seam:
`adapter.rebuildCache()`, then touch a note, then read `dev:errors`.

## "Database not initialized", in a burst, after a reload

The database is *fine*. Something that belongs to the PREVIOUS plugin instance is
still writing to it. `close()` nulls the handle at unload, so every statement a
survivor issues afterwards throws `Database not initialized` out of
`getDbOrThrow()` — with a four-frame storage stack that names no subsystem,
because the async chain was broken by the event handler that scheduled the work.

Two survivor shapes, both real:

- **A subscription that outlives unload.** `app.metadataCache.on(...)` /
  `app.vault.on(...)` are NOT torn down by the plugin unless the ref goes through
  `plugin.registerEvent(ref)` or the service's teardown removes it. Note that
  `ServiceContainer.clear()` calls **`cleanup()`** — a service whose teardown is
  named `stop()`, `dispose()` or anything else is never called at all. One leak
  per load, so the burst grows with the session's reload count.
- **A long walk mid-flight.** Anything that yields between batches (a vault
  index build) resumes after the unload that closed the database unless it checks
  a stopped flag.

The bulk-import shape is the diagnostic: a few hundred files dropped into the
vault keep `changed` events flowing for tens of seconds, which is exactly the
window a reload lands in.

Confirm the leak in the running app — the count should be 1, and stay 1:

```js
app.metadataCache._['changed'].filter(l => String(l.fn).includes('<handlerFragment>')).length
```

To attribute the throw, patch the *prototype*, not the instance
(`Object.getPrototypeOf(sqliteCache).transaction = …` recording `new Error().stack`):
the failing calls come from an object the current plugin instance no longer
exposes, so an instance patch records nothing.

Fixing teardown is necessary but not sufficient: a write scheduled before the
close still has to fail safely. Give the detached paths (`void this.flush()`,
`void service.deleteNote(...)`) a `catch`, or the shutdown detail is reported as
a plugin error.

## "RangeError: Array buffer allocation failed", or "Failed to embed \<path\>" on a large vault

Not an embedding failure and not out-of-memory. The cache is persisted by exporting
the **entire** database out of the WASM heap and handing it to the blob store, which
copies it again. `SQLiteWasmBridge.exportDatabase` calls `sqlite3_js_db_export`, which
copies the image inside the WASM heap and then copies that into a contiguous JS
`ArrayBuffer`; `SQLitePersistenceService.saveDatabase` passes it to
`IndexedDBCacheBlobStore.write` (structured clone) on desktop or
`vault.adapter.writeBinary` on mobile. Peak live bytes per save measured at 3x the
database size, the WASM heap reached 310.6 MB resident for a 152 MB database, and it
never shrinks. At a 150 MB cache with a save every ten notes, a full index performs
hundreds of allocate-and-discard cycles and the JS heap fragments until no contiguous
run that size remains. The allocator is refusing one contiguous request, which is why
the first saves succeed and later ones fail.

It is reported as an embed failure because the periodic `db.save()` sat inside the
per-note `try` in `IndexingQueue`. `TraceIndexer` has the same shape and says so in a
comment. **The stack is the tell**: `sqlite3_js_db_export` / `saveDatabase` /
`saveToFile` means persistence, whatever the message says.

Two aggravators worth checking before fixing anything:

- Interleaved `Auto-save failed` lines mean the 30 s timer started a *second*
  full-size export while the first was still awaiting its write. Two concurrent
  exports measured at 5x database size against 3x for one.
- A save failure used to be able to null the conversation backfill's resume
  checkpoint, restarting it at zero on the next run. If a backfill keeps starting
  over, look at the save path, not the backfill.

Confirm with `getStatistics()`: `dbSizeBytes` is what the last save wrote, while
`pageCount * pageSizeBytes` is the logical size inside the WASM heap that every save
has to copy out. A large `freelistCount` means a `VACUUM` would shrink the blob. For a
per-table breakdown call `getObjectPageUsage()`, which reads `dbstat` and is on-demand
only because it walks every page.

Fix at the persistence layer, never by catching the `RangeError` at the call site. The
structural fix is `sqlite3_serialize` with `SQLITE_SERIALIZE_NOCOPY` plus a chunked
blob format, which brings the contiguous requirement from the full database size down
to one chunk. Note that the NOCOPY pointer moves when a `RESIZEABLE` database grows,
so it must be re-taken immediately before every use. OPFS is not the answer here: the
sahpool VFS needs a dedicated Worker because `createSyncAccessHandle` is
`[Exposed=DedicatedWorker]`. See `docs/plans/sqlite-cache-persistence-plan.md` and
`docs/plans/sqlite-cache-persistence-spike-findings.md`.

## "`await db.save()` returned, so the rows are on disk"

Usually true, and the two ways it is not are both silent.

`SQLiteCacheManager.save()` is `saveToFile()`, which branches three ways over a
write counter (`markDirty()` bumps `writeGeneration` on every write). Nothing in
flight: `startSave()` captures the generation **before** `saveDatabase` exports, so
the snapshot covers every write that had landed when the caller asked. Something in
flight and the generation has not moved: the caller joins it, because that export
already holds what this caller wants persisted. Something in flight and the
generation has moved: one follow-up is scheduled, shared by every caller that asks
while the first runs, and it exports after that one settles. All three branches mean
the same thing, so a resolved `save()` is a real durability point for the caller's
own writes. That is what lets an indexer treat a returned `save()` as proof
(`CacheSavePolicy.markSaveSuccess`), and it is why that call belongs on the path
where `save()` returned rather than in a `finally` beside the attempt.

**First exception: a cancelled follow-up resolves without writing anything.**
`scheduleFollowUpSave` returns early when `stopAutoSave()` or `close()` cancelled it,
or when the handle is already gone. That is protecting data, not cutting a corner:
Rebuild Cache calls `stopAutoSave()`, then `close()`, then `blobStore.remove()`, and
a follow-up landing after the remove would write the deleted database straight back.
The price is that the promise cannot distinguish a save that wrote from one that
stood down. Anything long-running that counts successful saves therefore has to stop
on unload and on rebuild for its own reasons; it cannot learn from the save that it
should.

**Second exception: a resolved save does not mean the cache is clean.**
`hasUnsavedChanges()` is still true when a write landed while the export was in
flight, because `startSave` clears the flag only if `writeGeneration` has not moved
since it captured it. Both facts hold at once and both are correct: the caller's rows
are in the snapshot, newer rows are not. Do not clear the flag to make them agree. It
is what stops rows that are in no snapshot anywhere from being dropped at `close()`,
and that matters most for data the event store cannot replay. Workspace and
conversation rows survive a lost snapshot because a rebuild replays them; embeddings
do not, so for those the flag is the only thing standing between a mid-save write and
a silent re-embed of the vault.
