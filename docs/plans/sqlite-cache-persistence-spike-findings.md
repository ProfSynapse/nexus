# SQLite Cache Persistence: Phase 3 Spike Findings (Amendment)

**Status:** Spike complete. No production code ships from this document.
**Date:** 2026-09-18
**Amends:** `docs/plans/sqlite-cache-persistence-plan.md`, specifically "### Phase 3: The
Level 2 spike", "### 7. What we do not know yet" and "Open questions a human has to decide".
**Verdict:** **Option D**, in its strong form (`sqlite3_serialize` with
`SQLITE_SERIALIZE_NOCOPY` plus a chunked write). Option C is dead on desktop without a
Worker bridge, and the Worker bridge is not worth its price.

---

## The one-line answer

`installOpfsSAHPoolVfs()` **rejects** on the Obsidian desktop renderer main thread with
`Error: Missing required OPFS APIs.`, because
`FileSystemFileHandle.prototype.createSyncAccessHandle` is `undefined` on the main
thread. It **resolves in 55 ms inside a dedicated Worker** in the same renderer, and
`vec0` and FTS5 both work correctly on that VFS across a close and reopen.

---

## How this was measured

Everything below was executed in a real Obsidian renderer, not inferred from source.

| Item | Value |
|---|---|
| Obsidian | 1.13.7, AppImage, extracted, headless under `xvfb-run` |
| Electron / Chromium | Electron 43.3.0, Chrome 150.0.7871.212 |
| Renderer origin | `app://obsidian.md`, `isSecureContext: true`, `crossOriginIsolated: false` |
| Platform | Linux x86_64 container (see "Fidelity limits" below) |
| SQLite | 3.51.0, `sourceId 2025-06-19 12:35:30 0d6084a3...`, from `@dao-xyz/sqlite3-vec@0.0.19` |
| Protocol | `.skills/nexus-testing/protocols/headless-obsidian.md`, followed as written except where noted |

Two harnesses were used, and the difference matters when reading a result:

1. **A minimal test plugin** (`sqlite-spike`), bundled by esbuild with the same
   `@dao-xyz/sqlite3-vec/wasm` alias the real build uses (`esbuild.config.mjs:84-87`),
   loading the same `sqlite3.wasm` through `vault.adapter.readBinary` and calling the
   module factory with the same `instantiateWasm` shape as
   `SQLiteWasmBridge.initializeModule` (`src/database/storage/SQLiteWasmBridge.ts:59-76`).
   Used for the bulk of the measurement, because it isolates the sqlite3 module from
   everything else Nexus does at load.
2. **The real Nexus plugin**, built from this worktree with the console suppression at
   `src/database/storage/SQLiteCacheManager.ts:272-276` removed, installed into the test
   vault and loaded. Used to confirm items 1 and 2 against the plugin's own module
   instance rather than a harness one.

The suppression removal and the `node_modules` symlink were both reverted; this document
is the only change left in the worktree.

---

## 1. What the suppressed line actually says

`SQLiteCacheManager.ts:273` suppresses `/OPFS sqlite3_vfs/`. **Measured.** With the
suppression removed, the bundled glue emits **exactly one** line at module init, as a
`console.warn`, on every start:

```
Ignoring inability to install OPFS sqlite3_vfs: The OPFS sqlite3_vfs cannot run in the main thread because it requires Atomics.wait().
```

Two details worth recording:

- It arrives as **two arguments**, not one. The first is
  `"Ignoring inability to install OPFS sqlite3_vfs:"` and the second is the Error. The
  suppression at `SQLiteCacheManager.ts:278` and `:284` only stringifies `args[0]`, so
  even an unsuppressed build that logged `args[0]` alone would print the label without
  the reason. The full text above was captured by joining all arguments.
- Total init output is one line. Nothing else is hidden. `/Heap resize call/` fires
  later, during data growth, not at init: those lines look like
  `Heap resize call from 150536192 to 180682752 took 0.5 msecs. Success: true` and were
  observed repeatedly while building a 152 MB test database.

**This line is about the plain `opfs` VFS, not `opfs-sahpool`.** The two are different
implementations in the same file. `sqlite3.mjs:18940-18949` documents the plain VFS as
Worker-only and requiring `SharedArrayBuffer` plus COOP/COEP; `sqlite3.mjs:19126`
constructs `new Worker(...)` for `sqlite3-opfs-async-proxy.js`. The sahpool installer at
`sqlite3.mjs:22010` is a separate function and is never attempted at init, so its absence
was never reported. Reading this line earlier would have answered half the question and
misled on the other half.

---

## 2. What the module actually exposes at runtime

**Measured**, against the live Nexus plugin's own module instance (reached at
`nexus…sqliteCache.sqlite3`, i.e. the private field set at `SQLiteCacheManager.ts:292`),
with the spike harness unloaded so nothing else could be found by mistake.

`Object.keys(sqlite3)`:

```
WasmAllocError, SQLite3Error, capi, wasm, config, version, client,
scriptInfo, oo1, initWorker1API, vfs, vtab, installOpfsSAHPoolVfs
```

`Object.keys(sqlite3.capi)` has **649** entries. Reachability of the four things the plan
asked about:

| Symbol | Reachable? | Value / type |
|---|---|---|
| `sqlite3.installOpfsSAHPoolVfs` | **yes** | `function` |
| `sqlite3.oo1.OpfsSAHPoolDb` | **no** | `oo1` is exactly `{ DB, Stmt, JsStorageDb }` |
| `sqlite3.capi.sqlite3_serialize` | **yes** | `function` |
| `sqlite3.capi.SQLITE_SERIALIZE_NOCOPY` | **yes** | `1` |
| `sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE` | yes | `1` |
| `sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE` | yes | `2` |
| `sqlite3.capi.SQLITE_DESERIALIZE_READONLY` | yes | `4` |

Three corrections to assumptions carried into this spike:

- **`OpfsSAHPoolDb` is not on `oo1`.** It is a property of the `poolUtil` object that
  `installOpfsSAHPoolVfs()` resolves with (`sqlite3.mjs:22077-22083`). Any code looking
  for `sqlite3.oo1.OpfsSAHPoolDb` will always find `undefined`, install or no install.
- **`SQLITE_SERIALIZE_NOCOPY` is genuinely reachable**, despite not appearing as a string
  anywhere in `sqlite3.mjs`. Grepping the glue is the wrong test: none of the
  `SQLITE_DESERIALIZE_*` constants the shipping code already uses appear there either.
  The constants live in an enum blob inside `sqlite3.wasm` (confirmed with `strings`) and
  are attached to `capi` at init. **Inferred from the grep, then measured at runtime.**
- The declared TypeScript surface at `SQLiteWasmBridge.ts:22-42` understates the module
  by 649 `capi` entries to 5. That was a documentation gap, not a capability gap. Nothing
  new has to be bundled to do Option D.

---

## 3. The decisive test: sahpool on the main thread

**Measured. It rejects.**

```
result:        REJECTED
errorName:     Error
errorMessage:  Missing required OPFS APIs.
stack:         Error: Missing required OPFS APIs.
                   at sqlite3.installOpfsSAHPoolVfs (sqlite3.mjs:22045)
installMs:     0
```

The rejection is synchronous, from the guard at `sqlite3.mjs:22037-22048`, before any
async work. That guard requires all of `globalThis.FileSystemHandle`,
`FileSystemDirectoryHandle`, `FileSystemFileHandle`,
`FileSystemFileHandle.prototype.createSyncAccessHandle` and
`navigator.storage.getDirectory`. **`apiVersionCheck` (`sqlite3.mjs:21745`) never runs**,
so the async-`close()` question it exists to answer is moot on the main thread.

The cause was isolated by replicating the check step by step:

| Step | Main thread | Dedicated Worker |
|---|---|---|
| `navigator.storage.getDirectory()` | ok, `FileSystemDirectoryHandle` | ok |
| `dh.getFileHandle(name, {create:true})` | ok | ok |
| `fh.createSyncAccessHandle()` | **`TypeError: fh.createSyncAccessHandle is not a function`** | ok |
| `FileSystemFileHandle.prototype.createSyncAccessHandle` | **`undefined`** | `function` |
| `FileSystemFileHandle.prototype.createWritable` | `function` | (not tested) |
| `Atomics.wait` | `function` | `function` |
| `SharedArrayBuffer` | `function` | `function` |
| `crossOriginIsolated` | `false` | `false` |
| SAH open / write / `getSize()` / `close()` round trip | n/a | **ok**, `close()` synchronous |

So the cause is **neither** the Electron origin **nor** the storage partition. OPFS itself
is present and writable on the main thread; `createWritable` works there. What is missing
is `createSyncAccessHandle`, which is `[Exposed=DedicatedWorker]` by specification. The
storage partition is fine: the very same OPFS directory served a full SAH write-read-close
cycle from a Worker in the same renderer.

### The architecture doc is right, and should not be corrected

`docs/architecture/cloud-sync-cache-backend.md:140-149` rejected OPFS on the grounds that
it "requires a dedicated Web Worker for `createSyncAccessHandle`". The hypothesis going
into this spike was that this had conflated the plain `opfs` VFS (which spawns a Worker)
with `opfs-sahpool` (which does not). **That hypothesis is refuted.** The doc's sentence
is literally accurate and for the right reason: the Worker is required not because sahpool
spawns one, but because the SAH API is only exposed in one. The two VFSes are indeed
different, and the reasons they need a Worker are different, but the conclusion for
sahpool is the same. Leave `:140-149` as written.

The doc's *rationale* is still incomplete in the way §7 of the plan says: it weighed
throughput, not peak allocation. That criticism stands. The factual claim does not need
correcting.

---

## 4. vec0 and FTS5 under the sahpool VFS

**Measured, in a dedicated Worker**, because that is the only place the VFS can be
installed. This is the evidence the plan said had to be demonstrated rather than argued.
It is reported here even though the recommendation is not Option C, because it removes an
unknown: if the Worker bridge is ever built for another reason, the storage layer is not
the thing that will block it.

```
moduleInit:               ok 3.51.0
installOpfsSAHPoolVfs:    function
installMs:                55
vfsName:                  spike-pool
poolUtil.OpfsSAHPoolDb:   function
vec0 CREATE VIRTUAL TABLE:  ok   (vec0(embedding float[4]))
fts5 CREATE VIRTUAL TABLE:  ok   (external content, content='docs',
                                  content_rowid='id', tokenize='porter unicode61')
inserts:                    ok
KNN round 1:  [[2, 0.27386126], [3, 0.27386132], [4, 0.82158387]]
FTS5 MATCH 'quick' round 1: [[1, "alpha note"]]
close:                      ok
reopen same file on VFS:    ok
KNN round 2:  [[2, 0.27386126], [3, 0.27386132], [4, 0.82158387]]   (identical)
FTS5 MATCH 'lorem' round 2: [[2, "beta note"]]
PRAGMA page_size:           8192
PRAGMA journal_mode:        delete
```

The schema shapes match `src/database/schema/schema.ts:192-248` (external-content FTS5)
and the vec0 pattern at `:302-390`. Both virtual tables survive a close and reopen against
the same OPFS file with byte-identical KNN distances. **The VFS is below the pager and the
virtual tables are above it, as the plan predicted, and that now has a measurement behind
it rather than an argument.**

One incidental finding for whoever builds a Worker later: loading the glue inside a
blob-URL Worker in Obsidian aborts with
`Aborted(Assertion failed: node environment detected but not enabled at build time. Add node to -sENVIRONMENT to enable.)`,
because Electron leaves `process` visible to the Worker and Emscripten's environment
detection latches onto it. Shadowing `process`, `require`, `module` and `exports` at the
top of the Worker script fixes it. That is a real, non-obvious cost line for Option C.

---

## 5. Option D, measured

All numbers below are from the Obsidian renderer, `performance.memory.usedJSHeapSize`
sampled around each step, with a settle delay before each measurement. Absolute peaks are
approximate because Chrome's heap accounting lags GC; the **ratios and the maximum single
contiguous request are the load-bearing numbers**, and those are exact.

### 5a. The plan's first caveat is confirmed exactly

On a fresh `:memory:` database, the path taken by `SQLiteWasmBridge.createMemoryDatabase`
(`:78-80`) via `SQLitePersistenceService.createFreshDatabase` (`:137-141`):

```
sqlite3_serialize(db, "main", pSize, SQLITE_SERIALIZE_NOCOPY)
  -> ptr  = 0
  -> size = 69509120   (the size IS written, the pointer is NULL)
```

**NOCOPY returns NULL on a database that is not in serialized mode.** The first save after
a fresh install or a "Rebuild cache" must therefore use the copy path. Note the useful
detail that the size out-parameter is still populated, so the NULL is cheap to detect and
branch on without a second call.

After `sqlite3_deserialize` with `FREEONCLOSE | RESIZEABLE`
(`SQLiteWasmBridge.ts:82-95`), the same call returns a valid pointer:

```
ptr                   = 73053400
size                  = 69509120  (66.3 MB)
ms                    = 0
view.buffer === wasm.heap8u().buffer : true
first 15 bytes        : "SQLite format 3"
jsHeapDelta           = 0.0 MB
wasmHeapDelta         = 0.0 MB
```

### 5b. Single-save cost, 66 MB database

| Path | Wall clock | JS heap delta | WASM heap delta |
|---|---|---|---|
| `sqlite3_js_db_export` (current, `SQLiteWasmBridge.ts:102-104`) | 81 ms | **+66.3 MB** | **+66.3 MB** |
| `sqlite3_serialize` flags=0 (the copy the above wraps) | 16 ms | 0 MB | 0 MB (heap already grown) |
| `sqlite3_serialize` + `NOCOPY` | **0 ms** | **0 MB** | **0 MB** |

The current export costs **two** full-size allocations, not one: `sqlite3_serialize`
allocates a copy inside the WASM heap, and `sqlite3_js_db_export` then copies that into a
JS `ArrayBuffer`. Add the resident database and the blob store's own clone and the plan's
"roughly three times the database size" is confirmed, with the correction that the third
copy is inside the WASM heap rather than only in the backend. Whether the WASM-heap copy
shows as growth depends on how much slack the heap already has: at 152 MB it showed as
`+0 MB` because the heap had already grown to 310 MB while the data was being built, and
that heap **never shrinks** (measured `residentWasmHeapMB: 310.6` for a 152 MB database).

### 5c. End to end through the real desktop backend (IndexedDB put)

`IndexedDBCacheBlobStore.ts:62-76` is a `put`. Alternating three rounds each, to rule out
an ordering artifact, on a 56.1 MB database:

| Path | serialize | `put()` call | tx commit | total | JS heap delta |
|---|---|---|---|---|---|
| current: export then `put(ArrayBuffer)` | 43-58 ms | 81-84 ms | 13-21 ms | **137-157 ms** | **+56.1 MB** |
| Option D: NOCOPY view then `put(Uint8Array)` | **0 ms** | 294-333 ms | 31-34 ms | **327-367 ms** | **0 MB** |

Handing IndexedDB a single view over WASM memory allocates **nothing** on the JS heap but
costs about 2.2x wall clock, because Chrome's structured clone takes a slow path out of
WASM memory. Round-tripped bytes were verified identical to the copy path (header
`SQLite format 3`, sampled comparison across the whole blob).

That trade is not obviously good on its own. Chunking removes the need to make it.

### 5d. The three-way comparison, and the recommended shape

Peak sampled inside the loop, 56.1 MB database, 4 MB chunks:

| Path | Peak JS heap | **Max single contiguous alloc** | Time |
|---|---|---|---|
| A: current (`sqlite3_js_db_export` + one `put`) | 56.1 MB | **56.1 MB** | 161 ms |
| B: NOCOPY + 4 MB chunks, **one** transaction | 56.1 MB | **4 MB** | 166 ms |
| C: NOCOPY + 4 MB chunks, **one transaction per chunk** | **8 MB** | **4 MB** | 154 ms |

And at the size that motivated the plan, 152.4 MB:

| Path | Peak JS heap | **Max single contiguous alloc** | Time |
|---|---|---|---|
| current | 152.4 MB | **152.4 MB** | 378 ms |
| NOCOPY + 4 MB chunks, tx per chunk (39 chunks) | ~60 MB | **4 MB** | 397 ms |

Three things to read carefully here:

- **The contiguous requirement falls from 152.4 MB to 4 MB, a factor of 38.** This is the
  number that matters. The reported failure is `RangeError: Array buffer allocation
  failed`, which is the allocator refusing **one contiguous request**. A fragmented heap
  that cannot find 152 MB will still find 4 MB many times over. This change makes the
  reported failure structurally very unlikely rather than merely less frequent.
- **Peak total bytes falls much less, and the ~60 MB figure is GC lag, not a requirement.**
  With 39 slices being cloned and released faster than the collector runs, the heap
  high-water mark drifts up. It is not a 60 MB contiguous demand. Do not quote this number
  as the design target; quote the 4 MB.
- **Wall clock is unchanged.** 397 ms versus 378 ms at 152 MB. Chunking cancels out the
  2.2x penalty that a single whole-blob view incurred in 5c. Option D therefore costs
  nothing in time, which is the opposite of what the throughput-based rejection in the
  architecture doc would have predicted.

### 5e. Caveats, including one the plan did not have

1. **Fresh `:memory:` databases are not in serialized mode.** Confirmed in 5a. Branch on
   `ptr === 0` and fall back to the copy path. Affects the first save after a fresh
   install and after every "Rebuild cache".
2. **A view over WASM memory detaches when the heap resizes.** Confirmed: after forcing a
   resize with a 64 MB `wasm.alloc`, the previously valid view reported
   `byteLength === 0`. But the plan's framing is slightly too strict, and the precise rule
   is worth having. **Measured:** the view did **not** detach across an idle `await` of
   50 ms, and did **not** detach across a small `INSERT` that did not grow the heap. It
   detaches when, and only when, the WASM heap grows. An `await` is dangerous because a
   heap growth can happen during it, not because awaiting detaches anything.
3. **New: the NOCOPY pointer moves when the database grows.** Not in the plan and more
   dangerous than caveat 2, because it is silent. Measured: `ptr` went from `676904` to
   `58144672` after inserting 16 MB of rows into a `RESIZEABLE` deserialized database.
   With `SQLITE_DESERIALIZE_RESIZEABLE` SQLite reallocates the serialized image, so a
   cached pointer becomes a pointer to freed or foreign memory, not a detached view that
   throws. Re-call `sqlite3_serialize` immediately before each use, and never cache the
   pointer across a write. The chunked loop in 5d does exactly this, re-serializing on
   every iteration, which is also what makes it safe across the per-chunk `await`.
4. **Per-chunk transactions are not atomic across the whole blob.** A crash between chunk
   7 and chunk 8 leaves a torn cache in IndexedDB. This needs a generation marker or a
   manifest record written last, plus a read path that rejects an incomplete generation
   and falls back to the previous one or to a rebuild. This is the real cost of Option D
   and it is a correctness cost, not a performance one. The existing verification seam in
   `CacheBackendMigration.verifyIdb` (`:242-261`) compares a single size and will need to
   understand the chunked shape.

---

## 6. Mobile

Not spiked, per §8 of the plan. Mobile stays on `vault.adapter`. Nothing measured here
changes that, and Option D is platform-symmetric: the NOCOPY serialize and the chunked
write both apply to `VaultAdapterCacheBlobStore` as readily as to the IndexedDB one, which
is the property Option C does not have.

---

## Recommendation

**Option D.** Specifically:

1. `sqlite3_serialize` with `SQLITE_SERIALIZE_NOCOPY`, with a `ptr === 0` fallback to the
   existing `sqlite3_js_db_export` path for not-yet-serialized databases, and with the
   pointer re-taken immediately before every use.
2. A chunked blob format, roughly 4 MB per record, one transaction per chunk, with a
   generation marker so a torn write is detectable and recoverable.

Both halves are needed. NOCOPY alone removes the JS-heap copy but leaves a single 152 MB
structured clone and costs 2.2x wall clock. Chunking alone removes the contiguous
requirement but leaves the copy. Together they remove the contiguous 152 MB request, cost
nothing in time, and work identically on both platforms.

**Against Option C.** It requires a Worker, and that is now measured rather than asserted.
The bill is: every `SQLiteCacheManager` call crosses a message boundary; the synchronous
`DatabaseAdapter` that `SchemaMigrator` consumes (`SQLiteCacheManager.ts:78-92`) and the
synchronous `migrationFn: (db: MigratableDatabase) => void` signature at
`SchemaMigrator.ts:229, 377, 582` have to become async across 16 shipped schema versions;
the Emscripten node-environment abort in 4 needs a shim; and a blob-URL Worker is adjacent
to what `esbuild.config.mjs:88-91` warns the plugin-store scanner objects to. All of that
buys, on top of Option D, the removal of a 4 MB allocation and the 30 s autosave concept
on desktop only. That is the plan's "2 weeks, high risk" estimate meeting a 3 day,
medium-risk alternative that solves the actual reported failure. **Do not build the Worker
bridge for storage reasons.** If it is ever built for another reason, §4 above shows the
storage layer will not be what blocks it.

**Against Option E, for now.** Nothing in this spike measured table sizes, so §6c of the
plan is still unresolved and Option E is still uncosted. It remains worth doing on its own
merits, and the Phase 0 size measurement should still land. But it is a size reduction,
not a structural fix: a 40 MB cache saved through the current path still asks the
allocator for one contiguous 40 MB block, and on a fragmented heap after hours of indexing
that can still fail. Option D makes the request 4 MB regardless of how large the database
is. **Option E is complementary and lower priority, not an alternative.**

Phases 0, 1 and 2 are unaffected by this spike and should proceed as written. Option D
does not remove the need for Option B's cadence work: it makes each save survivable, not
free, and 378 ms of wall clock every ten notes is still worth not spending.

---

## Fidelity limits, stated plainly

- **This is Linux under Xvfb, not macOS or Windows.** `createSyncAccessHandle` being
  `[Exposed=DedicatedWorker]` is a Chromium-wide specification behaviour and is not
  expected to vary by host OS, but that is **inferred**, not measured. If anyone wants to
  overturn the recommendation on the strength of a different platform, the single check to
  run is `typeof FileSystemFileHandle.prototype.createSyncAccessHandle` in the Obsidian
  developer console on that platform.
- **The databases were synthetic**, built from BLOB rows plus vec0 and FTS5 tables, not a
  real 152 MB Nexus cache with its real table mix. Page counts and byte sizes are real;
  the distribution across tables is not, and no conclusion here depends on it.
- **The allocation failure itself was not reproduced.** The container heap never
  fragmented enough to refuse a 152 MB request. The argument that a 4 MB request survives
  where a 152 MB request fails is the standard fragmentation argument and is **inferred**
  from the measured drop in contiguous size, not demonstrated by inducing a `RangeError`.
- **`performance.memory` is coarse and GC-lagged.** Ratios and the contiguous-allocation
  figures are trustworthy; absolute peak numbers are indicative.
- Assumed, not checked: that `@dao-xyz/sqlite3-vec` will keep shipping this SQLite build
  and these constants across future minor bumps.

---

## Correction to `.skills/nexus-testing/protocols/headless-obsidian.md`

The protocol worked essentially as written against Obsidian 1.13.7 on 2026-09-18.
`xvfb-run` was already on PATH, `obsidian.md` is still 403 through the egress proxy and
`github.com` is still reachable, the latest desktop release is still 1.13.7, the full GPU
flag set in step 4 was still required, and `"cli": true` written while Obsidian was not
running still took effect. The `~/.config/obsidian` path is `/root/.config/obsidian` when
running as root, as the protocol implies.

One gap worth adding to `refinement-log.md`, found the hard way:

> **Step 5 only works if the plugin folder exists before Obsidian launches.** Obsidian
> reads `.obsidian/plugins/` once at vault load. A plugin copied in while it is already
> running is invisible: `app.plugins.manifests` does not contain it, and
> `app.plugins.enablePlugin('<id>')` resolves without doing anything and without an error,
> which looks exactly like the plugin failing to load. Call
> `await app.plugins.loadManifests()` first, then
> `await app.plugins.enablePluginAndSave('<id>')`. `dev:errors` stays empty throughout, so
> it gives no hint.

A second, smaller note: when probing plugin internals with `eval`, a harness plugin that
parks itself on `window` will be found by any object walk that goes through
`plugin.app.workspace…` or `…secretStore.host.plugins`, and will be mistaken for the
plugin under test. Unload the harness before walking, or exclude `app` and `win` from the
traversal. Both mistakes were made and caught here.

---

## Reproduction

The spike harness is not committed. It was: a minimal Obsidian plugin exposing
`initModule()` over the same `@dao-xyz/sqlite3-vec/wasm` alias, driven by
`obsidian-cli eval` with each experiment read from a file in the vault so the payloads did
not have to fit in argv. Every number above came from one of eleven such experiment files.
Rebuilding it is about thirty minutes from the protocol above; the load-bearing single
check is three lines in the developer console:

```js
typeof FileSystemFileHandle.prototype.createSyncAccessHandle   // "undefined" on main thread
sqlite3.capi.SQLITE_SERIALIZE_NOCOPY                           // 1
sqlite3.capi.sqlite3_serialize(db, "main", pSize, 1)           // 0 if not serialized, else a pointer
```
