# Vault-Root Data And Guides Plan

## Goal

Move synced assistant data out of plugin data and into a normal vault folder so cross-device chat state works with Obsidian Sync constraints, while also introducing a system-managed guides workspace that lives alongside the synced data.

The new design should:

- use a vault-root `Nexus/` folder by default
- allow the user to choose a different vault-relative root such as `storage/nexus`
- place all synced assistant-owned content under that configured root
- split the root into fixed `guides/` and `data/` subfolders
- shard append-only JSONL files before they exceed the Obsidian Sync per-file limit
- keep `cache.db` as a local-only rebuildable cache
- migrate existing data from legacy locations without losing conversations, workspaces, or tasks
- expose a built-in docs workspace backed only by the `guides/` subtree

## Why This Change

The current model is blocked by two constraints we have now confirmed:

- Obsidian Sync does not reliably sync arbitrary plugin data files under `.obsidian/plugins/<plugin>/data/`
- Obsidian Sync enforces per-file size limits, so a single ever-growing conversation JSONL is not a safe synced format

The existing plugin architecture is still directionally correct:

- append-only event files are the right source of truth
- SQLite is the right local query model

The problem is only the location and file-shape of the synced store.

## Product Direction

### Configured root

The user configures a single vault-relative assistant root folder:

- default path: `Nexus/`
- configurable path: any vault-relative non-plugin path such as `storage/nexus`

Inside that root, the plugin owns a fixed internal structure:

- `<root>/guides/`
- `<root>/data/`

The setting controls the root only. The plugin controls the internal subfolders.

### Synced event store

Synced event data moves under:

- `<root>/data/`

This becomes the only write target for new synced conversation, workspace, and task events.

### Guides workspace

System-managed documentation lives under:

- `<root>/guides/`

The `guides/` subtree is the backing store for a built-in docs workspace that the model can consult for self-knowledge, capabilities, and operational guidance.

The navigator file is:

- `<root>/guides/index.md`

### Local cache

SQLite remains local-only:

- path: `.obsidian/plugins/<active-plugin-folder>/data/cache.db`
- rebuilt from the vault-root event store
- never treated as a cross-device source of truth

### User-configurable root

The plugin exposes a storage setting for the assistant root folder.

- default: `Nexus`
- stored in plugin `data.json`
- changing it triggers a managed migration from the previous root to the new one

## Non-Goals

- Do not sync `cache.db`
- Do not make `data.json` the full conversation payload store
- Do not keep plugin data as the long-term synced write target
- Do not rely on hidden root dotfolders for sync-critical content
- Do not let the built-in guides workspace read conversation, task, workspace, shard, or metadata files
- Do not treat the built-in guides workspace as a normal user-editable workspace entity

## Root Layout

## Default root

`Nexus/`

## Proposed structure

```text
Nexus/
  guides/
    _meta/
      guides-manifest.json
    index.md
    capabilities/
      ...
    workflows/
      ...
    models/
      ...
    custom/
      ...
  data/
    _meta/
      storage-manifest.json
      migration-manifest.json
    conversations/
      <conversation-id>/
        shard-000001.jsonl
        shard-000002.jsonl
    workspaces/
      <workspace-id>/
        shard-000001.jsonl
    tasks/
      <workspace-id>/
        shard-000001.jsonl
```

Notes:

- `conversation-id`, `workspace-id`, and task scope IDs should be stored exactly once, without double-prefix bugs like `conv_conv_...`
- one directory per logical stream avoids giant flat folders and makes shard rotation explicit
- `guides/_meta/` and `data/_meta/` hold small control files only
- `guides/custom/` is reserved for possible future user-authored additions and should not be overwritten by guide refreshes

## Guides Workspace Model

The built-in docs workspace should be treated as a system-managed, derived workspace rather than a normal user-authored workspace.

### Scope

Allowed:

- `<root>/guides/index.md`
- `<root>/guides/**/*.md`

Explicitly excluded:

- `<root>/data/**`
- `<root>/guides/_meta/**`
- any `.jsonl`, `.db`, shard, cache, or migration file outside markdown guide content

### Semantics

The workspace should be:

- available to the model
- hidden from normal user workspace CRUD flows by default
- not renameable, deletable, or editable via Nexus workspace-management UI
- dynamically resolved from the configured root path instead of persisted like a normal user workspace

Important clarification:

- the guide files are still normal vault files, so a user can technically inspect or edit them in Obsidian
- Nexus should treat them as system-managed files and reserve the right to refresh managed guide files during plugin updates

### Load behavior

Do not load the entire `guides/` tree by default.

Preferred load flow:

1. start with `guides/index.md`
2. use that file as the navigator
3. load additional guide markdown files selectively as needed

This keeps the workspace useful without bloating prompts or accidentally mixing in irrelevant docs.

## Guides Content Model

### Entry point

`guides/index.md` is the single required navigator file.

It should:

- describe what the docs workspace is
- explain what guide sections exist
- link to the most important deeper guides
- give the model clear directions about where to look for capability, workflow, and troubleshooting information

### Managed files

The plugin should own a set of managed guide files that ship with the plugin version and can be refreshed on update.

Suggested examples:

- `guides/index.md`
- `guides/capabilities/*.md`
- `guides/workflows/*.md`
- `guides/models/*.md`

### Manifest

Add a guides manifest:

- path: `<root>/guides/_meta/guides-manifest.json`

Suggested fields:

- plugin version
- guide schema version
- managed file list
- content hashes
- last refresh timestamp
- last refresh source

This manifest lets us:

- update only managed files
- avoid blind overwrites
- distinguish system-owned files from user-added files

### Refresh policy

Recommended priority:

1. bundled docs from the installed plugin version
2. optional GitHub refresh after update, if we decide to support that later

This keeps startup and upgrades deterministic even when offline.

## Sharding Strategy

### Target limit

Use a conservative shard limit of `4 MB`.

Rule:

- before appending an event, compute the byte length of the new line
- if `currentShardSize + newLineSize > maxShardBytes`, rotate to the next shard

### Scope

Sharding applies to all append-only streams:

- conversations
- workspaces
- tasks

Conversations are the urgent case, but the implementation should be generic so other streams do not hit the same ceiling later.

### Read behavior

Reads concatenate shards in shard order, then event timestamp order where needed.

### Write behavior

Only the latest shard for a stream is writable.

### Metadata

The writer should not need a heavyweight central index just to append. It can determine the active shard by:

- listing shard files in the stream directory
- reading the last shard's size
- rotating when the next append would cross the threshold

A lightweight manifest may still be helpful for diagnostics and migration, but it should not be required for correctness.

## Settings Design

Add a dedicated storage settings block to `MCPSettings` instead of overloading `memory`.

Suggested shape:

```ts
storage?: {
  rootPath?: string;
  maxShardBytes?: number;
  schemaVersion?: number;
}
```

Defaults:

- `rootPath: "Nexus"`
- `maxShardBytes: 4 * 1024 * 1024`

### Validation rules

Accepted:

- vault-relative paths such as `Nexus`, `storage/nexus`, `Archive/Nexus Data`

Rejected:

- absolute paths
- paths under `.obsidian/plugins/`
- paths under `.obsidian/`
- empty strings
- traversal segments like `..`

Recommended:

- visible folders only, not hidden dotfolders

If we allow hidden folders at all, the UI should warn that sync behavior may be unreliable.

## Migration Plan

## New storage version

Bump storage version from `1` to `2`.

Current sources to read during migration:

- legacy `.nexus/`
- `.obsidian/plugins/claudesidian-mcp/data/`
- `.obsidian/plugins/nexus/data/`

New root destination:

- `settings.storage.rootPath ?? "Nexus"`

New data destination:

- `<root>/data`

New guides destination:

- `<root>/guides`

### Migration phases

#### Phase 1: Introduce vault-root root resolution

- add a new storage root resolver for the configured vault folder
- keep plugin data resolver only for local cache paths
- update storage state to record:
  - configured root path
  - resolved guides path
  - resolved data path
  - migration state
  - legacy sources detected
  - last successful migration timestamp

#### Phase 2: Copy and split legacy event files

For each legacy JSONL file:

- identify the logical stream
- read all events
- write them into the new stream directory under `<root>/data`
- split into shards under `4 MB`
- preserve event IDs and timestamps exactly

#### Phase 3: Materialize guides subtree

- ensure `<root>/guides/` exists
- write bundled managed guide files
- write or refresh `guides/_meta/guides-manifest.json`
- ensure `guides/index.md` exists before the system workspace becomes visible to the model

#### Phase 4: Verify before cutover

Verification should compare:

- logical stream presence
- event counts
- first/last event IDs or hashes
- total bytes written

Do not cut over until verification succeeds.

#### Phase 5: Switch writes to vault-root data

After verification:

- write only to `<root>/data`
- read from `<root>/data` first
- keep legacy roots as fallback read sources for one release cycle

#### Phase 6: Rebuild local cache from vault-root data

On the next boot after cutover:

- open or create local `cache.db`
- rebuild or incrementally sync from `<root>/data` shards

## User-Driven Root Folder Changes

When the user changes the configured root path in settings:

1. Validate the new path.
2. Acquire a storage migration lock.
3. Flush pending writes.
4. Copy current root contents to the new root.
5. Verify copied data.
6. Update the stored root setting.
7. Repoint future reads/writes to the new root.
8. Rebuild local cache if needed.
9. Offer cleanup of the old root after success.

Important:

- implement as copy-verify-switch, not raw filesystem rename
- this is safer across adapters and avoids partial moves leaving the app with no readable source

### Existing destination behavior

If the destination folder already exists:

- do not blindly overwrite
- merge by stream and shard only if verification proves the destination is either identical or a strict superset
- otherwise stop and present a conflict notice with a manual recovery path

## Runtime Read/Write Rules

## Writes

Event writes go to `<root>/data` only.

Managed guide writes go to `<root>/guides` only.

Local cache writes go to plugin data only.

## Reads

Read priority:

1. configured `<root>/data`
2. prior configured `<root>/data`, if a move is in progress
3. plugin data legacy roots
4. `.nexus`

This fallback order is temporary and should be removable after one or two successful migration versions.

## Cache Rebuild Rules

`cache.db` is rebuilt from `<root>/data` only.

The cache should not depend on plugin data JSONL anymore once migration is complete.

## System Workspace Integration

## Runtime representation

Represent the guides workspace as a reserved system workspace rather than a standard persisted workspace record.

Suggested properties:

- reserved system ID
- system-managed flag
- root path resolved from `<root>/guides`
- navigator path resolved from `<root>/guides/index.md`
- special capability tag indicating docs/self-knowledge scope

This should avoid polluting normal workspace CRUD storage and keep the feature resilient when the configured root changes.

## Prompt behavior

The system prompt should not inline the whole guides workspace.

Instead it should:

- mention that a built-in documentation workspace exists
- instruct the model to start from `guides/index.md`
- encourage selective loading of deeper guide files only when needed

Good use cases:

- capability questions
- workflow guidance
- provider/model behavior
- troubleshooting
- plugin self-knowledge and operational instructions

Bad use cases:

- routine chat where no guide lookup is needed
- loading all guide files by default
- treating guide docs as the same thing as user workspace state

## Sync Model

The synced event store is sharded JSONL in a normal vault folder under `<root>/data`.

That means:

- desktop writes event shards
- Obsidian Sync transfers those shards
- mobile replays them into local `cache.db`
- mobile reads from `cache.db`

Managed guide markdown files under `<root>/guides` also sync as normal vault files, but they are not part of the event-log replay model.

This preserves SQLite speed on mobile without treating the DB file as a sync artifact.

## Edge Cases

## Oversized legacy conversation files

Legacy single-file JSONLs may already exceed 4 MB.

Migration must:

- split them into ordered shards
- preserve event order
- not attempt a one-file copy to the new root

## Concurrent device writes during migration

One device may migrate while another is still writing to a legacy root.

Mitigation:

- keep legacy roots in fallback reads temporarily
- preserve event IDs so dedupe still works
- prefer `<root>/data` for all new writes immediately after a device migrates
- on later boots, merge any straggler legacy events into vault-root shards

## Root path changes syncing across devices

Because the configured root path lives in `data.json`, another device may receive the setting before it has copied data locally.

Mitigation:

- store migration state alongside the configured root
- if a device sees a new configured root but local migration is incomplete, it should:
  - read configured `<root>/data` first
  - read previous `<root>/data` as fallback
  - rebuild cache from whichever streams are actually present

The guides workspace should also follow the new root automatically because it is derived from the configured root, not independently configured.

## Partial copy or app kill during migration

Migration must be resumable.

Needed:

- migration manifest file with copied streams/shards
- verification report
- idempotent copy logic

## Path conflicts

The user may choose a path that already contains unrelated files.

Behavior:

- validate and warn before moving
- refuse to merge into a non-Nexus-looking folder automatically

## Managed guide edits

Users may manually edit markdown files under `<root>/guides/`.

We need an explicit overwrite policy for managed files:

- safest default: only overwrite a managed file when its current hash matches the previously-managed hash
- if the file diverged, skip overwrite and mark the conflict in the guides manifest

This avoids silently destroying user edits while still letting system-managed docs update.

## Missing or broken guides

If `guides/index.md` or the managed guides manifest is missing:

- recreate missing managed guide files from the bundled plugin assets
- keep the built-in docs workspace available if recovery succeeds
- surface a degraded-state warning only if recovery fails

## Search and retrieval pollution

The built-in guides workspace should not dominate normal user workspace retrieval.

Mitigation:

- keep it out of normal workspace browsing by default
- apply separate ranking or explicit invocation rules when the model is consulting docs
- prefer `index.md` first, then selective file loads

## Empty data folder with valid local cache

If `<root>/data` is empty but `cache.db` contains data, do not silently trust the DB as authoritative.

Behavior:

- surface a warning
- keep UI usable from cache
- mark the store as degraded until a repair or migration reconciliation runs

## Large vaults

Inventory and rebuild logic should stream by shard and avoid loading giant logical streams into memory when possible.

## Conversation ID filename compatibility

Current legacy logs show filenames like `conv_conv_<id>.jsonl`.

Migration should normalize logical IDs once and only once:

- the stream directory name should be the true conversation ID
- fallback readers must still understand old prefixed filenames

## Files and Systems to Update

## Storage and migration core

- `src/database/adapters/HybridStorageAdapter.ts`
- `src/database/storage/JSONLWriter.ts`
- `src/database/sync/SyncCoordinator.ts`
- `src/database/migration/PluginScopedStorageCoordinator.ts`
- `src/database/storage/PluginStoragePathResolver.ts`

## New components likely needed

- `src/database/storage/VaultRootResolver.ts`
- `src/database/storage/ShardedEventStore.ts`
- `src/database/migration/VaultRootStorageCoordinator.ts`
- `src/database/migration/ShardMigrationService.ts`
- `src/guides/GuidesManifestService.ts`
- `src/guides/GuidesInstallerService.ts`
- `src/guides/SystemGuidesWorkspaceProvider.ts`

## Local cache and startup

- `src/database/storage/SQLiteCacheManager.ts`
- `src/main.ts`
- `src/core/services/ServiceRegistrar.ts`

## Settings and UI

- `src/types/plugin/PluginTypes.ts`
- `src/types.ts`
- `src/settings.ts`
- settings UI tab(s) where storage configuration belongs

## Workspace and prompt systems

- workspace listing/loading services that decide what the model can load
- workspace CRUD/UI code so the built-in guides workspace is treated as system-managed
- system prompt composition code so the docs workspace is discoverable but not eagerly inlined

## Read-model consumers

- `src/services/ConversationService.ts`
- any repositories or query services that assume flat single-file JSONL naming

## Data model changes

### `PluginScopedStorageState`

This likely needs to evolve into a broader storage state model, for example:

- storage version
- configured root path
- previous root path
- derived guides path
- derived data path
- migration status
- legacy sources detected
- verification metadata

The current `sourceOfTruthLocation: 'legacy-dotnexus' | 'plugin-data'` is too narrow for the new world and should become something like:

- `'legacy-dotnexus'`
- `'legacy-plugin-data'`
- `'vault-root-data'`

## Testing Plan

## Unit tests

- shard rotation at threshold boundary
- reading ordered events across multiple shards
- migration from single-file JSONL to shards
- migration from `.nexus`, `claudesidian-mcp/data`, and `nexus/data`
- root path validation
- root path move copy-verify-switch flow
- fallback read order when configured root is empty or partially migrated
- stream ID normalization for `conv_conv_*` legacy files
- guides manifest installation and update rules
- guides overwrite-skip behavior for user-modified files
- built-in guides workspace scoping so only `guides/**/*.md` is visible
- root-path change behavior for the built-in guides workspace

## Integration/manual tests

- desktop creates conversation, mobile receives it
- mobile creates conversation, desktop receives it
- conversation grows past 4 MB and rotates shards safely
- user changes root path from `Nexus` to `storage/nexus`
- app restarts mid-migration and resumes safely
- two devices on different plugin versions during rollout
- standard Sync account with files near limit
- guides workspace appears after install/update and resolves from the configured root
- model can load `guides/index.md` without seeing `data/**`
- user edits a managed guide file and update behavior is correct

## Rollout Strategy

## Release 1

- add vault-root storage support
- add managed guides installation
- migrate and verify
- keep all legacy roots as fallback reads
- write only to `<root>/data`

## Release 2

- keep fallback reads
- add maintenance UI for re-run migration and inspect current configured root

## Release 3

- remove legacy write assumptions entirely
- consider pruning legacy fallback reads only after confidence is high

## Recommendation

Implement this as a focused storage migration, not an incremental tweak to the plugin-data model.

The safe target architecture is:

- a configurable vault-relative root folder
- fixed `guides/` and `data/` subfolders inside that root
- sharded JSONL event storage only under `data/`
- a built-in docs workspace backed only by `guides/`
- local-only SQLite cache
- resumable migration from all legacy roots

That is the smallest design that matches the sync constraints we now know are real.

## Implementation Phases

This section is the execution order I would actually use in code.

The sequence is designed to keep the app bootable at every step and avoid a flag day where all storage readers and writers change at once.

### Phase 0: Introduce root settings and root resolver

Purpose:

- create the new settings surface
- define the configured root plus fixed `guides/` and `data/` subpaths
- avoid changing write behavior yet

Files:

- `src/types/plugin/PluginTypes.ts`
- `src/types.ts`
- `src/settings.ts`
- new or updated resolver: `src/database/storage/VaultRootResolver.ts`
- settings UI tab file(s)

Changes:

- add `storage.rootPath`
- add `storage.maxShardBytes`
- default to `Nexus`
- validate vault-relative, non-plugin, non-hidden-by-default paths
- add a root resolver that returns:
  - `rootPath`
  - `guidesRoot`
  - `guidesMetaRoot`
  - `dataRoot`
  - `dataMetaRoot`
  - `conversationsRoot`
  - `workspacesRoot`
  - `tasksRoot`

Code sketch:

```ts
export interface RootStorageSettings {
  rootPath: string;
  maxShardBytes: number;
}

export function getDefaultStorageSettings(): RootStorageSettings {
  return {
    rootPath: 'Nexus',
    maxShardBytes: 4 * 1024 * 1024
  };
}

export function resolveVaultRoot(rootPath: string) {
  const normalizedRoot = normalizePath(rootPath);
  return {
    rootPath: normalizedRoot,
    guidesRoot: normalizePath(`${normalizedRoot}/guides`),
    guidesMetaRoot: normalizePath(`${normalizedRoot}/guides/_meta`),
    dataRoot: normalizePath(`${normalizedRoot}/data`),
    dataMetaRoot: normalizePath(`${normalizedRoot}/data/_meta`),
    conversationsRoot: normalizePath(`${normalizedRoot}/data/conversations`),
    workspacesRoot: normalizePath(`${normalizedRoot}/data/workspaces`),
    tasksRoot: normalizePath(`${normalizedRoot}/data/tasks`)
  };
}
```

Exit criteria:

- user can set the configured root path in settings
- resolver works without touching any existing storage behavior

### Phase 1: Add sharded event store primitives

Purpose:

- introduce the file shape we actually want
- do this without changing migration yet

Files:

- new: `src/database/storage/ShardedEventStore.ts`
- `src/database/storage/JSONLWriter.ts` or a new abstraction above it

Changes:

- implement shard path naming
- implement append with rotation
- implement ordered shard reads
- implement stream inventory helpers

Stream naming:

- `<root>/data/conversations/<conversation-id>/shard-000001.jsonl`
- `<root>/data/workspaces/<workspace-id>/shard-000001.jsonl`
- `<root>/data/tasks/<workspace-id>/shard-000001.jsonl`

Code sketch:

```ts
export interface StreamRef {
  category: 'conversations' | 'workspaces' | 'tasks';
  streamId: string;
}

export class ShardedEventStore {
  constructor(
    private readonly app: App,
    private readonly rootPath: string,
    private readonly maxShardBytes: number
  ) {}

  async appendEvent(stream: StreamRef, line: string): Promise<string> {
    const shardPaths = await this.listShardPaths(stream);
    const activeShard = await this.getOrCreateWritableShard(stream, shardPaths, line);
    await this.app.vault.adapter.append(activeShard, line);
    return activeShard;
  }

  async readAllEvents(stream: StreamRef): Promise<string[]> {
    const shards = await this.listShardPaths(stream);
    const lines: string[] = [];
    for (const shard of shards) {
      const content = await this.app.vault.adapter.read(shard);
      lines.push(...content.split('\n').filter(Boolean));
    }
    return lines;
  }
}
```

Exit criteria:

- append rotates below `4 MB`
- reads across shards preserve stream order
- conversation IDs are normalized once

### Phase 2: Write new data to vault-root data storage

Purpose:

- move new writes away from plugin data immediately
- keep legacy reads in place

Files:

- `src/database/adapters/HybridStorageAdapter.ts`
- `src/database/storage/JSONLWriter.ts`
- `src/database/storage/ShardedEventStore.ts`

Changes:

- swap the write target from plugin data / `.nexus` to the sharded store under `<root>/data`
- keep read roots:
  - configured `<root>/data`
  - prior configured root if migration in progress
  - plugin-data legacy roots
  - `.nexus`

Important:

- local `cache.db` path does not change
- this phase must not require migration completion before new writes can succeed

Code sketch:

```ts
const resolvedRoot = resolveVaultRoot(settings.storage.rootPath);
const shardedStore = new ShardedEventStore(app, resolvedRoot.dataRoot, settings.storage.maxShardBytes);

await shardedStore.appendEvent(
  { category: 'conversations', streamId: conversationId },
  JSON.stringify(event) + '\n'
);
```

Exit criteria:

- new desktop conversations write into `<root>/data/conversations/.../shard-*.jsonl`
- plugin-data conversations are read-only fallback

### Phase 3: Materialize managed guides and the built-in docs workspace

Purpose:

- create the system-managed guides area
- expose the docs workspace without mixing it into normal workspace persistence

Files:

- new: `src/guides/GuidesManifestService.ts`
- new: `src/guides/GuidesInstallerService.ts`
- new: `src/guides/SystemGuidesWorkspaceProvider.ts`
- workspace listing/loading services
- prompt composition code

Changes:

- install bundled guides into `<root>/guides`
- ensure `guides/index.md` and `guides/_meta/guides-manifest.json` exist
- register a reserved system workspace backed only by `guides/**/*.md`
- keep it out of normal workspace CRUD
- update prompt guidance so the model starts with `guides/index.md`

Code sketch:

```ts
const resolvedRoot = resolveVaultRoot(settings.storage.rootPath);

await guidesInstaller.ensureManagedGuides({
  guidesRoot: resolvedRoot.guidesRoot,
  guidesMetaRoot: resolvedRoot.guidesMetaRoot
});

const guidesWorkspace = {
  id: 'system-guides',
  name: 'System guides',
  rootPath: resolvedRoot.guidesRoot,
  navigatorPath: normalizePath(`${resolvedRoot.guidesRoot}/index.md`),
  systemManaged: true,
  hiddenFromCrud: true
};
```

Exit criteria:

- `<root>/guides/index.md` exists
- managed guides can refresh safely
- the model can access guides without seeing `<root>/data/**`

### Phase 4: Migrate legacy data into vault-root shards

Purpose:

- bring old data forward
- make migration resumable and verifiable

Files:

- replace or supersede `src/database/migration/PluginScopedStorageCoordinator.ts`
- new: `src/database/migration/VaultRootStorageCoordinator.ts`
- new: `src/database/migration/ShardMigrationService.ts`

Changes:

- read from:
  - `.nexus`
  - `.obsidian/plugins/claudesidian-mcp/data`
  - `.obsidian/plugins/nexus/data`
- split oversized single-file logs into shards under `<root>/data`
- persist migration manifest and verification report in `<root>/data/_meta/`

Code sketch:

```ts
for (const legacyFile of legacyConversationFiles) {
  const streamId = normalizeConversationIdFromLegacyPath(legacyFile);
  const events = await legacyReader.readEvents(legacyFile);
  for (const event of events) {
    await vaultDataStore.appendEvent(
      { category: 'conversations', streamId },
      JSON.stringify(event) + '\n'
    );
  }
}
```

Verification sketch:

```ts
interface VerificationSummary {
  streamId: string;
  sourceEventCount: number;
  destinationEventCount: number;
  firstEventId?: string;
  lastEventId?: string;
}
```

Exit criteria:

- migration is resumable
- verification proves no event loss
- cutover state is persisted in `data.json`

### Phase 5: Rebuild cache from vault-root data only

Purpose:

- make `<root>/data` the only storage source that matters for cache rebuild

Files:

- `src/database/sync/SyncCoordinator.ts`
- `src/database/adapters/HybridStorageAdapter.ts`
- `src/database/storage/SQLiteCacheManager.ts`

Changes:

- sync reads `<root>/data` shards first
- fallback legacy reads remain only for migration compatibility
- `cache.db` rebuild no longer depends on plugin-data JSONL

Code sketch:

```ts
const conversationStreams = await vaultDataStore.listStreams('conversations');
for (const streamId of conversationStreams) {
  const events = await vaultDataStore.readTypedEvents<ConversationEvent>({
    category: 'conversations',
    streamId
  });
  for (const event of events) {
    if (await sqliteCache.isEventApplied(event.id)) continue;
    await conversationApplier.apply(event);
    await sqliteCache.markEventApplied(event.id);
  }
}
```

Exit criteria:

- deleting `cache.db` and restarting rebuilds from `<root>/data`
- mobile and desktop both repopulate cache from the same configured root

### Phase 6: Add user-driven root move workflow

Purpose:

- allow `Nexus/` to become `storage/nexus/` or another user-selected path safely

Files:

- settings UI
- `VaultRootStorageCoordinator`
- possibly a new maintenance command

Changes:

- when `storage.rootPath` changes:
  - validate destination
  - copy the current root to destination
  - verify both `guides/` and `data/`
  - update settings
  - retain old root as fallback until next successful boot

Code sketch:

```ts
async function moveConfiguredRoot(oldPath: string, newPath: string): Promise<void> {
  await copyTree(oldPath, newPath);
  await verifyRootMove(oldPath, newPath);
  settings.storage.rootPath = newPath;
  await settings.saveSettings();
}
```

Exit criteria:

- user can change the folder in settings
- move survives restart
- old root is not deleted until the new root is confirmed healthy

### Phase 7: Cleanup and remove legacy write assumptions

Purpose:

- reduce ambiguity after rollout

Changes:

- stop writing to `.nexus`
- stop writing to plugin-data JSONL
- keep fallback reads for one or two releases only

Exit criteria:

- all new event writes use `<root>/data` shards only

## Detailed Code Examples

## Example: conversation shard path resolution

```ts
function getConversationShardPath(rootPath: string, conversationId: string, shardNumber: number): string {
  const shardName = `shard-${String(shardNumber).padStart(6, '0')}.jsonl`;
  return normalizePath(`${rootPath}/conversations/${conversationId}/${shardName}`);
}
```

## Example: shard rotation

```ts
async function getWritableShard(
  app: App,
  rootPath: string,
  stream: StreamRef,
  nextLineBytes: number,
  maxShardBytes: number
): Promise<string> {
  const existing = await listShardPaths(app, rootPath, stream);
  const current = existing.at(-1) ?? getShardPath(rootPath, stream, 1);
  const stat = await app.vault.adapter.stat(current);
  const currentSize = stat?.size ?? 0;

  if (currentSize + nextLineBytes <= maxShardBytes) {
    return current;
  }

  return getShardPath(rootPath, stream, existing.length + 1);
}
```

## Example: settings validation

```ts
export function validateRootPath(path: string): { valid: boolean; error?: string } {
  const normalized = normalizePath(path.trim());
  if (!normalized) return { valid: false, error: 'Path cannot be empty.' };
  if (normalized.startsWith('.obsidian/')) {
    return { valid: false, error: 'The configured root cannot live under .obsidian.' };
  }
  if (normalized.includes('..')) {
    return { valid: false, error: 'Path traversal is not allowed.' };
  }
  return { valid: true };
}
```

## Example: migration state expansion

```ts
export interface RootStorageState {
  storageVersion: 2;
  rootPath: string;
  previousRootPath?: string;
  guidesPath: string;
  dataPath: string;
  sourceOfTruthLocation: 'vault-root-data' | 'legacy-dotnexus' | 'legacy-plugin-data';
  migration: {
    state: 'not_started' | 'copying' | 'copied' | 'verified' | 'failed';
    startedAt?: number;
    completedAt?: number;
    verifiedAt?: number;
    lastError?: string;
    legacySourcesDetected: string[];
  };
}
```

## Subagent Audit Loop

The user explicitly asked for how the `subagent-audit-loop` skill would be used. This is the orchestration model I would use once implementation starts.

I would not let subagents overlap on write scope. Each track gets one owner and one audit loop.

### Track breakdown

Track 1: storage core

- owner: implementation worker
- scope:
  - `src/database/storage/VaultRootResolver.ts`
  - `src/database/storage/ShardedEventStore.ts`
  - `src/database/storage/JSONLWriter.ts`

Track 2: migration and cutover

- owner: implementation worker
- scope:
  - `src/database/migration/VaultRootStorageCoordinator.ts`
  - `src/database/migration/ShardMigrationService.ts`
  - `src/database/migration/PluginScopedStorageCoordinator.ts`

Track 3: cache rebuild and runtime sync

- owner: implementation worker
- scope:
  - `src/database/adapters/HybridStorageAdapter.ts`
  - `src/database/sync/SyncCoordinator.ts`
  - `src/database/storage/SQLiteCacheManager.ts`

Track 4: settings and UI

- owner: implementation worker
- scope:
  - `src/settings.ts`
  - `src/types/plugin/PluginTypes.ts`
  - settings UI files

Track 5: audit/review

- owner: explorer or reviewer agent
- scope:
  - no edits
  - reviews each completed track for correctness, edge cases, and migration safety

### Loop cadence

This is the exact pattern I would follow:

1. Spawn one worker per disjoint write scope.
2. `update_plan` with each track and owner.
3. `wait_agent` for the first completed track.
4. Audit the diff locally against the plan and current code.
5. If needed, send a revision back to the same agent with `send_input(interrupt=true)`.
6. `wait_agent` again for the revised result.
7. Approve the track only when tests and edge cases are acceptable.
8. Move to the next track.

### Example audit request

```text
Audit finding: shard rotation is correct, but the worker allowed writes into .obsidian/plugin data during post-cutover operation.
Revise only:
- src/database/storage/ShardedEventStore.ts
- src/database/adapters/HybridStorageAdapter.ts
Do not touch migration or settings files.
Done means:
- event writes go only to configured `<root>/data`
- plugin data remains local cache only
- tests cover the no-plugin-write assertion
```

### Example track order

Recommended execution order:

1. Track 1: storage core
2. Track 3: cache rebuild/runtime sync
3. Track 2: migration/cutover
4. Track 4: settings/UI
5. Track 5: final audit pass across all changed files

Reason:

- the sharded store contract has to exist before migration or sync can safely target it
- runtime sync should be updated before cutover so migrated data has a stable consumer
- settings/UI should land after the backend contract exists

### Acceptance gates per track

Track 1 accepted only if:

- shard rotation is tested
- file naming is normalized
- read order across shards is deterministic

Track 2 accepted only if:

- migration is resumable
- verification compares counts and boundary event IDs
- failed migration leaves old reads intact

Track 3 accepted only if:

- cache rebuild uses `<root>/data`
- mobile startup can rebuild from `<root>/data`
- plugin-data JSONL is no longer required for healthy runtime

Track 4 accepted only if:

- root path validation blocks bad paths
- path change uses copy-verify-switch
- UI messaging is explicit about old-root cleanup

## Immediate Next Step

When implementation starts, Phase 0 and Phase 1 should be done first in one branch because they define the contract the later phases rely on.

I would not start migration code before the root resolver and sharded event store APIs are stable.
