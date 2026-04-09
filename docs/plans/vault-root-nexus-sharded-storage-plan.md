# Vault-Root Nexus Storage Plan

## Goal

Move canonical synced Nexus storage out of plugin data and into a normal vault folder so cross-device chat state works with Obsidian Sync constraints.

The new design should:

- use a vault-root `Nexus/` folder by default
- allow the user to choose a different vault-relative folder such as `storage/nexus`
- shard append-only JSONL files before they exceed the Obsidian Sync per-file limit
- keep `cache.db` as a local-only rebuildable cache
- migrate existing data from legacy locations without losing conversations, workspaces, or tasks

## Why This Change

The current model is blocked by two constraints we have now confirmed:

- Obsidian Sync does not reliably sync arbitrary plugin data files under `.obsidian/plugins/<plugin>/data/`
- Obsidian Sync enforces per-file size limits, so a single ever-growing conversation JSONL is not a safe canonical format

The existing plugin architecture is still directionally correct:

- append-only event files are the right source of truth
- SQLite is the right local query model

The problem is only the location and file-shape of the canonical store.

## Product Direction

### Canonical synced store

Canonical event data moves to a normal vault folder:

- default path: `Nexus/`
- configurable path: any vault-relative non-plugin path such as `storage/nexus`

This folder becomes the only canonical write target for new synced conversation, workspace, and task events.

### Local cache

SQLite remains local-only:

- path: `.obsidian/plugins/<active-plugin-folder>/data/cache.db`
- rebuilt from the canonical vault-root event store
- never treated as a cross-device source of truth

### User-configurable root

The plugin exposes a storage setting for the Nexus root folder.

- default: `Nexus`
- stored in plugin `data.json`
- changing it triggers a managed migration from the previous canonical root to the new one

## Non-Goals

- Do not sync `cache.db`
- Do not make `data.json` the full conversation payload store
- Do not keep plugin data as the long-term canonical write target
- Do not rely on hidden root dotfolders for sync-critical content

## Storage Layout

## Default root

`Nexus/`

## Proposed structure

```text
Nexus/
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
- `_meta/` holds small control files only

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

New canonical destination:

- `settings.storage.rootPath ?? "Nexus"`

### Migration phases

#### Phase 1: Introduce vault-root canonical path

- add a new storage root resolver for the canonical vault folder
- keep plugin data resolver only for local cache paths
- update storage state to record:
  - canonical root path
  - migration state
  - legacy sources detected
  - last successful migration timestamp

#### Phase 2: Copy and split legacy event files

For each legacy JSONL file:

- identify the logical stream
- read all events
- write them into the new canonical stream directory
- split into shards under `4 MB`
- preserve event IDs and timestamps exactly

#### Phase 3: Verify before cutover

Verification should compare:

- logical stream presence
- event counts
- first/last event IDs or hashes
- total bytes written

Do not cut over until verification succeeds.

#### Phase 4: Switch writes to canonical vault root

After verification:

- write only to the configured canonical root
- read from canonical root first
- keep legacy roots as fallback read sources for one release cycle

#### Phase 5: Rebuild local cache from canonical root

On the next boot after cutover:

- open or create local `cache.db`
- rebuild or incrementally sync from canonical shards

## User-Driven Root Folder Changes

When the user changes the Nexus root path in settings:

1. Validate the new path.
2. Acquire a storage migration lock.
3. Flush pending writes.
4. Copy current canonical root contents to the new root.
5. Verify copied data.
6. Update the stored canonical root setting.
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

Canonical writes go to the configured vault-root path only.

Local cache writes go to plugin data only.

## Reads

Read priority:

1. configured canonical vault-root path
2. prior configured canonical root, if a move is in progress
3. plugin data legacy roots
4. `.nexus`

This fallback order is temporary and should be removable after one or two successful migration versions.

## Cache Rebuild Rules

`cache.db` is rebuilt from the canonical root only.

The cache should not depend on plugin data JSONL anymore once migration is complete.

## Sync Model

The canonical synced store is sharded JSONL in a normal vault folder.

That means:

- desktop writes event shards
- Obsidian Sync transfers those shards
- mobile replays them into local `cache.db`
- mobile reads from `cache.db`

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
- prefer canonical root for all new writes immediately after a device migrates
- on later boots, merge any straggler legacy events into canonical shards

## Root path changes syncing across devices

Because the configured root path lives in `data.json`, another device may receive the setting before it has copied data locally.

Mitigation:

- store migration state alongside the configured root
- if a device sees a new configured root but local migration is incomplete, it should:
  - read configured canonical root first
  - read previous canonical root as fallback
  - rebuild cache from whichever streams are actually present

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

## Empty canonical folder with valid local cache

If the canonical root is empty but `cache.db` contains data, do not silently trust the DB as canonical.

Behavior:

- surface a warning
- keep UI usable from cache
- mark the store as degraded until a repair or migration reconciliation runs

## Large vaults

Inventory and rebuild logic should stream by shard and avoid loading giant logical streams into memory when possible.

## Conversation ID filename compatibility

Current legacy logs show filenames like `conv_conv_<id>.jsonl`.

Migration should normalize logical IDs once and only once:

- canonical directory name should be the true conversation ID
- fallback readers must still understand old prefixed filenames

## Files and Systems to Update

## Storage and migration core

- `src/database/adapters/HybridStorageAdapter.ts`
- `src/database/storage/JSONLWriter.ts`
- `src/database/sync/SyncCoordinator.ts`
- `src/database/migration/PluginScopedStorageCoordinator.ts`
- `src/database/storage/PluginStoragePathResolver.ts`

## New components likely needed

- `src/database/storage/CanonicalStoragePathResolver.ts`
- `src/database/storage/ShardedEventStore.ts`
- `src/database/migration/VaultRootStorageCoordinator.ts`
- `src/database/migration/ShardMigrationService.ts`

## Local cache and startup

- `src/database/storage/SQLiteCacheManager.ts`
- `src/main.ts`
- `src/core/services/ServiceRegistrar.ts`

## Settings and UI

- `src/types/plugin/PluginTypes.ts`
- `src/types.ts`
- `src/settings.ts`
- settings UI tab(s) where storage configuration belongs

## Read-model consumers

- `src/services/ConversationService.ts`
- any repositories or query services that assume flat single-file JSONL naming

## Data model changes

### `PluginScopedStorageState`

This likely needs to evolve into a broader storage state model, for example:

- storage version
- canonical root path
- previous canonical root path
- migration status
- legacy sources detected
- verification metadata

The current `sourceOfTruthLocation: 'legacy-dotnexus' | 'plugin-data'` is too narrow for the new world and should become something like:

- `'legacy-dotnexus'`
- `'legacy-plugin-data'`
- `'vault-root-canonical'`

## Testing Plan

## Unit tests

- shard rotation at threshold boundary
- reading ordered events across multiple shards
- migration from single-file JSONL to shards
- migration from `.nexus`, `claudesidian-mcp/data`, and `nexus/data`
- root path validation
- root path move copy-verify-switch flow
- fallback read order when configured root is empty or partially migrated
- canonical ID normalization for `conv_conv_*` legacy files

## Integration/manual tests

- desktop creates conversation, mobile receives it
- mobile creates conversation, desktop receives it
- conversation grows past 4 MB and rotates shards safely
- user changes root path from `Nexus` to `storage/nexus`
- app restarts mid-migration and resumes safely
- two devices on different plugin versions during rollout
- standard Sync account with files near limit

## Rollout Strategy

## Release 1

- add canonical vault-root storage support
- migrate and verify
- keep all legacy roots as fallback reads
- write only to canonical vault-root

## Release 2

- keep fallback reads
- add maintenance UI for re-run migration and inspect current canonical root

## Release 3

- remove legacy write assumptions entirely
- consider pruning legacy fallback reads only after confidence is high

## Recommendation

Implement this as a focused storage migration, not an incremental tweak to the plugin-data model.

The safe target architecture is:

- canonical sharded JSONL in a normal vault folder
- configurable vault-relative Nexus root
- local-only SQLite cache
- resumable migration from all legacy roots

That is the smallest design that matches the sync constraints we now know are real.

## Implementation Phases

This section is the execution order I would actually use in code.

The sequence is designed to keep the app bootable at every step and avoid a flag day where all storage readers and writers change at once.

### Phase 0: Introduce storage settings and canonical root resolver

Purpose:

- create the new settings surface
- define the canonical vault-root location
- avoid changing write behavior yet

Files:

- `src/types/plugin/PluginTypes.ts`
- `src/types.ts`
- `src/settings.ts`
- new resolver: `src/database/storage/CanonicalStoragePathResolver.ts`
- settings UI tab file(s)

Changes:

- add `storage.rootPath`
- add `storage.maxShardBytes`
- default to `Nexus`
- validate vault-relative, non-plugin, non-hidden-by-default paths
- add a canonical resolver that returns:
  - `rootPath`
  - `metaPath`
  - `conversationsRoot`
  - `workspacesRoot`
  - `tasksRoot`

Code sketch:

```ts
export interface NexusStorageSettings {
  rootPath: string;
  maxShardBytes: number;
}

export function getDefaultStorageSettings(): NexusStorageSettings {
  return {
    rootPath: 'Nexus',
    maxShardBytes: 4 * 1024 * 1024
  };
}

export function resolveCanonicalStorageRoot(app: App, rootPath: string) {
  const normalizedRoot = normalizePath(rootPath);
  return {
    rootPath: normalizedRoot,
    metaRoot: normalizePath(`${normalizedRoot}/_meta`),
    conversationsRoot: normalizePath(`${normalizedRoot}/conversations`),
    workspacesRoot: normalizePath(`${normalizedRoot}/workspaces`),
    tasksRoot: normalizePath(`${normalizedRoot}/tasks`)
  };
}
```

Exit criteria:

- user can set a Nexus folder path in settings
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

Canonical naming:

- `Nexus/conversations/<conversation-id>/shard-000001.jsonl`
- `Nexus/workspaces/<workspace-id>/shard-000001.jsonl`
- `Nexus/tasks/<workspace-id>/shard-000001.jsonl`

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

### Phase 2: Write new data to canonical vault-root storage

Purpose:

- move new writes away from plugin data immediately
- keep legacy reads in place

Files:

- `src/database/adapters/HybridStorageAdapter.ts`
- `src/database/storage/JSONLWriter.ts`
- `src/database/storage/ShardedEventStore.ts`

Changes:

- swap canonical write target from plugin data / `.nexus` to vault-root sharded store
- keep read roots:
  - configured canonical root
  - prior configured root if migration in progress
  - plugin-data legacy roots
  - `.nexus`

Important:

- local `cache.db` path does not change
- this phase must not require migration completion before new writes can succeed

Code sketch:

```ts
const canonicalRoots = resolveCanonicalStorageRoot(app, settings.storage.rootPath);
const shardedStore = new ShardedEventStore(app, canonicalRoots.rootPath, settings.storage.maxShardBytes);

await shardedStore.appendEvent(
  { category: 'conversations', streamId: conversationId },
  JSON.stringify(event) + '\n'
);
```

Exit criteria:

- new desktop conversations write into `Nexus/conversations/.../shard-*.jsonl`
- plugin-data conversations are read-only fallback

### Phase 3: Migrate legacy data into canonical shards

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
- split oversized single-file logs into canonical shards
- persist migration manifest and verification report in `Nexus/_meta/`

Code sketch:

```ts
for (const legacyFile of legacyConversationFiles) {
  const streamId = normalizeConversationIdFromLegacyPath(legacyFile);
  const events = await legacyReader.readEvents(legacyFile);
  for (const event of events) {
    await canonicalStore.appendEvent(
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

### Phase 4: Rebuild cache from canonical root only

Purpose:

- make the canonical store the only storage source that matters for cache rebuild

Files:

- `src/database/sync/SyncCoordinator.ts`
- `src/database/adapters/HybridStorageAdapter.ts`
- `src/database/storage/SQLiteCacheManager.ts`

Changes:

- sync reads canonical shards first
- fallback legacy reads remain only for migration compatibility
- `cache.db` rebuild no longer depends on plugin-data JSONL

Code sketch:

```ts
const conversationStreams = await canonicalStore.listStreams('conversations');
for (const streamId of conversationStreams) {
  const events = await canonicalStore.readTypedEvents<ConversationEvent>({
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

- deleting `cache.db` and restarting rebuilds from `Nexus/`
- mobile and desktop both repopulate cache from the same canonical root

### Phase 5: Add user-driven folder move workflow

Purpose:

- allow `Nexus/` to become `storage/nexus/` or another user-selected path safely

Files:

- settings UI
- `VaultRootStorageCoordinator`
- possibly a new maintenance command

Changes:

- when `storage.rootPath` changes:
  - validate destination
  - copy current canonical root to destination
  - verify
  - update settings
  - retain old root as fallback until next successful boot

Code sketch:

```ts
async function moveCanonicalRoot(oldPath: string, newPath: string): Promise<void> {
  await copyTree(oldPath, newPath);
  await verifyCanonicalRoots(oldPath, newPath);
  settings.storage.rootPath = newPath;
  await settings.saveSettings();
}
```

Exit criteria:

- user can change the folder in settings
- move survives restart
- old root is not deleted until the new root is confirmed healthy

### Phase 6: Cleanup and remove legacy write assumptions

Purpose:

- reduce ambiguity after rollout

Changes:

- stop writing to `.nexus`
- stop writing to plugin-data JSONL
- keep fallback reads for one or two releases only

Exit criteria:

- all new writes use canonical vault-root shards only

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
export function validateCanonicalRootPath(path: string): { valid: boolean; error?: string } {
  const normalized = normalizePath(path.trim());
  if (!normalized) return { valid: false, error: 'Path cannot be empty.' };
  if (normalized.startsWith('.obsidian/')) {
    return { valid: false, error: 'Canonical Nexus storage cannot live under .obsidian.' };
  }
  if (normalized.includes('..')) {
    return { valid: false, error: 'Path traversal is not allowed.' };
  }
  return { valid: true };
}
```

## Example: migration state expansion

```ts
export interface CanonicalStorageState {
  storageVersion: 2;
  canonicalRootPath: string;
  previousCanonicalRootPath?: string;
  sourceOfTruthLocation: 'vault-root-canonical' | 'legacy-dotnexus' | 'legacy-plugin-data';
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
  - `src/database/storage/CanonicalStoragePathResolver.ts`
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
- canonical writes go only to configured vault-root storage
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

- cache rebuild uses canonical root
- mobile startup can rebuild from canonical root
- plugin-data JSONL is no longer required for healthy runtime

Track 4 accepted only if:

- root path validation blocks bad paths
- path change uses copy-verify-switch
- UI messaging is explicit about old-root cleanup

## Immediate Next Step

When implementation starts, Phase 0 and Phase 1 should be done first in one branch because they define the contract the later phases rely on.

I would not start migration code before the canonical resolver and sharded event store APIs are stable.
