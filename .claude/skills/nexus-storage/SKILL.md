---
name: nexus-storage
description: Nexus storage and memory architecture — the JSONL event store, the rebuildable SQLite cache, path resolution, cache backends, and schema migrations. Use when reading or writing persisted data, resolving a vault or plugin storage path, adding a SQLite table or migration, or debugging sync, hydration, or cache-rebuild problems.
---

# Nexus Storage & Memory

## Model

**Hybrid JSONL + SQLite.** The sharded JSONL event store is the source of truth;
SQLite is a rebuildable fast query/vector cache. Anything in SQLite must be
reconstructible from JSONL — never treat it as authoritative.

## Where data lives

**Primary synced event store** — settings-derived vault root,
`settings.storage.rootPath` (default `Nexus`), with managed data under
`<rootPath>/data/`:

| Path | Contents |
|---|---|
| `conversations/conv_<conversationId>/shard-*.jsonl` | conversation events |
| `workspaces/ws_<workspaceId>/shard-*.jsonl` | workspace/session/state/trace events |
| `tasks/tasks_<workspaceId>/shard-*.jsonl` | task/project events |
| `_meta/` | `storage-manifest.json`, `migration-manifest.json`, `migration-report.json` |

Note the stream-directory **prefixes** (`conv_`, `ws_`, `tasks_`) — repositories
build the logical path (e.g. `ConversationRepository`, `WorkspaceRepository`,
`TaskRepository`), and `VaultEventStore` turns each logical `<category>/<id>.jsonl`
into a directory of `shard-NNNNNN.jsonl` files. Only three categories exist:
`conversations | workspaces | tasks` (`EventStreamUtilities.ts`).

**Legacy read paths** — read/migration fallback only, never a write target.
`PluginScopedStorageCoordinator.prepareStoragePlan` assembles them as:
`<configDir>/plugins/<active-plugin-folder>/data/`, compatibility plugin folders
(`nexus`, `claudesidian-mcp`), legacy `.nexus/`, and each entry of
`storage.previousRootPaths` suffixed with `/data`.

**Local-only cache** — auto-rebuilt from JSONL, never synced:

- **Desktop:** IndexedDB via `IndexedDBCacheBlobStore` — cloud-sync-immune. A
  first-launch, foreground-blocking migration FSM
  (`CacheBackendMigration`: DETECT → READ_LEGACY → WRITE_IDB → VERIFY →
  MARK_VERIFIED → DONE, plus a fire-and-forget janitor) upgrades existing
  `cache.db` installs. Mobile short-circuits it (`mobile_bypass`).
- **Mobile:** `vault.adapter` file backend via `VaultAdapterCacheBlobStore`.
- Chosen by `createCacheBlobStore` in
  `src/database/storage/CacheBlobStoreFactory.ts`, on `isDesktop()`.

The cloud-sync immunity is the point. The documented trigger incident
(`docs/architecture/cloud-sync-cache-backend.md`) was a 162 MB `cache.db` inside a
Google Drive Shared Drive conflict-copying mid-write, timing out
`waitForQueryReady` at 60 s; the reconcile work
(`docs/plans/sync-safe-storage-reconcile-plan.md`, `ReconcilePipeline`) handles the
related silent-overwrite/revert pattern. Do not move cache data back under a synced
path.

## Path resolution — never hardcode

- `resolveVaultRoot(settings, { configDir })`
  (`src/database/storage/VaultRootResolver.ts:133`) for the configured synced event
  root. Never hardcode `Nexus` except as `DEFAULT_STORAGE_SETTINGS.rootPath`.
- `resolvePluginStorageRoot(app, plugin)`
  (`src/database/storage/PluginStoragePathResolver.ts:26`) for plugin-scoped
  compatibility/cache paths. Never hardcode `.nexus` for new writes.

## SQLite schema

`CURRENT_SCHEMA_VERSION` lives in `src/database/schema/SchemaMigrator.ts:76`.
Currently **13**.

The `MIGRATIONS` array in the same file is the authority. v1→v2 and v3→v4 have no
migration entry (v2 matched v1; v4's branch tables were fresh-install-only and are
dropped by v5), so the array starts at v3:

| Version | Added |
|---|---|
| v3 | `alternativesJson` + `activeAlternativeIndex` on `messages` (branching) |
| v5 | **drops** `branches` / `branch_messages` — branches ARE conversations |
| v6 | `dedicatedAgentId` on `workspaces` + `custom_prompts` table |
| v7 | conversation embedding tables + denormalized `workspaceId`/`sessionId` on `conversations` |
| v8 | `referencedNotes` on `conversation_embedding_metadata` |
| v9 | 4 task tables: `projects`, `tasks`, `task_dependencies`, `task_note_links` |
| v10 | workflow run columns on `conversations` (`workflowId`, `runTrigger`, `scheduledFor`, `runKey`) + a `migrationFn` backfill from `metadataJson` |
| v11 | `isArchived` on `workspaces` |
| v12 | `shard_cursors` table (per-file reconcile fast-path) |
| v13 | `skills` table, `UNIQUE(provider, name)` |

Adding a table is the 3-step procedure documented at the top of `SchemaMigrator.ts`:
bump `CURRENT_SCHEMA_VERSION`, append a `MIGRATIONS` entry, **and** update
`SCHEMA_SQL` in `src/database/schema/schema.ts` so fresh installs get it too.
Migrations are **additive and idempotent** — `CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` (the migrator skips an
ADD COLUMN whose column already exists). Never edit an existing migration; drops,
renames and type changes are not supported. A migration that needs data reshaped
in JS uses the optional `migrationFn` hook (see v10).

Other properties: true database pagination with `LIMIT ? OFFSET ?`
(`BaseRepository.queryPaginated`, `SQLiteCacheManager`); workspace-scoped sessions
and traces (both `SessionRepository` and `TraceRepository` write the same
`workspaces/ws_<workspaceId>` stream); searchable via the MemoryManager and
SearchManager agents (`searchManager/tools/searchMemory.ts`).

## Migration and recovery

On startup, legacy JSONL sources are read and migrated into the configured
vault-root event store **without deleting the originals**
(`VaultRootMigrationService`, fed `legacyReadBasePaths` by
`PluginScopedStorageCoordinator`). Two user-facing commands, both registered in
`src/core/commands/MaintenanceCommandManager.ts`:

- **Nexus: Refresh synced data** (id `refresh-synced-data`) — calls
  `adapter.sync()`; for mobile users whose vault syncs after init
- **Nexus: Rebuild cache** (id `rebuild-cache`) — confirm-modal gated, then
  `StorageMaintenanceService.rebuildCache`: stop autosave → close cache → remove
  the cache blob → reinitialize → `syncCoordinator.fullRebuild()` from JSONL.
  The synced JSONL event store is never touched.

## Traps

- **Denormalize before you shortcut.** A metadata fast-path that skips the JSONL
  content fetch will miss fields that live only in content — an archive-visibility
  bug came from exactly this. If a filter needs a field, denormalize it into the
  metadata rather than skipping the fetch.
- **Hydration gates.** Reads that race startup must await the adapter's readiness
  (`waitForQueryReady()` — optional on `IStorageAdapter`, implemented by
  `HybridStorageAdapter`, waiters resolved by `StartupHydrationController`) or they
  return empty on a cold cache and render as "no data" rather than "not ready".
  Existing gates: `TaskBoardDataController`, `TaskService`, `DualBackendExecutor`,
  `ProjectsManagerView`.
- **Conflict-copy patterns.** `CONFLICT_COPY_PATTERNS`
  (`src/database/migration/CacheBackendMigration.ts:12`) does not match the Dropbox
  `cache (User's conflicted copy YYYY-MM-DD).db` form. The entry is
  `/^cache.*conflicted copy \d{4}-\d{2}-\d{2}\.db$/i`, which requires `.db`
  immediately after the date — the closing paren breaks the anchor. Verified: the
  full pattern list returns `false` for
  `cache (User's conflicted copy 2026-01-01).db`, and for the very example in that
  line's own trailing comment. The unparenthesised
  `cache conflicted copy 2026-01-01.db` does match.
