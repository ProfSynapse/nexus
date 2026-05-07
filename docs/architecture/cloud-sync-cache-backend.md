# ARCHITECTURE: Cloud-sync-immune cache.db backend

> **Mission**: Replace the `vault.adapter.writeBinary`-backed cache.db persistence path with
> a cloud-sync-immune backend (IndexedDB on desktop, file-on-disk on mobile). This document
> is the build-spec for CODE phase. It resolves all 9 open questions from PREPARE §7,
> specifies the `CacheBlobStore` interface + two implementations, the migration state
> machine, the conflict-copy janitor, the `SQLitePersistenceService` wiring point, the
> "Rebuild Cache" command UX, and the test scope.
>
> **Branch**: `feat/cloud-sync-cache-backend`
> **Worktree**: `.worktrees/feat-cloud-sync-cache-backend`
> **Upstream PREPARE**: `docs/preparation/cloud-sync-cache-backend.md`
> **Trigger incident**: Synaptic Labs vault on Google Drive Shared Drive — 162 MB cache.db
> in `~/Library/CloudStorage/GoogleDrive-*/.../.obsidian/plugins/<id>/data/cache.db`
> conflict-copying mid-write, causing `HybridStorageAdapter.waitForQueryReady` to time out
> at 60s.
> **Ancestry**: surgical, conditional version of Phase 2 deferred from v5.8.10 / PR #199.

---

## 0. Executive summary

The fix is a **single-seam abstraction** at the cache.db persistence boundary
(`SQLitePersistenceService`, 3 methods, 1 class, 3 call sites). Behind that interface
the desktop backend becomes IndexedDB; the mobile backend remains the existing
`vault.adapter`-backed file. SQLite itself does not change (in-memory + serialize/deserialize
at `SQLiteWasmBridge.ts:78-103`).

The decision log below resolves all 9 open questions. Notably:

- **O1+O9 collapse to "always-on IDB on desktop"** (per team-lead Q2 resolution). No
  detection heuristic ships. No user toggle. The desktop path is structurally
  cloud-sync-immune because IDB lives in the Electron renderer's storage area, not
  in any vault folder a third-party sync client follows.
- **O3 keeps mobile on `vault.adapter`** (iOS WKWebView IDB durability is too weak for a
  150+ MB blob).
- **O7 migration is foreground-blocking with a Notice** (per team-lead Q1 resolution
  adopting architect pushback over the original async-deferred-swap prior). 2-7 s fits
  inside the 60 s `waitForQueryReady` budget; eliminating the dual-backend coexistence
  window is worth more than the 2-7 s of polite background work.

The shape of the deliverable is small:

- One new interface (`CacheBlobStore`).
- Two implementations (`VaultAdapterCacheBlobStore`, `IndexedDBCacheBlobStore`).
- One factory (platform-conditional selection).
- One state-machine (linear, 5 states, no branching after success).
- One conflict-copy janitor (literal-pattern, runs once during migration).
- One command-palette command (`Nexus: Rebuild Cache`).
- Three method-signature changes inside `SQLitePersistenceService` (interface-driven,
  not adapter-driven).

---

## 1. Decision log — all 9 open questions resolved

### O1 — Architecturally enforce local-only? **YES, via interface.**

- **Decision**: The new `CacheBlobStore` interface is the structural enforcement.
  `IndexedDBCacheBlobStore` literally cannot place bytes in a vault-relative path.
  `VaultAdapterCacheBlobStore` (mobile-only) writes to `.obsidian/plugins/<id>/data/`,
  which Obsidian Sync DOES include — but mobile users are not the failure population
  (Obsidian mobile doesn't run third-party cloud-sync clients in the app sandbox).
- **Rationale**: PREPARE §1.5 surfaced that "local-only cache.db" was documented in plans
  + DESIGN.md but not architecturally enforced. The new interface makes the property
  structural, not aspirational.
- **Coupled with O9**: see below.

### O9 — Cloud-sync detection strategy? **NONE. Always-on IDB on desktop.**

- **Decision**: No path-heuristic detector. No user toggle. Desktop backend is IDB
  unconditionally. Detection-strategy options (a)-(d) from PREPARE §5.4 are all dropped.
- **Rationale (per team-lead Q2 resolution)**: §1.5 finding is dispositive — once the
  on-disk cache.db lives anywhere a third-party sync client touches, the property is
  lost. "Architecturally enforced local-only" means the path no longer matters; IDB is
  structurally local-only on desktop. Eliminates regex maintenance, Linux unreliability,
  and false-negative incident reproduction.
- **The asymmetric-cost framing dissolves**: 95 % of users pay a one-time 2-7 s migration
  on first launch after upgrade (foreground Notice). That is not a recurring cost.
- **What still ships**: the conflict-copy janitor (O8) — runs once during migration to
  clean up legacy artifacts on the path being abandoned.

### O3 — Mobile: IDB-with-eviction or keep `vault.adapter`? **Keep `vault.adapter` on mobile.**

- **Decision**: Mobile uses `VaultAdapterCacheBlobStore`. Selection is via
  `Platform.isDesktop` (the `isDesktop()` helper at `src/utils/platform.ts:34-37`).
- **Rationale**: PREPARE §2.3 — iOS WKWebView IDB is not 100 % durable;
  `navigator.storage.persist()` not honored uniformly on iOS; eviction-under-pressure
  is real for a 150+ MB blob. Mobile doesn't suffer the third-party cloud-sync-conflict
  problem (no GDrive client in the iOS app sandbox). Keeping mobile on the existing
  backend is the lowest-risk choice.

### O7 — First-launch migration UX? **Foreground-blocking with Notice.**

- **Decision**: Migration runs synchronously inside `SQLiteCacheManager.initialize()`
  before the database is opened against the new backend. An Obsidian `Notice` shows
  "Nexus: Migrating cache to local storage…" while it runs. On completion, a follow-up
  `Notice` "Nexus: Cache migration complete." is shown for 3 s.
- **Rationale (per team-lead Q1 resolution adopting architect pushback)**:
  1. PREPARE §6.1 estimates 2-7 s total foreground time, well within the 60 s
     `waitForQueryReady` budget (`HybridStorageAdapter.ts:778`).
  2. Eliminates the dual-backend coexistence window where legacy file lives in vault
     AND IDB has partial bytes — recovery on partial failure is much simpler with a
     single source of truth at any point in time.
  3. Matches the v5.7.0 plugin-scoped storage migration UX precedent (also foreground-
     blocking; users tolerated 1-3 s for that).
  4. Background-deferred would require either dual-write or a swap protocol; both add
     state-machine complexity for marginal UX gain at a one-time event.
- **Disagreement audit trail (per verbatim-tier-preservation memory norm)**:
  Original team-lead prior was async-background-with-deferred-swap. Architect surfaced
  the dual-backend-window concern in teachback Q1. Team-lead adopted the override.
  Documented here so future readers can audit the decision rationale.

### O2 — Content-hash-gated autosave? **NO, defer.**

- **Decision**: Keep current dirty-flag autosave (`hasUnsavedData` boolean,
  `SQLiteCacheManager.ts:97, 290-296`). Do NOT add content-hash gating in this PR.
- **Rationale**: With IDB on desktop, an autosave costs ~1.4 s of structured-clone +
  IDB write at 162 MB (PREPARE §2.2). Auto-save fires every 30 s only when `hasUnsavedData`
  is true. The existing dirty-flag already prevents idle writes. Hash-gating adds
  hash-of-162MB-bytes computation per autosave, which is itself non-trivial. If
  autosave latency becomes a felt UI problem in CODE-phase smoke testing, revisit as
  follow-up; do not preempt.
- **Open for CODE/TEST**: validate the 1.4 s figure with one real-vault smoke run
  before shipping. If actual is >3 s on warm SSD with 162 MB, file follow-up issue.

### O4 — Ship "Rebuild Cache" command palette entry? **YES.**

- **Decision**: Ship `Nexus: Rebuild Cache` command. Clears the IDB store, then
  immediately calls the standard SQLite-from-JSONL rebuild path
  (`SyncCoordinator.rebuildAll()` semantics — verify exact name in CODE phase against
  current `SyncCoordinator` API). Confirmation modal before destructive action.
- **Rationale**: PREPARE §6.3 — file-system "delete cache.db" is no longer the
  user-supportable recovery once IDB is the desktop backend. DevTools is not user-
  reachable for non-technical users. A command-palette command is the only viable
  recovery surface. JSONL-rebuild now covers task tables (per CLAUDE.md note about
  task-board-sync work) so this is safe.
- **UX flow**: see §8 below.

### O5 — OPFS instead of IDB? **NO. IDB.**

- **Decision**: IndexedDB. OPFS is rejected for this PR.
- **Rationale**: PREPARE §3 — OPFS is ~10 × faster (90 ms vs 850 ms for 100 MB) but
  requires a dedicated Web Worker for `createSyncAccessHandle`. At a 30 s autosave
  cadence the perf delta is invisible; the Worker bridge surface (message passing,
  lifecycle, structured-clone-through-Worker) is real architectural complexity for
  zero felt UX gain. If a future case for moving SQLite execution itself into a
  Worker (sqlite-wasm-in-worker) lands, OPFS becomes an upgrade path; the
  `CacheBlobStore` interface is shaped to permit a third implementation without
  re-touching call sites.

### O6 — Linux unreliability handling? **N/A (collapsed by O9).**

- **Decision**: Moot. Always-on-desktop means no Linux-specific detection logic.
- **Rationale**: O9 collapse eliminates the entire detection module; Linux
  rclone/google-drive-ocamlfuse/Insync unreliability no longer matters because we
  do not attempt to detect.

### O8 — Conflict-copy janitor: conservative or pattern-match? **PATTERN-MATCH, scoped, idempotent.**

- **Decision**: Janitor pattern-matches the documented sibling shapes from PREPARE §6.4
  but is **scoped** to siblings of `cache.db` literally and runs **only once** during
  migration. Does NOT run in steady state.
- **Rationale**: PREPARE §6.4 lists 7 conflict-copy patterns observed in the wild.
  Conservative literal-match (only `cache 2.db`) leaves `cache (1).db`, `cache_conf*.db`,
  Dropbox conflicted copies, and rclone-suffixed siblings as debris. Pattern-match in
  the cache.db parent directory only, on filenames matching `^cache\b` with a
  conflict-suffix shape, is safe — no user file would legitimately use a name like
  `cache (1).db` or `cache_conf2.db` in a Nexus plugin data folder.
- **Scope rules**:
  - Scan only `${pluginDataRoot}/`, never recurse.
  - Match only files where basename starts with `cache` and ends with `.db`.
  - Match the documented sibling-shape regex set (see §7 below).
  - On `adapter.remove()` failure (file locked, permission denied), log a warning and
    continue — janitor failure does NOT block migration.

### Resolved-questions summary

| # | Question | Decision |
|---|---|---|
| O1 | Architecturally enforce local-only? | YES, via `CacheBlobStore` interface |
| O2 | Content-hash-gated autosave? | NO — defer; dirty-flag is sufficient |
| O3 | Mobile IDB or `vault.adapter`? | `vault.adapter` (durability concern) |
| O4 | Rebuild Cache command? | YES |
| O5 | OPFS instead of IDB? | NO — IDB |
| O6 | Linux detection? | N/A (collapsed by O9) |
| O7 | Migration UX? | Foreground-blocking with Notice |
| O8 | Janitor scope? | Pattern-match, scoped, one-shot |
| O9 | Cloud-sync detection? | NONE — always-on IDB on desktop |

---

## 2. `CacheBlobStore` interface

### 2.1 Shape

New file: `src/database/storage/CacheBlobStore.ts`.

```ts
/**
 * Persistence backend for the SQLite cache.db serialized blob.
 *
 * Two implementations: VaultAdapterCacheBlobStore (mobile, file-on-disk via
 * vault.adapter) and IndexedDBCacheBlobStore (desktop, sync-immune via IDB).
 * Selected by CacheBlobStoreFactory based on Platform.isDesktop.
 *
 * Error contract: implementations throw on unrecoverable failure (e.g., IDB
 * transaction abort). Callers (SQLitePersistenceService) catch and route to
 * recreateCorruptedDatabase. Implementations MUST distinguish "blob absent"
 * (return null from read) from "blob present but unreadable" (throw).
 */
export interface CacheBlobStore {
  /**
   * Read the persisted SQLite blob. Returns null if the blob is absent
   * (first launch, post-clear, post-migration-from-empty). Throws on
   * unrecoverable backend failure.
   */
  read(): Promise<ArrayBuffer | null>;

  /**
   * Write the SQLite blob, replacing any existing blob atomically (or as
   * close to atomically as the backend permits). Throws on failure.
   * Implementations SHOULD avoid copying the buffer where possible; the
   * caller (SQLitePersistenceService.saveDatabase) hands a freshly-exported
   * buffer that is not retained after the call.
   */
  write(buffer: ArrayBuffer): Promise<void>;

  /**
   * Remove the persisted blob. Idempotent — returns successfully if the
   * blob was already absent. Used by recreateCorruptedDatabase.
   */
  remove(): Promise<void>;

  /**
   * Best-effort metadata for diagnostics. Returns null if blob absent or
   * the backend cannot produce metadata cheaply. Used by
   * SQLiteMaintenanceService.getStatistics for the dbSizeBytes field.
   * MUST NOT read the blob bytes — return null rather than load to measure.
   */
  getMetadata(): Promise<CacheBlobMetadata | null>;
}

export interface CacheBlobMetadata {
  /** Size in bytes. */
  size: number;
  /** Last-write timestamp in epoch ms. May be approximate. */
  mtime?: number;
}
```

### 2.2 Factory + selection

New file: `src/database/storage/CacheBlobStoreFactory.ts`.

```ts
export interface CacheBlobStoreFactoryOptions {
  app: App;
  /** Vault-relative path used by VaultAdapterCacheBlobStore on mobile. */
  vaultRelativePath: string;
  /** Stable key used by IndexedDBCacheBlobStore. See §3.2. */
  idbKey: string;
}

export function createCacheBlobStore(opts: CacheBlobStoreFactoryOptions): CacheBlobStore {
  if (isDesktop()) {
    return new IndexedDBCacheBlobStore({ idbKey: opts.idbKey });
  }
  return new VaultAdapterCacheBlobStore({
    adapter: opts.app.vault.adapter,
    path: opts.vaultRelativePath
  });
}
```

`isDesktop()` is the existing helper at `src/utils/platform.ts:34-37`. No new
platform abstraction.

### 2.3 Mockability for existing tests

`tests/unit/SQLitePersistenceService.test.ts` currently mocks `vault.adapter.{readBinary,
writeBinary, remove}`. Behind the new interface, the test pattern becomes:

```ts
const blobStore: jest.Mocked<CacheBlobStore> = {
  read: jest.fn(),
  write: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
  getMetadata: jest.fn().mockResolvedValue(null)
};
const service = new SQLitePersistenceService({ bridge, blobStore });
```

Net change: drop the `app` + `dbPath` constructor params, replace with `blobStore`.
The 3 existing test cases map 1:1:

- "creates a fresh schema database when the file is empty" → `blobStore.read.mockResolvedValue(null)`
- "exports the database buffer to the vault adapter on save" → assert `blobStore.write` called
- "recreates the database when integrity check fails" → assert `blobStore.remove` then `blobStore.write` called

---

## 3. Backend implementations

### 3.1 `VaultAdapterCacheBlobStore` (mobile)

New file: `src/database/storage/VaultAdapterCacheBlobStore.ts`.

Wraps the existing `vault.adapter.{readBinary, writeBinary, remove, exists, stat}`
calls. Behavior is identical to today's `SQLitePersistenceService` direct calls.

```ts
export class VaultAdapterCacheBlobStore implements CacheBlobStore {
  constructor(private readonly opts: { adapter: DataAdapter; path: string }) {}

  async read(): Promise<ArrayBuffer | null> {
    const { adapter, path } = this.opts;
    if (!(await adapter.exists(path))) return null;
    const data = await adapter.readBinary(path);
    if (data.byteLength === 0) return null;
    return data;
  }

  async write(buffer: ArrayBuffer): Promise<void> {
    const { adapter, path } = this.opts;
    // Ensure parent dir exists — preserves SQLiteCacheManager.ts:260-264 behavior.
    const parent = path.substring(0, path.lastIndexOf('/'));
    if (parent && !(await adapter.exists(parent))) await adapter.mkdir(parent);
    await adapter.writeBinary(path, buffer);
  }

  async remove(): Promise<void> {
    const { adapter, path } = this.opts;
    try { await adapter.remove(path); } catch { /* idempotent */ }
  }

  async getMetadata(): Promise<CacheBlobMetadata | null> {
    const { adapter, path } = this.opts;
    if (!(await adapter.exists(path))) return null;
    const stat = await adapter.stat(path);
    return stat ? { size: stat.size ?? 0, mtime: stat.mtime } : null;
  }
}
```

The `0-byte → null` semantic preserves existing `SQLitePersistenceService.loadDatabase`
fresh-database logic (line 35-37 of current code: `if (bytes.length === 0) return
this.createFreshDatabase(...)`).

### 3.2 `IndexedDBCacheBlobStore` (desktop)

New file: `src/database/storage/IndexedDBCacheBlobStore.ts`.

#### IDB schema

- **Database name**: `nexus-cache-blob-store`
  - One IDB database for the whole plugin. The plugin instance is singleton per
    Obsidian app session; multiple vault instances open in separate windows/processes
    would each get their own renderer-process IDB scope (per PREPARE §6.2 — IDB scope
    is per-Chromium-profile-per-origin-per-renderer, so this is correct).
- **Object store name**: `cache-blobs`
  - Single object store. Future-proofs for additional cache blobs (e.g., per-vault
    isolated blobs) without schema migration.
- **Key shape**: `string` (out-of-line key, no `keyPath`)
  - Single key value per Nexus install. Computed as `${vaultId}:${pluginManifestDir}`
    so multiple vaults in one Obsidian install do not collide.
  - `vaultId` source: derive from `app.appId` if available, else from the absolute
    vault base path hash (PREPARE §4.2 — `FileSystemAdapter.getBasePath()`). CODE
    phase to confirm `app.appId` is stable across Obsidian restarts; if not, use the
    hash-of-base-path fallback.
- **Value shape**: `{ blob: ArrayBuffer; size: number; mtime: number }`
  - Single record. No chunking. PREPARE §2.2 confirms single 162 MB `put` is the
    right shape (Chromium spills values >1 MB to separate filesystem files behind
    the scenes; chunking buys nothing but adds transaction-coordination complexity).
  - `size` and `mtime` populated on every `write()` for cheap `getMetadata()`.

#### Schema versioning

- IDB `version: 1` initially. The `onupgradeneeded` handler creates the
  `cache-blobs` object store with no `keyPath` (out-of-line keys).
- Future schema changes bump version + add migration logic in `onupgradeneeded`.

#### Operation contracts

```ts
export class IndexedDBCacheBlobStore implements CacheBlobStore {
  private static readonly DB_NAME = 'nexus-cache-blob-store';
  private static readonly STORE_NAME = 'cache-blobs';
  private static readonly DB_VERSION = 1;

  constructor(private readonly opts: { idbKey: string }) {}

  async read(): Promise<ArrayBuffer | null> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBCacheBlobStore.STORE_NAME, 'readonly');
      const req = tx.objectStore(IndexedDBCacheBlobStore.STORE_NAME).get(this.opts.idbKey);
      req.onsuccess = () => {
        const value = req.result as { blob: ArrayBuffer } | undefined;
        resolve(value?.blob ?? null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async write(buffer: ArrayBuffer): Promise<void> {
    const db = await this.openDb();
    const value = { blob: buffer, size: buffer.byteLength, mtime: Date.now() };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBCacheBlobStore.STORE_NAME, 'readwrite');
      tx.objectStore(IndexedDBCacheBlobStore.STORE_NAME).put(value, this.opts.idbKey);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
      tx.onerror = () => reject(tx.error);
    });
  }

  async remove(): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBCacheBlobStore.STORE_NAME, 'readwrite');
      tx.objectStore(IndexedDBCacheBlobStore.STORE_NAME).delete(this.opts.idbKey);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IDB delete aborted'));
      tx.onerror = () => reject(tx.error);
    });
  }

  async getMetadata(): Promise<CacheBlobMetadata | null> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBCacheBlobStore.STORE_NAME, 'readonly');
      const req = tx.objectStore(IndexedDBCacheBlobStore.STORE_NAME).get(this.opts.idbKey);
      req.onsuccess = () => {
        const value = req.result as { size: number; mtime: number } | undefined;
        resolve(value ? { size: value.size, mtime: value.mtime } : null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  private async openDb(): Promise<IDBDatabase> { /* ... cache the connection ... */ }
}
```

CODE phase notes:

- Cache the `IDBDatabase` connection on the instance. Re-open if the connection
  closes (rare but possible on background-tab eviction).
- `navigator.storage.persist()` MAY be requested at construction time, best-effort.
  Per PREPARE §2.4, Electron does not reliably honor it; do NOT branch behavior on
  the result. Just log and proceed.
- `transfer: [buffer]` optimization on `put` is rejected — IDB does not currently
  accept transfer lists on `put`/`add`, and the structured-clone copy on a 162 MB
  ArrayBuffer is ~the bottleneck PREPARE §2.2 measured; it cannot be eliminated.
  If we want to reduce it later, OPFS is the upgrade path.
- Do NOT use `top-level await import('...')` for any IDB shims — Obsidian's renderer
  has `IDBFactory` available at `window.indexedDB` natively. No polyfill needed.

#### Mobile guard

Even though this implementation never runs on mobile (factory selects
`VaultAdapterCacheBlobStore`), the file MUST NOT top-level-import any node builtins
or npm packages with node deps (CLAUDE.md mobile-compat rule). The implementation
above uses only `IDBFactory` / `IDBDatabase` / `IDBTransaction` which are all DOM
types — safe on every platform that loads the bundle.

---

## 4. (Removed) Cloud-sync detection module

Per O9 collapse, no detection module ships. The would-be `src/database/storage/
CloudSyncDetector.ts` is **not part of this design**. The conflict-copy janitor
(see §7) replaces what would have been the "forensic fallback signal" of the
detection module — it cleans up legacy artifacts unconditionally during migration,
without trying to detect whether they came from cloud-sync or from any other source.

---

## 5. Migration state machine

The migration runs once during `SQLiteCacheManager.initialize()` on desktop after
upgrade, before the first `loadDatabase()` call. It is foreground-blocking with an
Obsidian `Notice`.

### 5.1 States and transitions

```
                     ┌─────────────────────────┐
                     │      DETECT             │
                     │ (read plugin-data flag) │
                     └────┬───────────┬────────┘
                          │           │
              not-needed  │           │ needs-migration
                          │           │
                          ▼           ▼
                   ┌──────────┐    ┌──────────────────┐
                   │  DONE    │    │ READ_LEGACY      │
                   │ (steady) │    │ (vault.adapter   │
                   └──────────┘    │  readBinary)     │
                                   └────────┬─────────┘
                                            │ ok
                                            ▼
                                   ┌──────────────────┐
                                   │ WRITE_IDB        │
                                   │ (IDB put)        │
                                   └────────┬─────────┘
                                            │ ok
                                            ▼
                                   ┌──────────────────┐
                                   │ VERIFY           │
                                   │ (IDB read,       │
                                   │  size match)     │
                                   └────────┬─────────┘
                                            │ ok
                                            ▼
                                   ┌──────────────────┐
                                   │ JANITOR          │
                                   │ (delete legacy   │
                                   │  + conflict      │
                                   │  copies)         │
                                   └────────┬─────────┘
                                            │ ok
                                            ▼
                                   ┌──────────────────┐
                                   │ MARK_VERIFIED    │
                                   │ (write flag      │
                                   │  to plugin data) │
                                   └────────┬─────────┘
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │ DONE             │
                                   └──────────────────┘
```

### 5.2 Failure handling

Any state can transition to `FAILED`. Failure modes:

| State | Failure | Action |
|---|---|---|
| READ_LEGACY | `vault.adapter.readBinary` throws (file locked, GDrive remote-fetch failed) | Mark FAILED with error; user-visible Notice "Nexus: Cache migration failed — falling back to fresh cache rebuild from JSONL"; transition to fresh-IDB path (equivalent to first-launch with no cache.db). |
| WRITE_IDB | IDB transaction aborted (quota, eviction race) | Mark FAILED; same fallback as READ_LEGACY. |
| VERIFY | IDB read after write returns null or mismatched size | Mark FAILED; rerun WRITE_IDB once before falling back. |
| JANITOR | `vault.adapter.remove` fails for any sibling | LOG WARNING, continue. Janitor failure does NOT mark migration FAILED (per O8 — janitor is best-effort cleanup, not load-bearing). |
| MARK_VERIFIED | `plugin.saveData` throws | Mark FAILED; user is in a state where IDB has the cache but the flag isn't set, so next launch re-reads legacy. Idempotent — re-running migration is safe (READ_LEGACY → WRITE_IDB overwrites with same bytes). |

The fresh-rebuild fallback path is the same code path as a first-launch user
with no cache.db: `SQLiteCacheManager.initialize()` creates a fresh in-memory DB,
then JSONL-replays into it (existing `SyncCoordinator` behavior).

### 5.3 Idempotency

Migration is idempotent in two senses:

1. **Re-runnable on partial failure**: if MARK_VERIFIED fails, next launch's DETECT
   reads the unset flag, re-runs READ_LEGACY → WRITE_IDB (overwriting the previous
   IDB blob with the same bytes from legacy file) → VERIFY → JANITOR → MARK_VERIFIED.
2. **Skip on success**: once MARK_VERIFIED writes the flag, all subsequent launches
   skip migration entirely. DETECT reads `cacheBackend.migrationState === 'verified'`
   and transitions immediately to DONE.

### 5.4 What runs synchronously vs async at startup

- **Sync (await) inside `SQLiteCacheManager.initialize()`** before `loadFromFile()`:
  DETECT, READ_LEGACY, WRITE_IDB, VERIFY, MARK_VERIFIED.
- **Async (fire-and-forget after initialize)**: JANITOR is fired-and-forgotten with
  a `void migration.runJanitor().catch(err => console.warn(...))`. The migration is
  considered "verified" once VERIFY completes; janitor cleanup is bonus and must
  never block plugin startup.

This keeps user-visible startup time bounded by the legacy read + IDB write + verify
read (~3 disk operations, ~3-4 s typical for 162 MB).

### 5.5 Persistence flag

Add to `PluginScopedStorageState` (already in `PluginScopedStorageCoordinator.ts:23-35`):

```ts
export interface PluginScopedStorageState {
  storageVersion: number;
  sourceOfTruthLocation: SourceOfTruthLocation;
  cacheBackend: CacheBackendState;          // NEW
  migration: { /* existing */ };
}

export interface CacheBackendState {
  /** Which backend is authoritative. 'file' = vault.adapter; 'idb' = IndexedDB. */
  backend: 'file' | 'idb';
  /** Migration completion state, for desktop only. */
  migrationState: 'not_needed' | 'pending' | 'verified' | 'failed';
  migratedAt?: number;
  lastError?: string;
}
```

`backend` is a function of platform: always `'idb'` on desktop after `verified`,
always `'file'` on mobile. Recorded explicitly so a future "migrate-back" path
(e.g., user moves vault from desktop-only to mobile) has the necessary context.

### 5.6 Telemetry / log surface

For debugging future migration hangs (the very class of bug this work fixes), the
state machine emits structured `console.info` lines per transition, prefixed
`[CacheBlobStore.Migration]`:

```
[CacheBlobStore.Migration] DETECT → READ_LEGACY (legacyPath=...)
[CacheBlobStore.Migration] READ_LEGACY → WRITE_IDB (bytes=169869312, ms=842)
[CacheBlobStore.Migration] WRITE_IDB → VERIFY (idbKey=..., ms=1421)
[CacheBlobStore.Migration] VERIFY → JANITOR (matched=true, ms=63)
[CacheBlobStore.Migration] MARK_VERIFIED (totalMs=2410)
[CacheBlobStore.Migration] Janitor: removed 'cache 2.db' (mtime=...)
[CacheBlobStore.Migration] Janitor: failed to remove 'cache (1).db' — continuing
```

These are not user-facing but make `Help → Show debug info` actionable for support.

---

## 6. Conflict-copy janitor

### 6.1 Scope rules

- Runs **only during migration**, after VERIFY succeeds, before MARK_VERIFIED returns
  control. Running async (fire-and-forget) per §5.4 — failure does not block.
- Scans **only** the directory `${pluginDataRoot}/` (= `roots.dataRoot` from
  `PluginScopedStorageCoordinator`), non-recursive.
- Matches files where `basename` matches one of the patterns below.
- After matched-file deletion, also deletes the legacy `cache.db` itself (the now-
  former primary file). This is the actual "migration removes old file" step.

### 6.2 Patterns

```ts
// Patterns ordered by specificity. All anchored.
const CONFLICT_COPY_PATTERNS: RegExp[] = [
  /^cache\.db$/,                                     // legacy primary (delete last)
  /^cache \d+\.db$/,                                 // iCloud: 'cache 2.db'
  /^cache \(\d+\)\.db$/,                             // Finder/Dropbox: 'cache (1).db'
  /^cache_conf\d*\.db$/,                             // generic conflict suffix
  /^cache\[Conflict\].*\.db$/,                       // SharePoint/OneDrive
  /^cache.*conflicted copy \d{4}-\d{2}-\d{2}\.db$/i, // Dropbox dated conflict
  /^cache \(Case Conflict\)\.db$/i,                  // Dropbox case conflict
  /^cache\.db\.[a-f0-9]{6,}$/i                       // rclone: 'cache.db.abc123'
];
```

Test fixtures in CODE/TEST phase MUST cover all 8 patterns plus negative cases:
- `cache.db.bak` (user-created backup) — NOT matched
- `notcache.db` (other file) — NOT matched
- `cache.db_old` — NOT matched (deliberately conservative on user-named variants)

### 6.3 Order of operations

```
1. Iterate `${pluginDataRoot}/` files.
2. For each filename matching any pattern in CONFLICT_COPY_PATTERNS *except*
   the literal 'cache.db', call adapter.remove(path). Log result.
3. AFTER all conflict-copy siblings deleted, delete 'cache.db' itself.
```

The literal-cache.db-last ordering ensures that if the janitor crashes mid-loop,
the next migration run still has the primary file to read from (idempotent re-run).

### 6.4 Error handling

Per-file `try { remove } catch (err) { log warning; continue }`. Janitor never
throws upward. Aggregate result returned for diagnostics:
`{ removed: string[], failed: { path: string; error: string }[] }`.

---

## 7. Wiring point — `SQLitePersistenceService` selects backend at construction

### 7.1 Constructor change

Today (current code, `SQLitePersistenceService.ts:9-13`):

```ts
interface SQLitePersistenceServiceOptions {
  app: App;
  dbPath: string;
  bridge: SQLiteWasmBridge;
}
```

After:

```ts
interface SQLitePersistenceServiceOptions {
  blobStore: CacheBlobStore;
  bridge: SQLiteWasmBridge;
}
```

`app` and `dbPath` are no longer needed inside `SQLitePersistenceService` — both
move into the `CacheBlobStore` implementations. `setDbPath` becomes a no-op
shimmed on the service for backwards compatibility (or removed if there are no
remaining external callers — CODE phase to verify).

The 3 method bodies become:

```ts
async loadDatabase(sqlite3, schemaSql): Promise<SQLiteDatabaseHandle> {
  try {
    const data = await this.blobStore.read();          // was: vault.adapter.readBinary
    if (!data) return this.createFreshDatabase(sqlite3, schemaSql);
    const db = this.bridge.deserializeDatabase(sqlite3, new Uint8Array(data));
    /* ... integrity check unchanged ... */
    return db;
  } catch (error) {
    console.error('[SQLiteCacheManager] Failed to load:', error);
    return this.recreateCorruptedDatabase(sqlite3, schemaSql);
  }
}

async saveDatabase(sqlite3, db): Promise<void> {
  /* ... bridge.exportDatabase unchanged ... */
  await this.blobStore.write(buffer);                  // was: vault.adapter.writeBinary
}

async recreateCorruptedDatabase(sqlite3, schemaSql) {
  try { await this.blobStore.remove(); } catch { /* */ }
  /* ... rest unchanged ... */
}
```

### 7.2 `SQLiteCacheManager` ownership

`SQLiteCacheManager` currently owns `persistenceService` (line 102, constructed at
112-116). Replacement construction:

```ts
const blobStore = createCacheBlobStore({
  app: this.app,
  vaultRelativePath: this.dbPath,                    // mobile-only path — only used by VaultAdapter impl
  idbKey: `${app.appId ?? 'default'}:${pluginManifestDir}`
});
this.persistenceService = new SQLitePersistenceService({
  bridge: this.bridge,
  blobStore
});
```

### 7.3 Migration trigger

`HybridStorageAdapter.applyStoragePlan` (the method containing line 423,
`this.sqliteCache.setDbPath(plan.pluginCacheDbPath)`) is the right call site for
the migration kickoff. Order:

1. Compute `legacyDbPath = plan.pluginCacheDbPath` (the on-disk file path).
2. Construct migration runner with `legacyDbPath`, `app`, plugin-data-state-writer,
   and the IDB blob store handle.
3. **Before** `sqliteCache.initialize()` is called, await
   `migration.runIfNeeded(state)`. The migration determines whether legacy file
   exists at `legacyDbPath` and runs the state machine if so.
4. After migration returns (success or fallback-to-fresh), `sqliteCache.initialize()`
   proceeds normally — either loading the migrated blob from IDB, or starting
   fresh and JSONL-replaying.

CODE phase note: confirm exact call order in `HybridStorageAdapter` — the migration
must run AFTER `applyStoragePlan` resolves the canonical path (line 423) but
BEFORE `sqliteCache.initialize()` is called. If the call sequence is currently
collapsed, split it.

### 7.4 Mobile bypass

On mobile, `createCacheBlobStore` returns `VaultAdapterCacheBlobStore` and the
migration runner returns `state: 'not_needed'` without doing anything. `cacheBackend`
state is recorded as `{ backend: 'file', migrationState: 'not_needed' }`.

---

## 8. "Rebuild Cache" command palette entry

### 8.1 Command registration

Add to `main.ts` `onload()` alongside other command palette entries:

```ts
this.addCommand({
  id: 'nexus-rebuild-cache',
  name: 'Rebuild cache',
  callback: () => this.handleRebuildCacheCommand()
});
```

### 8.2 UX flow

1. **User invokes "Nexus: Rebuild cache" from the command palette.**
2. **Confirmation modal** (Obsidian `Modal` subclass, NOT `confirm()`):
   - Title: "Rebuild cache?"
   - Body: "This will clear the local query cache and rebuild it from the JSONL
     event log. The rebuild typically takes 5-30 seconds depending on your data
     size. Open conversations may briefly show 'loading' while the cache rebuilds."
   - Buttons: `Cancel` (default) | `Rebuild`.
3. **On `Rebuild`**:
   - `Notice("Nexus: Rebuilding cache…", 0)` (sticky until cleared).
   - Call `hybridStorageAdapter.rebuildCache()` (new method, see §8.3).
   - On success: clear sticky Notice; show `Notice("Nexus: Cache rebuilt.", 5000)`.
   - On failure: clear sticky Notice; show `Notice("Nexus: Cache rebuild failed —
     see console.", 10000)` with `console.error` of the actual error.
4. **On `Cancel`**: no-op.

### 8.3 `rebuildCache()` method

New method on `HybridStorageAdapter`:

```ts
async rebuildCache(): Promise<void> {
  // 1. Stop autosave timer + flush nothing (we're throwing it away).
  await this.sqliteCache.stopAutoSave();
  // 2. Close in-memory DB.
  await this.sqliteCache.close();
  // 3. Wipe the blob store.
  await this.blobStore.remove();
  // 4. Re-initialize cache (creates fresh in-memory + IDB-empty).
  await this.sqliteCache.initialize();
  // 5. JSONL-rebuild via existing SyncCoordinator.
  await this.syncCoordinator.rebuildAll();    // verify exact name in CODE
  // 6. Restart autosave.
  await this.sqliteCache.saveToFile();        // initial snapshot
}
```

CODE-phase open: confirm `SyncCoordinator` already exposes a `rebuildAll`-like
method that replays JSONL into a fresh SQLite. The CLAUDE.md note about
`fix/task-board-sync` indicates `SyncCoordinator.rebuildTasks()` exists for the
task subset; verify the full rebuild path against the current API.

### 8.4 Failure handling

If `rebuildCache()` throws after step 3 (blob removed but rebuild failed), the
plugin is left in a state with empty IDB + no in-memory DB. Next plugin reload
will treat it as first-launch and JSONL-replay from scratch — recoverable, just
slower than the in-place rebuild attempt.

The user-facing Notice in step 3.4 explicitly tells the user to check the console
and reload the plugin if rebuild fails.

---

## 9. Test scope

### 9.1 Mandatory unit tests

| File | Coverage |
|---|---|
| `tests/unit/CacheBlobStore.contract.test.ts` | Contract test exercised against BOTH implementations: `read returns null when absent`, `write then read round-trips bytes`, `remove makes read return null`, `getMetadata returns size after write`, `0-byte buffer treated as absent`. |
| `tests/unit/IndexedDBCacheBlobStore.test.ts` | IDB-specific: schema creation in `onupgradeneeded`, transaction abort propagates as throw, key isolation between two `idbKey` values, connection re-open after close. Use `fake-indexeddb` Jest dependency (already-present? CODE to verify; if not, add). |
| `tests/unit/VaultAdapterCacheBlobStore.test.ts` | Adapter-mock-driven: parent dir creation, idempotent remove, `0-byte → null` semantic, `exists` short-circuit before `readBinary`. |
| `tests/unit/SQLitePersistenceService.test.ts` | UPDATED: existing 3 tests retargeted to mock `CacheBlobStore` instead of `vault.adapter`. No new test cases. |
| `tests/unit/CacheBlobStoreFactory.test.ts` | `Platform.isDesktop = true` returns `IndexedDBCacheBlobStore`; `false` returns `VaultAdapterCacheBlobStore`. Use module-mock pattern (already-used in codebase per `src/utils/platform.ts` callers — verify pattern). |
| `tests/unit/CacheBackendMigration.test.ts` | State machine: happy-path (DETECT → DONE in 5 transitions); each failure mode (READ_LEGACY fail, WRITE_IDB fail, VERIFY fail, JANITOR fail-warn-continue, MARK_VERIFIED fail re-run). Idempotent re-run after MARK_VERIFIED failure. Mobile bypass returns `not_needed`. |
| `tests/unit/CacheBackendMigration.janitor.test.ts` | Each pattern in §6.2 matched; negative cases (`cache.db.bak`, `notcache.db`, `cache.db_old`); per-file failure does not abort sweep; literal `cache.db` deleted last. |

### 9.2 Mandatory integration tests

| Test | Coverage |
|---|---|
| `tests/integration/cache-backend-cold-boot.test.ts` | Fresh plugin install (no IDB, no legacy file): cold-boot creates fresh DB, schema migrates, JSONL replays, IDB blob written. |
| `tests/integration/cache-backend-migration-end-to-end.test.ts` | With a fixture legacy `cache.db` blob in vault adapter, run migration, assert IDB has the same bytes, assert legacy file removed, assert flag set. Run twice — second run skips. |
| `tests/integration/cache-backend-rebuild-cache-command.test.ts` | After IDB has data, invoke `rebuildCache()`, assert IDB cleared, fresh DB rebuilt from JSONL, autosave snapshot persisted. |

### 9.3 Manual smoke tests (CODE/QA)

- **Real-vault desktop migration**: install built plugin into a vault with an
  existing 100+ MB cache.db. Verify foreground Notice appears, completes in
  <10 s on warm SSD, IDB blob populated, legacy file removed.
- **GDrive Shared Drive vault**: install into the original repro vault (Synaptic
  Labs). Verify migration completes despite GDrive activity; `waitForQueryReady`
  resolves promptly; no `cache 2.db` ever appears.
- **Mobile (iOS + Android)**: install built plugin on mobile, verify no migration
  runs (`cacheBackend.migrationState = 'not_needed'`), cache.db continues to
  function via `vault.adapter` path.
- **Rebuild Cache command**: with a populated IDB, run command, verify
  confirmation modal, click Rebuild, watch Notice, verify cache rebuilt.
- **DevTools wipe recovery**: Chrome DevTools → Application → IndexedDB → delete
  `nexus-cache-blob-store`. Reload plugin. Verify it treats the empty IDB as
  first-launch and JSONL-replays cleanly.
- **Force-fail migration**: corrupt the legacy cache.db bytes on disk (truncate
  to 100 bytes), launch plugin, verify migration falls back to fresh-rebuild
  path with the documented Notice.

---

## 10. Open questions for CODE phase

These are deliberately left to coder discretion:

| # | Question | Architect's lean |
|---|---|---|
| C1 | `app.appId` stability across restarts vs hash-of-base-path fallback for `idbKey` (§3.2) | Test `app.appId` first; fall back to base-path hash if not stable. Both are stable across restarts in practice; question is which is canonical. |
| C2 | Exact name of full-rebuild method on `SyncCoordinator` (§8.3) | Verify against current API — `rebuildAll`, `rebuildFromJsonl`, or compose from `rebuildTasks` + others. |
| C3 | Whether `SQLitePersistenceService.setDbPath` shim is needed for backwards compatibility (§7.1) | Audit external callers; if none remain after `SQLiteCacheManager`/`SQLiteMaintenanceService` migration, delete it. |
| C4 | Whether `fake-indexeddb` is already a dev dependency (§9.1) | If not, add to `devDependencies` (~600 LoC, MIT, well-maintained). |
| C5 | Whether `navigator.storage.persist()` should be invoked best-effort at IDB open (§3.2 NOTE) | YES, best-effort, log result, do not branch behavior. |
| C6 | Migration progress reporting beyond a single Notice (e.g., percent complete during 162 MB read) | NO for this PR. The full operation is 2-7 s; a percent bar is unnecessary. If felt slow, add later. |

---

## 11. Hard constraints (non-negotiable)

Restated from PREPARE §8.1 + CLAUDE.md:

- `isDesktopOnly: false` MUST be preserved. The IDB code path is desktop-only at
  selection time; the bundle still loads on mobile.
- No top-level imports of node builtins. `desktopRequire()` only — and the IDB
  implementation needs zero node builtins (pure DOM API).
- No `addEventListener` for DOM events (use `registerDomEvent`). The Rebuild
  Cache modal must use Obsidian's `Modal` class for cleanup.
- LF line-endings. No CRLF. No `git add --renormalize` debris.
- Existing `SQLitePersistenceService.test.ts` mock-pattern must continue to
  work (3 cases, retargeted to mock `CacheBlobStore`).

---

## 12. Reasoning chain

How the key decisions connect:

1. PREPARE §1.5 surfaced that "cache.db local-only" was documented but not
   architecturally enforced → O1 = enforce via interface.
2. O1 requires the structural property "blob lives somewhere no third-party sync
   client can reach" → on desktop, IDB; on mobile, fall back to `vault.adapter`
   because mobile doesn't have the threat model AND iOS IDB durability is too
   weak for the data size.
3. With desktop = IDB unconditionally, O9's heuristic detection module becomes
   redundant and worse: detection fragility (Linux unreliability, regex maintenance)
   adds risk for zero structural benefit. → O9 collapses to "always-on IDB on
   desktop".
4. With heuristic detection gone, the only legacy artifacts to clean up are the
   files left behind by previous (file-on-disk) versions. The conflict-copy
   janitor (O8) is the cleanup pass; it runs once during migration and is best-
   effort.
5. With migration scope reduced to "read 162 MB, write 162 MB, verify, mark
   done", PREPARE §6.1's 2-7 s estimate fits inside the 60 s `waitForQueryReady`
   budget → O7 = foreground-blocking with Notice (rejects original async-deferred
   prior because dual-backend coexistence window adds more complexity than 2-7 s
   of polite background work saves).
6. With migration foreground-blocking and structural local-only, the new user-
   visible recovery path is "Rebuild Cache" command (O4) — file-system delete
   no longer applies because the bytes are in IDB.
7. Performance characteristics of IDB at 162 MB (PREPARE §2.2: ~1.4 s structured-
   clone + put) are good enough for a 30 s autosave cadence → O2 = no hash-
   gating, dirty-flag is sufficient → O5 = OPFS not needed, IDB is the right
   tier of complexity for the requirement.
8. Linux unreliability concern (O6) is moot once detection is removed.

The shape of the PR is therefore minimal: 1 interface, 2 implementations, 1
factory, 1 state machine, 1 janitor, 1 command, 3 method-body changes in
`SQLitePersistenceService`. No new platform abstractions, no new async
primitives, no Worker bridges, no schema migration on existing SQLite.
