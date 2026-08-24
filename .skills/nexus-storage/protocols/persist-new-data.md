# Protocol: persist something new

Context: run this when a feature needs data to survive a restart, a device switch,
or a cache rebuild — a new entity, a new field, or a new event on an existing
entity.

## Mission
Get the data into the event store and into the cache in that order, and prove it
survives a rebuild.

## Steps

1. Decide the layer. Read `../references/storage-model.md` first, then place the
   data:
   - **Durable domain data** → an event in the JSONL store, applied into SQLite.
     Follow the rest of this protocol.
   - **Derived or recomputable** (search indexes, embeddings, denormalized filter
     columns) → SQLite only, and it MUST be reconstructible during replay.
   - **User settings** → plugin settings, not this skill.
2. Resolve the path through a resolver, never a literal. `resolveVaultRoot` for
   event-store data, `resolvePluginStorageRoot` for plugin-scoped and cache paths.
   See `../references/paths-and-layout.md`. Remember this plugin runs on mobile:
   no Node built-ins at module scope.
3. Write through a repository in src/database/repositories, inside its transaction,
   in the order the existing ones use: append the JSONL event first, update SQLite
   second, invalidate the query cache third. WorkspaceRepository.create is the
   model to copy. NEVER write to SQLite alone.
4. Add the applier case. If you introduced a new `event.type`, add a `case` for it
   in the matching applier in src/database/sync (workspace, conversation, or task).
   Their `switch` has no default branch, so an unhandled type is silently dropped
   during replay — the data lives in JSONL and never reaches the cache again.
5. If the data needs new columns or tables, run `change-schema.md` now.
6. Guard the reads. Any read that can run during startup MUST await
   `waitForQueryReady()` when the adapter exposes it, or a cold cache renders as
   "no data". Copy the guard used by TaskBoardDataController or DualBackendExecutor.
7. Verify by destroying the cache. Create the data in a real vault, run
   "Nexus: Rebuild cache", **confirm the modal in Obsidian** (the CLI command
   returns after opening it, not after rebuilding), and confirm the data is still
   there afterwards. This is the only check that distinguishes persisted data
   from cached data; a passing unit test with a mocked adapter proves nothing
   about replay. Use `nexus-testing` for the in-app loop.
8. Stop condition: the data round-trips through a rebuild, and a test covers the
   applier case so the replay path cannot regress silently.

## Guidelines
- Pattern: model the change as an event ("task_archived"), not as a mutation of a
  row. Replay only knows about events.
- Pattern: if a query will filter on the new field, give it a column and backfill
  it rather than parsing JSON at read time.
- Anti-pattern: adding a field to the SQLite write and forgetting the event
  payload. It works all the way to the first rebuild.
- Anti-pattern: proving persistence with a mock. Mocks replay whatever you told
  them to; the appliers are the thing under test.

## Next
If anything failed to survive the rebuild, go to `diagnose-storage.md`. Otherwise
this is terminal — run `self-refine.md` at the end of the session.
