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
| `conversations/<conversationId>/shard-*.jsonl` | conversation events |
| `workspaces/<workspaceId>/shard-*.jsonl` | workspace/session/state/trace events |
| `tasks/<workspaceId>/shard-*.jsonl` | task/project events |
| `_meta/` | storage and migration manifests |

**Legacy read paths** — read/migration fallback only, never a write target:
`.obsidian/plugins/<plugin-folder>/data/`, compatibility plugin folders (`nexus`,
`claudesidian-mcp`), legacy `.nexus/`, and `storage.previousRootPaths`.

**Local-only cache** — auto-rebuilt from JSONL, never synced:

- **Desktop:** IndexedDB via `IndexedDBCacheBlobStore` — cloud-sync-immune. A
  first-launch migration FSM upgrades existing `cache.db` installs.
- **Mobile:** `vault.adapter` file backend via `VaultAdapterCacheBlobStore`.
- Chosen by `src/database/storage/CacheBlobStoreFactory.ts`.

The cloud-sync immunity is the point: a synced `cache.db` was the cause of boot
hangs and revert incidents on Google Drive and Dropbox. Do not move cache data back
under a synced path.

## Path resolution — never hardcode

- `resolveVaultRoot(settings, { configDir })`
  (`src/database/storage/VaultRootResolver.ts:133`) for the configured synced event
  root. Never hardcode `Nexus` except as `DEFAULT_STORAGE_SETTINGS.rootPath`.
- `resolvePluginStorageRoot()`
  (`src/database/storage/PluginStoragePathResolver.ts:26`) for plugin-scoped
  compatibility/cache paths. Never hardcode `.nexus` for new writes.

## SQLite schema

`CURRENT_SCHEMA_VERSION` lives in `src/database/schema/SchemaMigrator.ts:76`.
Currently **13**.

| Version | Added |
|---|---|
| v9 | 4 task tables |
| v10 | workflow columns |
| v11 | archive flag |
| v12 | `shard_cursors` |
| v13 | `skills` table |

Adding a table means bumping `CURRENT_SCHEMA_VERSION` and adding the migration —
the cache is rebuildable, so migrations may drop and repopulate rather than
transform in place.

Other properties: true database pagination with OFFSET/LIMIT; workspace-scoped
sessions and traces; searchable via the MemoryManager and SearchManager agents.

## Migration and recovery

On startup, legacy JSONL sources are read and migrated into the configured
vault-root event store **without deleting the originals**. Two user-facing
commands:

- **Nexus: Refresh synced data** — for mobile users whose vault syncs after init
- **Nexus: Rebuild cache** — recovers from a corrupted cache

## Traps

- **Denormalize before you shortcut.** A metadata fast-path that skips the JSONL
  content fetch will miss fields that live only in content — an archive-visibility
  bug came from exactly this. If a filter needs a field, denormalize it into the
  metadata rather than skipping the fetch.
- **Hydration gates.** Reads that race startup must await the adapter's readiness
  (`waitForQueryReady()`) or they return empty on a cold cache and render as "no
  data" rather than "not ready".
- **Conflict-copy patterns.** `CONFLICT_COPY_PATTERNS`
  (`src/database/migration/CacheBackendMigration.ts:12`) does not match the Dropbox
  `cache (User's conflicted copy YYYY-MM-DD).db` form — the closing paren before
  `.db` breaks the anchor.
