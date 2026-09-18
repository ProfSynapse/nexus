# SQLite Cache Persistence: Removing the Whole-Database Snapshot from the Hot Path (Scoping Document)

**Status:** In progress. Phase 0 landed (`83a732a`), Phase 3 answered (`8d5d732`), Phase 5 decided as Option D.
**Date:** 2026-09-18
**Driver:** Reproducible `RangeError: Array buffer allocation failed` during background embedding indexing on a large vault. Every full index dies partway through, loses everything embedded since the last successful save, and recomputes the same notes (at the same API cost) on the next launch. The stack always lands in `sqlite3_js_db_export`, never in the embedding provider.

---

## Amendments

This document was written before Phase 0 and Phase 3 ran. Both have now landed and
both corrected it. The original text below is left intact so the reasoning stays
readable; read these first.

**A1. Phase 3 is answered. The choice is Option D.** See
`docs/plans/sqlite-cache-persistence-spike-findings.md` (commit `8d5d732`) for the
measurements. `installOpfsSAHPoolVfs()` rejects on the Obsidian desktop renderer
main thread with `Missing required OPFS APIs`, because
`FileSystemFileHandle.prototype.createSyncAccessHandle` is `undefined` there: the
API is `[Exposed=DedicatedWorker]`. It resolves in 55 ms inside a dedicated Worker
in the same renderer. **Option C is therefore rejected for storage purposes** and
the rejection recorded at `docs/architecture/cloud-sync-cache-backend.md:140-149`
stands as factually correct; only its rationale was incomplete, in weighing
throughput rather than peak allocation. Option D measured at 152.4 MB brings the
maximum single contiguous allocation from 152.4 MB down to 4 MB, a 38x reduction,
at no wall-clock cost. Option E stays worth doing on its own merits but is a size
reduction, not a structural fix, so it is complementary and lower priority.

**A2. Section 7's premise was wrong, and the section title is wrong.** `node_modules`
was present and installable all along, and `.skills/nexus-testing/protocols/headless-obsidian.md`
stands up a real Obsidian headless in this class of container. Everything section 7
lists as unanswerable was answerable here, and was answered in about twenty minutes of
actual measurement. The lesson generalises: before recording a question as needing a
human's machine, run the repo's own protocol for standing the thing up.

**A3. The copy ledger in section 2 understates the cost.** The current export costs
**two** full-size allocations, not one: `sqlite3_serialize` copies the image inside
the WASM heap first, and `sqlite3_js_db_export` then copies that into JS. Measured
peak WASM heap was 310.6 MB resident for a 152 MB database, and it never shrinks.

**A4. Three implementation hazards for Phase 5, one of which this document did not
have.** A fresh `:memory:` database returns `ptr = 0` from NOCOPY and must fall back
to the existing export path; the size out-param is still populated, so the null is
cheap to branch on. A view over WASM memory detaches only when the heap grows, which
is narrower than section 2 assumed. And, the dangerous one: **the NOCOPY pointer
itself moves when a `RESIZEABLE` database grows** (`676904` to `58144672` after a
16 MB insert), leaving a cached pointer aimed at freed memory rather than throwing on
a detached view. Re-take the pointer immediately before every use.

**A5. `SQLITE_SERIALIZE_NOCOPY` is reachable and equals 1.** An earlier reading of
this repo inferred it was unavailable because it does not appear as a string in the
bundled `sqlite3.mjs`. That inference was wrong, and is falsifiable in one line:
`SQLITE_DESERIALIZE_RESIZEABLE`, which the shipping code at `SQLiteWasmBridge.ts:92`
already uses successfully, is equally absent from that file. Both live in an enum blob
inside `sqlite3.wasm` and are attached to `capi` at init. Relatedly, `oo1.OpfsSAHPoolDb`
does **not** exist on the module (`oo1` is exactly `{DB, Stmt, JsStorageDb}`); it is a
property of the object the installer resolves with. The declared type at
`SQLiteWasmBridge.ts:22-42` lists five `capi` entries where the runtime has 649, so
absence from that type proves nothing either.

---

## Problem

### 1. The log names the wrong culprit

The user-visible line is `[IndexingQueue] Failed to embed <path>`. No embedding failed.

| Evidence | What it shows |
|---|---|
| `src/services/embeddings/IndexingQueue.ts:458` | `await this.embeddingService.embedNote(notePath)` already returned. The vector is in the in-memory database. |
| `src/services/embeddings/IndexingQueue.ts:467-469` | `await this.db.save()` runs inside the same `try` block, every tenth note. |
| `src/services/embeddings/IndexingQueue.ts:471-473` | The `catch` labels whatever it caught as `Failed to embed ${notePath}`. A persistence failure is reported as an embedding failure, attributed to whichever note happened to be tenth. |
| `src/services/embeddings/TraceIndexer.ts:134-141` | The trace indexer already worked this out and says so in a comment: `embedTrace()` never rethrows, so the only thing that can reach that `catch` is the periodic `db.save()`. The note path never got the same treatment. |

So finding 1 of the reported diagnosis holds, with one correction: the cited line for the periodic save is 467 (the `if`), 468 (the `save()`), not 467 alone.

### 2. The cost of one save

`SQLiteCacheManager.save()` (`src/database/storage/SQLiteCacheManager.ts:647-649`) is `saveToFile()` (`:364-369`), which is `SQLitePersistenceService.saveDatabase` (`src/database/storage/SQLitePersistenceService.ts:98-116`). That method does exactly two things, and both of them allocate a copy of the entire database.

| Step | Code | Allocation |
|---|---|---|
| Export | `SQLitePersistenceService.ts:106` calls `bridge.exportDatabase`, which is `module.capi.sqlite3_js_db_export(db).buffer` (`src/database/storage/SQLiteWasmBridge.ts:102-104`) | One contiguous `ArrayBuffer` on the JS heap, the full size of the database, copied out of the WASM linear memory |
| Write (desktop) | `SQLitePersistenceService.ts:111` calls `blobStore.write(buffer)`, which is an IndexedDB `put` (`src/database/storage/IndexedDBCacheBlobStore.ts:62-76`) | IndexedDB structured-clones the buffer. `docs/architecture/cloud-sync-cache-backend.md:453-456` records that `transfer: [buffer]` is not accepted on `put`, so this copy cannot be eliminated at this seam |
| Write (mobile) | Same call reaches `vault.adapter.writeBinary` (`src/database/storage/VaultAdapterCacheBlobStore.ts:35-41`) | A second full-size buffer crosses into the platform file write |

Peak live bytes per save are therefore roughly three times the database size: the WASM heap copy that never shrinks, the exported JS-heap copy, and the backend's own copy. `VaultAdapterCacheBlobStore.ts:9-14` names the figure in the source itself ("the 150+ MB blob"), and `docs/architecture/cloud-sync-cache-backend.md` was written against a measured 162 MB cache.

Two corroborating details in the code:

- `SQLiteCacheManager.ts:272-276` suppresses a console pattern `/Heap resize call/` during module init. The WASM heap grows and does not give memory back.
- `docs/plans/notes-query-index-plan.md` §4 already identified this as "the hard wall" at 300k to 500k rows and designed around it. That design decision was later reversed in practice (see §5 below).

Finding 2 of the reported diagnosis holds. `saveDatabase` starts at line 98, and the export is at line 106.

### 3. Cadence, and the absence of a lock

| Evidence | What it shows |
|---|---|
| `IndexingQueue.ts:76` | `SAVE_INTERVAL = 10`. A full snapshot every ten notes, unconditionally, regardless of database size. |
| `ConversationIndexer.ts:70` and `TraceIndexer` construction | Both default to `saveInterval = 10` as well. |
| `SQLiteCacheManager.ts:127` | `autoSaveInterval` defaults to 30000 ms. |
| `SQLiteCacheManager.ts:334-342` | A `window.setInterval` fires `saveToFile()` whenever `hasUnsavedData` is true, with no awareness of any save already running. |
| `SQLiteCacheManager.ts:364-369` | `saveToFile()` has no in-flight guard. Two calls overlap freely and each allocates its own export buffer. |
| `EmbeddingManager.ts:352-382` | Three indexing phases run back to back, each with its own save cadence. The comment there notes a vault of 18k notes takes hours. |

The dirty flag makes the overlap certain rather than merely possible. `hasUnsavedData` is cleared at `SQLiteCacheManager.ts:368`, after the awaited write completes. While a queue-driven save is in flight, the flag is still true, so the 30 s timer is guaranteed to start a second full-size export rather than skip. The interleaved `Auto-save failed` lines in the reported log are exactly this.

Finding 3 holds and is slightly understated.

### 4. Why the failure is an allocation failure and not exhaustion

A `RangeError` from `new ArrayBuffer` / `Uint8Array.slice` is the allocator refusing one contiguous request. With hundreds of allocate-and-discard cycles of 150 MB or more per full index, plus a WASM heap that only grows, the JS heap fragments until no single 150 MB contiguous run remains even though total free memory is larger than that. Finding 4 holds. It also predicts the observed pattern that the first few saves succeed and later ones fail, which a flat "out of memory" would not.

### 5. Why it never converges

| Evidence | What it shows |
|---|---|
| `IndexingQueue.ts:478` | The final `await this.db.save()` sits outside the per-note `try` and inside the outer one. |
| `IndexingQueue.ts:488-497` | Its throw is caught by the outer handler, which logs `Processing failed` and emits phase `error`. |
| `IndexingQueue.ts:480-486` | Phase `complete` is never reached, so nothing downstream records that the run finished. |
| `SQLiteCacheManager.ts:383-385` | `close()` saves only when `hasUnsavedData` is true, through the same failing path. |

Everything embedded since the last successful save lives only in the in-memory database and is discarded at restart. The next run recomputes the same notes, reaches the same size, and dies at the same point. Finding 5 holds.

### 6. Where the reported diagnosis is wrong or incomplete

**6a. The dirty flag is not correct. It has a lost-update window.**

The diagnosis asked that `hasUnsavedData` be declared correct so nobody "fixes" it. It is not correct, and this should be fixed.

`saveToFile()` (`SQLiteCacheManager.ts:364-369`) exports at line 367 and clears the flag at line 368, after the await. Any `run()` that lands during that await sets the flag to true (`SQLiteCacheManager.ts:451`), and line 368 then clears it. Those rows are not in the snapshot that was just written and are now marked as saved. If no further write follows, the 30 s timer skips (the flag is false) and `close()` skips (`:383`), and the rows are lost at shutdown with no error anywhere.

This is latent today because indexing writes constantly, so the flag gets re-set almost immediately. It becomes a real data-loss path the moment the save interval is lengthened, which is precisely what Level 1 proposes. The correct shape is a dirty counter or a generation number captured before the export and compared after the write.

**6b. The conversation backfill wipes its own resume checkpoint on a save failure.**

`ConversationIndexer.ts:239` is the final save. Its throw is caught at `:243`, and the handler at `:245-251` writes `lastProcessedConversationId: null`, `processedConversations: 0`. The resume logic at `:153-161` keys entirely off `lastProcessedConversationId`, so a null checkpoint restarts the backfill at conversation zero.

Nuance that keeps this from being fatal today: that write is itself an in-memory `db.run`, so it only becomes durable if some later save succeeds. In a session where saves are failing it never lands. It is a live bug whenever a save fails transiently and a later one succeeds, and it costs a full re-embed of every conversation in API calls.

`TraceIndexer.ts:149` is safer by accident: its outer `catch` at `:151-153` swallows and returns normally, so a failed final save does not abort anything. That is inconsistent with `IndexingQueue`, which aborts, and with `ConversationIndexer`, which corrupts its checkpoint. Three call sites, three different behaviours for the same failure.

**6c. "The cache is 150 MB because of messages, FTS5 and vec0" is at best half the story.**

The out-of-scope hypothesis needs correcting before someone spends a week on the wrong table.

- The FTS5 tables are **external-content** (`content='workspaces'`, `content='conversations'`, `content='messages'` at `src/database/schema/schema.ts:192-197, 217-222, 241-248`). They store the index, not a second copy of the text. They are not small, but they are not duplicates.
- The `notes` and `note_properties` tables **are persisted**, and they are per-note, vault-sized, and hold JSON. `schema.ts:518-549` defines them; `SchemaMigrator.ts:482-514` is migration v14 that added them to the owned schema; `CURRENT_SCHEMA_VERSION` is 16 (`SchemaMigrator.ts:78`). `notes` carries `tags_json`, `links_json` and `frontmatter_json` per note, and `note_properties` is an EAV row per frontmatter key with three indexes (`schema.ts:547-549`).
- This directly reverses decision 4 of `docs/plans/notes-query-index-plan.md`, which chose **not** to persist the notes tables specifically to sidestep "the one thing that actually breaks at scale (whole-DB blob serialization on save)". §4 of that plan estimates 2.5 to 3.5 KB per note all-in, which is roughly 150 MB at 50k notes. The reasoning that reversed it is sound and recorded in `schema.ts:505-516` and in the storage skill's "no such table after a rebuild" entry: a table any code issues SQL against must exist on the fresh-install path. The consequence for blob size was not revisited.
- Every startup rebuild of the notes index writes through `NotesIndexService.ts:86` and `:166`, which call `sqlite.run` and therefore set `hasUnsavedData` (`SQLiteCacheManager.ts:451`). A derived-from-the-vault index that is rebuilt at startup anyway is dirtying the database and paying for a 150 MB snapshot to persist rows it will overwrite next launch.

The size investigation should start at `notes` plus `note_properties`, not at `messages`. If those two turn out to be most of the blob, the cheapest structural fix in this whole document may be to move them to a second, unpersisted database handle, which would make Level 2 far less urgent.

**6d. The storage skill does not document this failure mode at all.**

`.skills/nexus-storage/references/failure-modes.md` covers corrupt caches, hydration races, rebuild semantics, cloud-sync conflict copies and the post-unload write burst. It has no entry for allocation failure during save, and `.skills/nexus-storage/references/storage-model.md` does not mention the export cost. A future reader hitting `Failed to embed <path>` has nothing in the skill that points at persistence. Adding that entry is a deliverable of this plan, not an afterthought (Phase 4).

### 7. What we did not know when this was written (now answered, see A1 and A2)

> **Superseded.** Every question in this section was answerable in this container and
> has been answered. Kept for the reasoning; read `sqlite-cache-persistence-spike-findings.md`
> for the results. The premise below, that `node_modules` was unavailable, was false.

`node_modules` is not present in this working tree, so the bundled sqlite3 build could not be inspected directly. What the repo does tell us:

| Evidence | What it shows |
|---|---|
| `package.json:63` | `@dao-xyz/sqlite3-vec` at `^0.0.19`, one dependency, sqlite-vec compiled into the WASM |
| `esbuild.config.mjs:8-11` | The WASM binary is `<pkg>/sqlite-wasm/jswasm/sqlite3.wasm`, copied to the plugin folder at build time (`:29-42`) |
| `esbuild.config.mjs:84-87` | `@dao-xyz/sqlite3-vec/wasm` is aliased to the package's `index.mjs` specifically to reach `sqlite3.capi` for serialize and deserialize |
| `SQLiteCacheManager.ts:264-267` | The binary is read at runtime through `vault.adapter.readBinary`, not inlined |
| `SQLiteWasmBridge.ts:59-76` | It is handed to the module factory via `instantiateWasm`, so the module never fetches its own `.wasm` |
| `SQLiteCacheManager.ts:273` | Init suppresses a console pattern `/OPFS sqlite3_vfs/`. **The bundled glue does contain OPFS VFS code and says something about it on every start.** Whether that is "installed" or "unavailable" is exactly what nobody has read, because the line is suppressed. |
| `SQLiteWasmBridge.ts:22-42` | The declared `SQLiteWasmModule` type exposes only `oo1.DB`, `wasm.allocFromTypedArray` and five `capi` entries. There is no `installOpfsSAHPoolVfs` and no `sqlite3_serialize`. This is a TypeScript surface, not a runtime limit, but it means nobody has tried. |
| `docs/architecture/cloud-sync-cache-backend.md:140-149` | OPFS was formally considered and rejected (question O5) on the grounds that it "requires a dedicated Web Worker for `createSyncAccessHandle`" and that at a 30 s cadence the speed gain was invisible. The same section names OPFS the upgrade path if SQLite execution ever moves into a Worker, and says `CacheBlobStore` was shaped to permit a third implementation. |

Two things follow. First, the prior rejection was decided on **throughput**, not on **peak allocation**, and it predates this failure. It should be revisited, not treated as settled. Second, the single load-bearing question (does `opfs-sahpool` install and work from the Obsidian desktop renderer's main thread, in this exact bundled build) is an empirical one that takes about an hour to answer and cannot be answered by reading. Phase 1 is that spike.

### 8. Mobile is a hard constraint, and it constrains more than it looks

`createCacheBlobStore` (`src/database/storage/CacheBlobStoreFactory.ts:21-30`) sends desktop to IndexedDB and mobile to `vault.adapter`. That split is not a preference: `docs/architecture/cloud-sync-cache-backend.md:183` records question O3 as resolved in favour of `vault.adapter` on mobile because iOS WKWebView IndexedDB durability is too weak for a blob this size, and `VaultAdapterCacheBlobStore.ts:9-14` repeats it in the source.

OPFS on iOS lives in the same WebKit-managed, evictable origin storage bucket as IndexedDB. Any OPFS-based cache on mobile therefore walks straight back into the durability problem that decision was taken to escape, independent of whether the API is even exposed in Obsidian's mobile webview. **Treat "OPFS on mobile" as rejected on durability grounds before API availability is even reached.** Anything Level 2 does must keep mobile on a real file under `vault.adapter`, or leave mobile on the current path with a lower cadence.

Worker feasibility is not zero: `src/agents/apps/dataAnalysis/services/PyodideSandbox.ts:85`, `src/services/llm/adapters/webllm/WebLLMWorkerService.ts:52` and `src/services/embeddings/ConversationEmbeddingWatcher.ts:68` all construct Workers today. But note that `esbuild.config.mjs:88-91` documents a plugin-store scanner that objects to dynamic script loading, and a blob-URL Worker is adjacent to that. Any Worker plan needs `nexus-mobile-compat` review and a `node scripts/check-mobile-imports.mjs .` pass.

### 9. Existing test coverage, and the gaps

| File | Covers | Does not cover |
|---|---|---|
| `tests/unit/SQLitePersistenceService.test.ts` | Fresh-database creation, that `saveDatabase` writes the exported buffer to the store, corrupt-cache recovery and its logging, silence on benign launches | Any save failure. Any concurrency. The word "throw" appears only for integrity checks. |
| `tests/unit/SQLiteCacheManager.test.ts` | Transaction serialization, sync state, pagination, maintenance, statistics | `saveToFile`, the autosave timer, `hasUnsavedData` transitions, overlap |
| `tests/unit/IndexingQueueDestroy.test.ts` | Teardown and the destroyed flag across all three phases | `processQueue` itself, save cadence, what a save failure does to the run |
| `tests/unit/VaultAdapterCacheBlobStore.test.ts`, `tests/unit/IndexedDBCacheBlobStore*.test.ts`, `tests/unit/CacheBlobStoreFactory.test.ts` | Round-trip, absent blob, zero-byte blob, mkdir, metadata, platform selection | Write failure propagation, large-buffer behaviour |
| `tests/unit/CacheBackendMigration.test.ts`, `.edge.test.ts` | The five-state migration, verify-and-retry, the janitor, self-heal | Nothing about memory cost of the migration itself |
| `tests/perf/startup-rebuild-large-trace-store.test.ts` | The pattern for a large-fixture perf lane | Save-path allocation |

No test anywhere asserts that a failed save is reported as a failed save, that two saves cannot overlap, or that a failed final save does not abort a queue run. All three are the behaviours Level 1 changes.

---

## Options

Five candidates. A and B are Level 1 and are additive to each other. C, D and E are the Level 2 candidates and are mutually exclusive.

### Option A: In-flight lock plus coalescing (Level 1, recommended)

Give `SQLiteCacheManager` a single-flight save. A save requested while one is running returns the in-flight promise if no writes have happened since that export began, and otherwise schedules exactly one follow-up. Never two buffers at once. Replace the boolean `hasUnsavedData` with a monotonically increasing write generation so the lost-update window in §6a closes: capture the generation before `exportDatabase`, and after a successful write record "saved through generation N" rather than clearing a flag.

- **Files touched:** 1 (`src/database/storage/SQLiteCacheManager.ts`), plus tests
- **LOC:** roughly 60 changed, mostly new
- **Risk:** Low. The public surface (`save()`, `hasUnsavedChanges()`, `stopAutoSave()`, `close()`) is unchanged. `StorageMaintenanceService.rebuildCache` (`src/database/adapters/lifecycle/StorageMaintenanceService.ts:103-161`) already calls `stopAutoSave()` before `close()`, so the rebuild path is compatible; the one thing to verify is that a pending coalesced save cannot resurrect a blob the rebuild has just removed at `:124`. Make `close()` and `stopAutoSave()` cancel the follow-up.
- **Result:** Halves or better the worst-case peak by removing simultaneous exports. Removes a silent data-loss window. Does not reduce the size of a single allocation, so a database large enough to fail a single 150 MB allocation still fails.

### Option B: Size-aware cadence and honest failure reporting (Level 1, recommended)

Three independent behaviour fixes, all cheap:

1. Replace the flat `SAVE_INTERVAL = 10` with a budget: save when either N items have been processed **or** T seconds have elapsed since the last successful save, whichever is later, with N scaled off `blobStore.getMetadata()`'s reported size. `CacheBlobStore.getMetadata()` already exists and is contractually cheap ("MUST NOT read the blob bytes", `src/database/storage/CacheBlobStore.ts:33-38`), and `SQLiteMaintenanceService.getStatistics` already uses it for `dbSizeBytes` (`src/database/storage/SQLiteMaintenanceService.ts:123-142`). Nothing new has to be built to measure size.
2. Move the periodic `db.save()` out of the per-item `try` in all three indexers, or wrap it in its own `try` that logs a save failure as a save failure. Call sites: `IndexingQueue.ts:467-469`, `ConversationIndexer.ts:216-224`, `TraceIndexer.ts:130-132`.
3. Make the final save non-fatal and consistent across the three. `IndexingQueue.ts:478` should not be able to prevent phase `complete`; a run that embedded 4000 notes and could not write the snapshot is a partial success with a loud warning, not an aborted run. `ConversationIndexer.ts:245-251` must stop writing a null checkpoint on a save failure: preserve `lastProcessedConversationId` and `processedConversations` so the resume at `:153-161` still works.

- **Files touched:** 4 (`IndexingQueue.ts`, `ConversationIndexer.ts`, `TraceIndexer.ts`, `SQLiteCacheManager.ts` for the size accessor), plus tests
- **LOC:** roughly 80
- **Risk:** Low to medium. The risk is in the other direction: a longer save interval means more work lost when a save does fail, which is why Option A's generation counter must land with it or before it.
- **Result:** Snapshot count during a full index drops by one to two orders of magnitude. On a vault where the current run does roughly 1800 exports for 18k notes, a 60 s floor at realistic embedding speeds brings that into the low hundreds. The user sees far fewer failures and, critically, sees the truth about what failed. The 150 MB allocation still happens, just far less often.

### Option C: Move SQLite onto an OPFS VFS on desktop, keep mobile as is (Level 2 candidate)

Open the database as a file in an OPFS-backed VFS (`opfs-sahpool`) rather than `:memory:`, so SQLite writes pages through the VFS and `db.save()` becomes a no-op or a checkpoint. No export, no blob, no `CacheBlobStore` on desktop. Mobile stays exactly where it is on `VaultAdapterCacheBlobStore`, per §8.

- **Files touched:** `SQLiteWasmBridge.ts`, `SQLitePersistenceService.ts`, `SQLiteCacheManager.ts`, `CacheBlobStoreFactory.ts` (a third backend or a bypass), a new migration alongside `CacheBackendMigration.ts`, plus the mobile/desktop divergence in `SQLiteMaintenanceService` and `StorageMaintenanceService.rebuildCache`
- **LOC:** 400 to 700, plus migration
- **Risk:** **High, and largely unquantified.** Four independent unknowns, in descending order of how badly a "no" hurts:
  1. Does `opfs-sahpool` install from the Obsidian desktop **main thread** in this bundled build? If it needs a dedicated Worker (which `docs/architecture/cloud-sync-cache-backend.md:143-145` asserts, and which the `createSyncAccessHandle` specification supports), then every SQLite call has to cross a message boundary. The good news is the public surface is already asynchronous: `SQLiteCacheManager.query/queryOne/run/exec` all return promises (`SQLiteCacheManager.ts:402-457`), and the bridge is referenced by only three files (`SQLiteCacheManager.ts`, `SQLiteMaintenanceService.ts`, `SQLitePersistenceService.ts`). The bad news is the two genuinely synchronous seams: the `DatabaseAdapter` that `SchemaMigrator` consumes (`SQLiteCacheManager.ts:78-92`) and the synchronous `migrationFn: (db: MigratableDatabase) => void` signature used by migrations at `SchemaMigrator.ts:229, 377, 582`. Those have to become async, across 16 schema versions of existing code.
  2. Do `vec0` and the three FTS5 tables work unchanged under a different VFS? Almost certainly yes in principle, because a VFS is below the pager and virtual tables are above it, and both keep their data in ordinary shadow tables in the same database file. But `vec0` is a third-party extension compiled into this specific WASM, so this needs to be demonstrated, not argued. The cheap demonstration is: create a database on the VFS, insert a vector, run a KNN query, run an FTS5 `MATCH`, close, reopen, query again.
  3. Does the Obsidian desktop renderer expose OPFS at all, under whatever origin Electron gives it, and is it stable across Obsidian versions? A plugin has no control over the renderer's origin.
  4. What happens to durability and to "Rebuild cache"? OPFS data lives in the Electron renderer's storage area, same neighbourhood as the current IndexedDB blob, so the cloud-sync immunity in `docs/architecture/cloud-sync-cache-backend.md` is preserved. `StorageMaintenanceService.rebuildCache:124` currently calls `blobStore.remove()`; it would need an equivalent that deletes the VFS file.
- **Result:** If it works, the problem is gone rather than reduced. Peak allocation per write becomes one page, and the WASM heap stops holding the whole database. It also removes the 30 s autosave concept entirely on desktop. This is the only option that makes the failure structurally impossible.

### Option D: Keep the in-memory database, remove the redundant copies (Level 2 fallback, recommended if C fails)

If OPFS is not viable, attack the copy ledger from §2 directly. Two independent reductions:

1. **Export without the JS-heap copy.** `sqlite3_js_db_export` copies. The underlying `sqlite3_serialize` with `SQLITE_SERIALIZE_NOCOPY` returns a pointer into the WASM heap for a database in serialized mode, which this one is on the load path: `deserializeDatabase` passes `SQLITE_DESERIALIZE_RESIZEABLE` at `SQLiteWasmBridge.ts:91-92`. A `Uint8Array` view over WASM memory at that pointer costs nothing. Caveats that must be stated honestly: a database created fresh with `:memory:` (`SQLiteWasmBridge.ts:78-80`, used by `createFreshDatabase` at `SQLitePersistenceService.ts:137-141`) is **not** in serialized mode, so the first save after a fresh install or a rebuild still needs the copy path; and any view over WASM memory detaches if the heap resizes, so nothing may `await` between taking the view and consuming it. Neither `sqlite3_serialize` nor its flags are in the declared module type at `SQLiteWasmBridge.ts:22-42`, so availability in this build needs checking.
2. **Write in chunks.** Split the blob across N IndexedDB records, or write the mobile file in segments. Each chunk is a slice of at most a few MB, so the backend's copy stops being full-size. This changes the on-disk and in-IDB format and therefore needs a migration and a matching change to `read()`, `getMetadata()` and `CacheBackendMigration.verifyIdb` (`src/database/migration/CacheBackendMigration.ts:242-261`), which compares a single size.

- **Files touched:** `SQLiteWasmBridge.ts`, `SQLitePersistenceService.ts`, both blob stores, `CacheBlobStore.ts`, `CacheBackendMigration.ts`
- **LOC:** 250 to 400
- **Risk:** Medium. Every piece is local and testable. The chunked format is a real migration with a real compatibility window.
- **Result:** Peak drops from roughly 3x the database to roughly 1x (the WASM heap) plus one chunk. That is a 150 MB contiguous requirement turned into a few MB contiguous requirement. It does not stop the WASM heap growing, and it does not make saves cheap in time, so Option B's cadence work is still needed alongside. It works identically on both platforms, which is its main advantage over C.

### Option E: Split the persisted database in two (Level 2 candidate, worth measuring before choosing)

Move the vault-derived, rebuilt-at-startup tables (`notes`, `note_properties`, and the vec0 tables if the embeddings are made recoverable) into a second database handle that is never persisted, restoring the intent of `docs/plans/notes-query-index-plan.md` decision 4 while keeping the "the schema owns every table" rule from `schema.ts:505-516` by giving the second handle its own `SCHEMA_SQL`.

- **Files touched:** `schema.ts`, `SchemaMigrator.ts`, `SQLiteCacheManager.ts`, `NotesIndexService.ts`, `NotesIndexBuilder.ts`, anything that joins `notes` against a persisted table
- **LOC:** unknown until the size measurement lands, plausibly 300+
- **Risk:** Medium to high. Cross-database joins are the killer: if any query joins `notes` to a persisted table, the split does not work without `ATTACH`, and whether `ATTACH` is usable across two `:memory:` handles in this build is another unknown.
- **Result:** If §6c is right and the notes tables are most of the blob, this shrinks the persisted database enough that the whole problem may drop below the threshold, at no architectural risk to the VFS. If §6c is wrong, it buys nothing. **Do not commit to this until the size measurement from Phase 0 exists.** It is listed here so the measurement has a decision attached to it.

### Rejected: Option F, OPFS on mobile, or any single cross-platform OPFS backend

Rejected outright, before API availability is considered. `docs/architecture/cloud-sync-cache-backend.md:183` and `VaultAdapterCacheBlobStore.ts:9-14` both record that mobile was deliberately moved off browser-managed storage because iOS WKWebView durability under storage pressure was too weak for a blob this size. OPFS on iOS is in the same evictable origin bucket. Adopting it would re-introduce a data-loss mode the project has already diagnosed and fixed, in exchange for solving a memory problem that mobile may not even have at the same severity. `isDesktopOnly: false` means a mobile regression is not a partial failure, it is a failure. Any Level 2 work is desktop-only or platform-symmetric by construction.

### Rejected: throwing more memory at it

There is no Electron flag a community plugin can set, and the failure is fragmentation rather than exhaustion, so a larger heap postpones rather than fixes.

---

## Recommendation

Phased. Each phase is an independent, behaviour-preserving-or-better PR. Phases 0 through 3 are unconditional. The Level 2 choice is deliberately deferred to a spike, because the honest answer today is that nobody in this repo has run the experiment.

### Phase 0: Characterization tests and the size measurement (blocker for everything else)

No production behaviour changes. All in `tests/unit/` except where noted, which is lane 1 in `.skills/nexus-testing/references/lanes.md` (mocked Jest). These test pure coordination logic against fakes, so lane 1 is honest here: the thing under test is the ordering and the error routing, not SQLite.

| Test | File | What it pins down |
|---|---|---|
| `save() rejects and the rejection reaches the caller` | `tests/unit/SQLitePersistenceService.test.ts` | A `blobStore.write` rejection propagates out of `saveDatabase` after logging (`SQLitePersistenceService.ts:112-115`). Currently untested. |
| `a second save() while one is in flight starts a second export` | `tests/unit/SQLiteCacheManager.test.ts` | The current overlapping behaviour, so Phase 1 can invert the assertion |
| `the autosave timer fires while a save is in flight` | `tests/unit/SQLiteCacheManager.test.ts` | That `hasUnsavedData` is still true mid-save and the timer does not skip (`SQLiteCacheManager.ts:334-342`) |
| `a write during an in-flight save is marked clean by that save` | `tests/unit/SQLiteCacheManager.test.ts` | The §6a lost-update window, explicitly, as a **failing-is-correct** characterization with a comment saying Phase 1 flips it |
| `close() skips the save when the flag is false` | `tests/unit/SQLiteCacheManager.test.ts` | The consequence of the above (`SQLiteCacheManager.ts:383-385`) |
| `a save failure is logged as a failure to embed the tenth note` | new `tests/unit/IndexingQueueSavePath.test.ts` | The mislabelling at `IndexingQueue.ts:471-473`. Phase 2 flips it. |
| `a failing final save aborts the run and never reaches phase complete` | new `tests/unit/IndexingQueueSavePath.test.ts` | `IndexingQueue.ts:478` against `:488-497`. Phase 2 flips it. |
| `a failing final save nulls the conversation resume checkpoint` | `tests/unit/` alongside the existing conversation indexer tests | §6b. `ConversationIndexer.ts:239` into `:245-251`, read back through the resume path at `:153-161`. Phase 2 flips it. |
| `a failing periodic save does not abort the trace run` | same | `TraceIndexer.ts:130-142`, the one call site that is already safe. Pins it so a consistency refactor does not break it. |
| `peak buffer allocation during one save` | new `tests/perf/cache-save-allocation.test.ts` | Follows the pattern of `tests/perf/startup-rebuild-large-trace-store.test.ts`. Instruments a fake bridge and a fake blob store to count and sum live buffers across one save and across an overlapping pair. This is the number every later phase is measured against. |

`ConversationIndexer.ts` and `TraceIndexer.ts` are already in `collectCoverageFrom` with per-file thresholds (`jest.config.js:25-26, 144-155`), so tests there raise coverage and nothing else. `SQLiteCacheManager.ts` is **not** in the allowlist: per `.skills/nexus-testing/references/lanes.md`, adding it without its own `coverageThreshold` entry pulls the global number down and reds the run. Either add both or add neither.

**Also in Phase 0, and separately shippable: the size measurement.** Extend `SQLiteMaintenanceStatistics` (`SQLiteMaintenanceService.ts:8-18`, which already carries `dbSizeBytes` from `blobStore.getMetadata()`) with a per-table row count for `notes`, `note_properties`, `embedding_metadata`, `trace_embedding_metadata` and `conversation_embedding_metadata`, and log `dbSizeBytes` once per successful save at a level a user can find. That is the data the separate size investigation needs, it is nearly free, and it is what decides whether Option E is worth anything. If `PRAGMA page_count` and `PRAGMA freelist_count` are available in this build, add them; if `dbstat` is compiled in, a per-table page breakdown settles §6c outright.

### Phase 1: The save lock and the generation counter (Option A)

Single file, inverts three Phase 0 assertions. Verify against `StorageMaintenanceService.rebuildCache` (`:103-161`) that a coalesced follow-up cannot write after `blobStore.remove()` at `:124`.

### Phase 2: Cadence and honest failures (Option B)

Depends on Phase 1, because lengthening the interval without the generation counter widens the §6a window. Inverts the remaining Phase 0 assertions. Include the `ConversationIndexer` checkpoint fix from §6b, which is the highest-value single line in this whole document measured in dollars of re-embedding.

After Phase 2, run the in-app loop from `.skills/nexus-testing/protocols/live-loop.md` on a real large vault. Jest cannot see this: the failure is allocator behaviour in a running renderer.

### Phase 3: The Level 2 spike (one to two days, timeboxed, no production code)

Answer, in the running Obsidian desktop renderer, with `node_modules` installed:

1. Remove the `/OPFS sqlite3_vfs/` suppression at `SQLiteCacheManager.ts:273` locally and read what the bundled glue actually says on init. This is free and may answer half the question.
2. `Object.keys(sqlite3)` and `Object.keys(sqlite3.capi)` after `initializeModule`. Record whether `installOpfsSAHPoolVfs`, `oo1.OpfsSAHPoolDb`, `sqlite3_serialize` and `SQLITE_SERIALIZE_NOCOPY` exist.
3. If the sahpool installer exists, call it from the main thread and record whether it resolves or rejects. This single result decides Option C versus Option D.
4. If it resolves: open a database on that VFS, create a `vec0` table and an FTS5 table matching `schema.ts:192-248` and `:302-390`, insert, query, close, reopen, query again. Record the result. This is the `vec0`/FTS5 evidence the plan currently cannot supply.
5. Measure peak allocation for the Option D export path (`sqlite3_serialize` + `NOCOPY` + a WASM-memory view) against the current path, on a real 150 MB cache, using the Phase 0 perf harness plus renderer memory sampling.
6. Read the mobile answer off §8 rather than spiking it: mobile stays on `vault.adapter`.

The spike's deliverable is an amendment to this document recording the answers, and a choice between Option C, Option D and Option E. Nothing ships in Phase 3.

### Phase 4: Write the failure mode into the storage skill (do not skip)

`.skills/nexus-storage/references/failure-modes.md` has no entry for this class (§6d). Add one, to the `.skills/` source, then run `npm run sync:skills` to propagate into `.claude/skills/`, `.codex/skills/` and `.cline/skills/`, per CLAUDE.md. The `.skills/` tree is the source; a change made directly in a mirror is reverted on the next sync. The mirrors are byte-identical today, so the sync is the only correct way to touch them.

The entry, in the house symptom-to-cause-to-fix shape:

> **"RangeError: Array buffer allocation failed", or "Failed to embed \<path\>" on a large vault**
>
> Not an embedding failure and not out-of-memory. The cache is persisted by exporting the **entire** database out of the WASM heap into one contiguous JS `ArrayBuffer` and handing it to the blob store, which copies it again (`SQLiteWasmBridge.exportDatabase`, `SQLitePersistenceService.saveDatabase`). Peak live memory per save is about three times the database size, and the WASM heap never shrinks. At a 150 MB cache and a save every ten notes, a full index performs hundreds of allocate-and-discard cycles and the JS heap fragments until no contiguous run that size remains.
>
> It is reported as an embed failure because the periodic `db.save()` sits inside the per-note `try` in `IndexingQueue`. `TraceIndexer` has the same shape and says so in a comment. The stack is the tell: `sqlite3_js_db_export` / `saveDatabase` / `saveToFile` means persistence, whatever the message says.
>
> Confirm before fixing: look at `dbSizeBytes` from `getStatistics()`, and check whether `Auto-save failed` lines are interleaved with the per-note ones (the 30 s timer has no in-flight lock, so it starts a second full-size export while the first is still awaiting its write).
>
> Fix at the persistence layer, never by catching the RangeError at the call site. See `docs/plans/sqlite-cache-persistence-plan.md`.

Also add one line to `storage-model.md` next to "SQLite is rebuildable": rebuildable does not mean cheap, because embeddings are not in the event store (see Migration below).

### Phase 5: Implement whichever of C, D or E the spike chose

Scoped after Phase 3. Do not pre-commit.

---

## Migration, and what a rebuild actually costs

Two facts change the shape of any Level 2 migration.

**First: a migration that reads the whole blob hits the very bug it is migrating away from.** `CacheBackendMigration.readLegacy` (`src/database/migration/CacheBackendMigration.ts:230-236`) does `adapter.readBinary` on the whole file, then `writeIdb` (`:238-240`) writes it whole, then `verifyIdb` (`:242-261`) may read it whole again as a fallback. On the machine that motivated this plan, a straight copy of that pattern would need three simultaneous 150 MB buffers and would fail during migration. Any new backend migration must either move data in chunks, or open the old database and copy it table by table into the new one (`INSERT INTO new.t SELECT * FROM old.t`, one table at a time, which never materializes the whole thing in JS), or accept a rebuild.

**Second: a rebuild is safe but not cheap, and the expensive part is invisible.** `StorageMaintenanceService.rebuildCache` (`src/database/adapters/lifecycle/StorageMaintenanceService.ts:103-161`) stops autosave, closes, removes the blob, reopens an empty database from `SCHEMA_SQL`, replays the JSONL event store via `SyncCoordinator.fullRebuild`, and fires `cache-rebuilt`. The JSONL store is never touched, exactly as `.skills/nexus-storage/references/storage-model.md` describes, so no user data is lost.

But embeddings are not user data in that sense, and they are not in the event store. Verified:

| Evidence | What it shows |
|---|---|
| `src/services/embeddings/NoteEmbeddingService.ts:173, 183, 190` | Note vectors and their metadata are written with `db.run` straight into SQLite |
| `src/services/embeddings/ConversationEmbeddingService.ts:135` | Same for conversation QA-pair vectors |
| `src/database/interfaces/StorageEvents.ts` | No embedding event type exists. The event union has no `embedding_*` member. |
| `src/database/sync/` | The three appliers (`WorkspaceEventApplier`, `ConversationEventApplier`, `TaskEventApplier`) have no embedding case, because there is no event to apply |
| `src/services/embeddings/EmbeddingManager.ts:365-366` | The code already knows: it notes that `clearAllData()` drops conversation embeddings on every full rebuild |
| `src/database/storage/SQLiteMaintenanceService.ts:77-78` | `clearAllData` drops and recreates `conversation_embeddings` outright |

**So the reported assumption is correct: embeddings do not survive a rebuild and are recomputed from scratch, at full API cost.** For a vault of 18k notes that is 18k embedding calls plus hours of wall clock (`EmbeddingManager.ts:362-363` says as much), and with the current save path that recomputation is exactly the workload that fails. A rebuild is therefore an acceptable **correctness** fallback and an unacceptable **default** migration path. If a Level 2 migration ends up choosing rebuild, the user must be told what it costs before it runs, in the same spirit as the sticky Notice at `CacheBackendMigration.ts:201-204`.

There is a cheaper middle path worth costing during Phase 3: export only the embedding tables (`note_embeddings`, `embedding_metadata`, and the trace and conversation equivalents) to a side file before the rebuild, and reimport after. That converts "recompute 18k embeddings" into "copy a few tens of MB", and it is the same mechanism a chunked table-by-table migration would need anyway.

---

## How we know it worked

Baseline first, on the affected vault, before any phase lands:

- `getStatistics().dbSizeBytes` (`SQLiteMaintenanceService.ts:123-142`), recorded once.
- Count of `Failed to embed`, `Failed to save to blob store` and `Auto-save failed` lines across one full index run, from `obsidian-cli dev:console`. These are `console.error` calls and do not reach `dev:errors`, as `SQLitePersistenceService.ts:70-74` documents from a live check.
- Whether the run ever reaches phase `complete`.
- Peak renderer memory, sampled. Use Obsidian's developer tools Memory panel with allocation sampling during one full index, or take heap snapshots at fixed note counts. Do not infer peak from the absence of an error.

Then, per phase:

**After Phase 0:** nothing user-visible. The perf test prints a peak-bytes number for one save and for an overlapping pair. That number is the contract.

**After Phase 1:** `Auto-save failed` lines should stop appearing interleaved with queue-path failures, because there is no longer a second concurrent export. The perf test's overlapping-pair peak should fall to the single-save peak. Failures do not disappear: a single 150 MB allocation can still fail once the heap is fragmented.

**After Phase 2:** the count of save attempts per full index falls by one to two orders of magnitude, and with it the count of failures. The run reaches phase `complete` even when some saves failed. Any failure that does occur says `Failed to save cache` and names a byte count, not `Failed to embed <path>`. A deliberately induced save failure (fill the disk on mobile, or stub the blob store on desktop) must leave the conversation resume checkpoint intact, verifiable by restarting and watching the backfill resume rather than restart at zero.

**After Phase 5, whichever option:** the perf harness's per-save peak drops from roughly 3x database size to either one page (Option C) or roughly 1x plus one chunk (Option D). The user-facing check is a full index on a 150 MB cache that completes with zero allocation failures and a flat rather than sawtooth renderer memory profile. For Option C specifically, the additional check is that the cache survives an Obsidian restart and that "Nexus: Rebuild cache" still produces a working empty database, since the removal step changes.

The in-app loop in `.skills/nexus-testing/protocols/live-loop.md` is the proof surface for all of this. A green Jest run proves the coordination logic agrees with the fakes and says nothing about allocator behaviour.

---

## Out of scope, and one recommendation about it

**Why the cache is 150 MB in the first place.** Being investigated separately. This plan does not shrink it. Two things it should carry over:

1. Start at `notes` and `note_properties`, not at `messages`. §6c has the evidence: the FTS5 tables are external-content and do not duplicate text, while the notes index tables are persisted (`schema.ts:518-549`, `SchemaMigrator.ts:482-514`), per-note, and hold three JSON columns plus an EAV row per frontmatter key with three indexes. `docs/plans/notes-query-index-plan.md` §4 estimates 2.5 to 3.5 KB per note all-in, which is roughly 150 MB at 50k notes, and that plan's own decision 4 explicitly chose not to persist them **for this exact reason** before the decision was reversed by migration v14.
2. The Phase 0 measurement hook exists to feed this. Keep it.

**If the database can be shrunk substantially, the urgency of Level 2 drops and Option E becomes the cheap answer.** A 40 MB cache with Phase 1 and Phase 2 in place may simply stop failing, at which point Option C's Worker bridge and Option D's chunked format are both solutions to a problem that no longer exists. That is why Phase 3 is a spike and not an implementation, and why Option E is in the option list rather than an appendix.

**Also out of scope:** any change to the JSONL event store, the event schema, the appliers, or the desktop-versus-mobile backend split from `docs/architecture/cloud-sync-cache-backend.md`.

---

## Non-goals

- No change to `IStorageBackend`, `IStorageAdapter` or the `CacheBlobStore` interface in Phases 0 through 2.
- No change to the mobile cache backend in any phase. Mobile stays on `vault.adapter`.
- No new npm dependency. Any Worker or VFS work uses what `@dao-xyz/sqlite3-vec` already bundles, and must pass `node scripts/check-mobile-imports.mjs .`.
- No catching of `RangeError` at a call site to make a log line go away.

---

## Effort and risk summary

| Phase | Effort | Risk | Ships behaviour change |
|---|---|---|---|
| 0: characterization tests plus size measurement | 1 to 1.5 days | None (tests plus one read-only statistic) | No |
| 1: save lock plus generation counter | 0.5 day | Low | Yes, strictly safer |
| 2: cadence plus honest failures plus checkpoint fix | 0.5 to 1 day | Low to medium | Yes |
| 3: Level 2 spike | 1 to 2 days, timeboxed | None (no code ships) | No |
| 4: storage skill failure mode | 1 hour | None | No |
| 5: chosen Level 2 option | 3 days (D) to 2 weeks (C) | Medium (D) to high (C) | Yes |

## Open questions a human has to decide

1. **Is `opfs-sahpool` usable from the Obsidian desktop main thread in this bundled build?** Phase 3 answers it empirically. Everything about Level 2's cost hinges on it, and the prior rejection at `docs/architecture/cloud-sync-cache-backend.md:140-149` was decided on throughput, before this failure existed.
2. **If a Worker is required, is a permanently asynchronous `SchemaMigrator` acceptable?** Sixteen shipped migration versions with synchronous `migrationFn` signatures (`SchemaMigrator.ts:229, 377, 582`) would have to change. That is a bigger blast radius than the save path itself.
3. **Does Option E (unpersisting the notes index) break any query?** Needs a join audit before it can be costed.
4. **Should a Level 2 migration ever fall back to a rebuild?** It is correct and loses no user data, and it costs a full re-embed of the vault in API calls. That is a product decision, not an engineering one.
