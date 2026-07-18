/**
 * Integration tests for `ReconcilePipeline` covering Phase 1 of
 * docs/plans/sync-safe-storage-reconcile-plan.md.
 *
 * Surface under test:
 *   - tests/integration/reconcilePipelineSilentOverwrite.test.ts (this file)
 *
 * P1.7.a — silent-overwrite GREEN-BAR (architect §6, user's reported incident)
 * P1.7.d — performance gate: warm reconcile of 10K-event shard < 100ms
 * P1.7.e — multi-device merge sim with deterministic ordering
 * P1.7.f — watcher external-mutation → reconcileStream flow
 *
 * Phase 2 cleanup target (auditor YELLOW #3): `ReconcilePipeline.readShardEvents`
 * uses an `as unknown` cast to reach `vault.adapter`. The fake-store fixture
 * here intentionally satisfies that cast so the test exercises the real apply
 * path. Document removal of the cast when the shard-read API is hoisted into
 * `ShardedJsonlStreamStore` directly.
 */

import {
  ReconcilePipeline,
  parseShardVaultPath,
  type ParsedShardPath
} from '../../src/database/sync/ReconcilePipeline';
import type { ShardCursor } from '../../src/database/storage/SQLiteSyncStateStore';

// ---------------------------------------------------------------------------
// Test fixture: FakeVaultEventStore + FakeSyncStateStore + FakeAppliers
//
// These satisfy the slice of `VaultEventStore` / `SQLiteSyncStateStore` /
// `*EventApplier` that `ReconcilePipeline` consumes. Pure in-memory — no
// filesystem, no Obsidian, no SQLite.
// ---------------------------------------------------------------------------

const ROOT_PATH = 'Nexus/data';

interface AppliedEvent {
  id: string;
  category: string;
  timestamp: number;
  deviceId?: string;
}

class FakeAppliedEventsStore {
  private readonly applied = new Map<string, AppliedEvent>();

  isApplied(eventId: string): boolean {
    return this.applied.has(eventId);
  }

  mark(event: AppliedEvent): void {
    this.applied.set(event.id, event);
  }

  count(): number {
    return this.applied.size;
  }

  has(id: string): boolean {
    return this.applied.has(id);
  }

  getAll(): AppliedEvent[] {
    return Array.from(this.applied.values());
  }
}

class FakeSyncStateStore {
  private readonly cursors = new Map<string, ShardCursor>();
  upsertCalls = 0;

  private key(deviceId: string, shardPath: string): string {
    return `${deviceId}::${shardPath}`;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getCursor(deviceId: string, shardPath: string): Promise<ShardCursor | null> {
    return this.cursors.get(this.key(deviceId, shardPath)) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async upsertCursor(cursor: ShardCursor): Promise<void> {
    this.upsertCalls += 1;
    this.cursors.set(this.key(cursor.deviceId, cursor.shardPath), { ...cursor });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listCursors(): Promise<ShardCursor[]> {
    return Array.from(this.cursors.values());
  }
}

class FakeApplier {
  readonly applied: { id: string; payload: unknown }[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async apply(event: { id: string }): Promise<void> {
    this.applied.push({ id: event.id, payload: event });
  }
}

interface FakeShardDescriptor {
  fileName: string;
  fullPath: string;
  index: number;
  relativePath: string;
  size: number;
  modTime: number | null;
}

interface FakeStreamHandle {
  category: 'conversations' | 'workspaces' | 'tasks';
  logicalId: string;
  relativeStreamPath: string;
  absoluteStreamPath: string;
  shardStore: {
    listShards(relativeStreamPath: string): Promise<FakeShardDescriptor[]>;
    app: { vault: { adapter: { read(path: string): Promise<string>; exists(path: string): Promise<boolean> } } };
  };
}

/**
 * In-memory event store. `setShardContent(category, streamId, fileName, events)`
 * writes a shard atomically; `replaceShardContent(...)` simulates GDrive
 * dropping a new file on top of the existing one (silent-overwrite).
 */
class FakeVaultEventStore {
  /** Map<category/streamId, Map<fileName, jsonlContent>>. */
  private readonly shards = new Map<string, Map<string, string>>();
  private readonly disappearAfterList = new Set<string>();

  getRootPath(): string {
    return ROOT_PATH;
  }

  setShardContent(
    category: string,
    streamId: string,
    fileName: string,
    events: { id: string; timestamp: number; deviceId?: string }[]
  ): void {
    const key = `${category}/${streamId}`;
    if (!this.shards.has(key)) {
      this.shards.set(key, new Map());
    }
    const lines = events.map((e) => JSON.stringify(e)).join('\n');
    this.shards.get(key)!.set(fileName, lines);
  }

  /** Simulates GDrive last-writer-wins overwrite of an existing shard file. */
  replaceShardContent(
    category: string,
    streamId: string,
    fileName: string,
    events: { id: string; timestamp: number; deviceId?: string }[]
  ): void {
    this.setShardContent(category, streamId, fileName, events);
  }

  removeShardAfterNextList(category: string, streamId: string, fileName: string): void {
    this.disappearAfterList.add(`${category}/${streamId}/${fileName}`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listFiles(category: string): Promise<string[]> {
    const out: string[] = [];
    for (const key of this.shards.keys()) {
      if (key.startsWith(`${category}/`)) {
        const streamId = key.slice(category.length + 1);
        out.push(`${category}/${streamId}.jsonl`);
      }
    }
    return out.sort();
  }

  getConversationStream(streamId: string): FakeStreamHandle {
    return this.makeHandle('conversations', streamId);
  }

  getWorkspaceStream(streamId: string): FakeStreamHandle {
    return this.makeHandle('workspaces', streamId);
  }

  getTaskStream(streamId: string): FakeStreamHandle {
    return this.makeHandle('tasks', streamId);
  }

  private makeHandle(category: 'conversations' | 'workspaces' | 'tasks', streamId: string): FakeStreamHandle {
    const relative = `${category}/${streamId}`;
    const absolute = `${ROOT_PATH}/${relative}`;
    const key = relative;

    const adapter = {
      // eslint-disable-next-line @typescript-eslint/require-await
      exists: async (path: string): Promise<boolean> => {
        const fileName = path.split('/').pop()!;
        return this.shards.get(key)?.has(fileName) ?? false;
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      read: async (path: string): Promise<string> => {
        const fileName = path.split('/').pop()!;
        const content = this.shards.get(key)?.get(fileName);
        if (content === undefined) {
          throw new Error(`Fake adapter: shard not found: ${path}`);
        }
        return content;
      }
    };

    const shardStore = {
      // eslint-disable-next-line @typescript-eslint/require-await
      listShards: async (_relativeStreamPath: string): Promise<FakeShardDescriptor[]> => {
        const files = this.shards.get(key);
        if (!files) return [];
        const descriptors: FakeShardDescriptor[] = [];
        for (const fileName of files.keys()) {
          // baseIndex isn't material for these tests; assign 1 for canonical,
          // bump for siblings so the sort order is deterministic.
          const index = fileName === 'shard-000001.jsonl' ? 1 : descriptors.length + 1;
          descriptors.push({
            fileName,
            fullPath: `${absolute}/${fileName}`,
            index,
            relativePath: `${relative}/${fileName}`,
            size: files.get(fileName)!.length,
            modTime: 0
          });
        }
        for (const descriptor of descriptors) {
          const disappearanceKey = `${key}/${descriptor.fileName}`;
          if (this.disappearAfterList.delete(disappearanceKey)) {
            files.delete(descriptor.fileName);
          }
        }
        return descriptors.sort((a, b) => a.index - b.index);
      },
      app: { vault: { adapter } }
    };

    return {
      category,
      logicalId: streamId,
      relativeStreamPath: relative,
      absoluteStreamPath: absolute,
      shardStore
    };
  }
}

class FakeSqliteCache {
  private readonly failMarkOnceFor = new Set<string>();

  constructor(private readonly applied: FakeAppliedEventsStore) {}

  failNextMark(eventId: string): void {
    this.failMarkOnceFor.add(eventId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async isEventApplied(eventId: string): Promise<boolean> {
    return this.applied.isApplied(eventId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markEventApplied(eventId: string): Promise<void> {
    if (this.failMarkOnceFor.delete(eventId)) {
      throw new Error(`Fake sqlite cache: mark failed for ${eventId}`);
    }
    this.applied.mark({ id: eventId, category: '<unknown>', timestamp: 0 });
  }
}

interface PipelineHarness {
  pipeline: ReconcilePipeline;
  store: FakeVaultEventStore;
  cursors: FakeSyncStateStore;
  applied: FakeAppliedEventsStore;
  sqliteCache: FakeSqliteCache;
  appliers: { workspace: FakeApplier; conversation: FakeApplier; task: FakeApplier };
}

function makeHarness(deviceId = 'desktop-A'): PipelineHarness {
  const store = new FakeVaultEventStore();
  const cursors = new FakeSyncStateStore();
  const applied = new FakeAppliedEventsStore();
  const sqliteCache = new FakeSqliteCache(applied);
  const appliers = {
    workspace: new FakeApplier(),
    conversation: new FakeApplier(),
    task: new FakeApplier()
  };

  const pipeline = new ReconcilePipeline({
    // The pipeline only uses the slice we satisfy here.
    vaultEventStore: store as unknown as ConstructorParameters<typeof ReconcilePipeline>[0]['vaultEventStore'],
    syncStateStore: cursors as unknown as ConstructorParameters<typeof ReconcilePipeline>[0]['syncStateStore'],
    sqliteCache: sqliteCache as unknown as ConstructorParameters<typeof ReconcilePipeline>[0]['sqliteCache'],
    workspaceApplier: appliers.workspace as unknown as ConstructorParameters<typeof ReconcilePipeline>[0]['workspaceApplier'],
    conversationApplier: appliers.conversation as unknown as ConstructorParameters<typeof ReconcilePipeline>[0]['conversationApplier'],
    taskApplier: appliers.task as unknown as ConstructorParameters<typeof ReconcilePipeline>[0]['taskApplier'],
    deviceId
  });

  return { pipeline, store, cursors, applied, sqliteCache, appliers };
}

const SHARD = 'shard-000001.jsonl';
const STREAM = 'conv_abc';
const SHARD_VAULT_PATH = `${ROOT_PATH}/conversations/${STREAM}/${SHARD}`;
const DELTA_SHARD =
  'shard-000003 (Syncthing Delta sha256-' + 'b'.repeat(64) + ').jsonl';
const DELTA_SHARD_VAULT_PATH = `${ROOT_PATH}/conversations/${STREAM}/${DELTA_SHARD}`;

// ---------------------------------------------------------------------------
// P1.7.a — Silent-overwrite GREEN-BAR (architect §6)
// ---------------------------------------------------------------------------

describe('P1.7.a — silent-overwrite (architect §6, user incident scenario)', () => {
  it('detects cursor staleness, rescans from offset 0, dedupes via applied_events PK, preserves prior applies, applies new events', async () => {
    const { pipeline, store, cursors, applied } = makeHarness('desktop-A');

    // Phase 1 — device A writes e1, e2, e3 to canonical shard.
    store.setShardContent('conversations', STREAM, SHARD, [
      { id: 'e1', timestamp: 1, deviceId: 'A' },
      { id: 'e2', timestamp: 2, deviceId: 'A' },
      { id: 'e3', timestamp: 3, deviceId: 'A' }
    ]);

    const first = await pipeline.reconcileShard(SHARD_VAULT_PATH);
    expect(first.success).toBe(true);
    expect(first.eventsApplied).toBe(3);
    expect(first.silentOverwriteRescans).toBe(0);
    expect(applied.has('e1')).toBe(true);
    expect(applied.has('e2')).toBe(true);
    expect(applied.has('e3')).toBe(true);

    const cursorAfterPhase1 = await cursors.getCursor('desktop-A', SHARD_VAULT_PATH);
    expect(cursorAfterPhase1?.lastEventId).toBe('e3');

    // Phase 2 — GDrive replaces device A's file with device B's content
    // (e2 is the intentional overlap that exercises applied_events PK dedup;
    // e4 is new). Device A's e1 + e3 are no longer in the file.
    store.replaceShardContent('conversations', STREAM, SHARD, [
      { id: 'e2', timestamp: 2, deviceId: 'B' },
      { id: 'e4', timestamp: 4, deviceId: 'B' }
    ]);

    const second = await pipeline.reconcileShard(SHARD_VAULT_PATH);

    // ────────────────────────────────────────────────────────────────────
    // Architect §6 expected post-reconcile state — every assertion must pass.
    // ────────────────────────────────────────────────────────────────────
    // (1) ReconcileResult flags silent-overwrite.
    expect(second.silentOverwriteRescans).toBeGreaterThanOrEqual(1);
    // (2) Pipeline rescans from offset 0 — both events read.
    expect(second.shardsScanned).toBeGreaterThanOrEqual(1);
    // (3) applied_events PK catches e2 as duplicate — idempotent no-op.
    expect(second.eventsSkipped).toBe(1);
    // (4) Already-applied e1, e3 do NOT regress (durable once applied).
    expect(applied.has('e1')).toBe(true);
    expect(applied.has('e3')).toBe(true);
    // (5) e4 (new) is applied.
    expect(applied.has('e4')).toBe(true);
    expect(second.eventsApplied).toBe(1);
    // (6) Cursor advanced to new tail.
    const cursorAfterPhase2 = await cursors.getCursor('desktop-A', SHARD_VAULT_PATH);
    expect(cursorAfterPhase2?.lastEventId).toBe('e4');
  });

  it('anti-regression: no event id is double-applied across replays', async () => {
    const { pipeline, store, applied } = makeHarness('desktop-A');

    store.setShardContent('conversations', STREAM, SHARD, [
      { id: 'e1', timestamp: 1, deviceId: 'A' },
      { id: 'e2', timestamp: 2, deviceId: 'A' }
    ]);

    await pipeline.reconcileShard(SHARD_VAULT_PATH);
    const countAfterFirst = applied.count();

    // Same file content — replays must be a no-op.
    await pipeline.reconcileShard(SHARD_VAULT_PATH);
    await pipeline.reconcileShard(SHARD_VAULT_PATH);

    expect(applied.count()).toBe(countAfterFirst);
    expect(applied.has('e1')).toBe(true);
    expect(applied.has('e2')).toBe(true);
  });

  it('anti-regression: applied event count never decreases on file truncation', async () => {
    const { pipeline, store, applied } = makeHarness('desktop-A');

    store.setShardContent('conversations', STREAM, SHARD, [
      { id: 'e1', timestamp: 1, deviceId: 'A' },
      { id: 'e2', timestamp: 2, deviceId: 'A' },
      { id: 'e3', timestamp: 3, deviceId: 'A' }
    ]);
    await pipeline.reconcileShard(SHARD_VAULT_PATH);
    const before = applied.count();

    // Truncate to a single event with a different id.
    store.replaceShardContent('conversations', STREAM, SHARD, [
      { id: 'e9', timestamp: 9, deviceId: 'A' }
    ]);
    await pipeline.reconcileShard(SHARD_VAULT_PATH);

    expect(applied.count()).toBeGreaterThanOrEqual(before);
    // e1, e2, e3 stay; e9 added.
    expect(applied.has('e1')).toBe(true);
    expect(applied.has('e2')).toBe(true);
    expect(applied.has('e3')).toBe(true);
    expect(applied.has('e9')).toBe(true);
  });

  it('cursor fast-path: re-reconcile with no file change triggers fast-path, not rescan', async () => {
    const { pipeline, store } = makeHarness('desktop-A');

    store.setShardContent('conversations', STREAM, SHARD, [
      { id: 'e1', timestamp: 1, deviceId: 'A' },
      { id: 'e2', timestamp: 2, deviceId: 'A' }
    ]);

    await pipeline.reconcileShard(SHARD_VAULT_PATH);
    const second = await pipeline.reconcileShard(SHARD_VAULT_PATH);

    expect(second.shardsFastPathed).toBe(1);
    expect(second.shardsScanned).toBe(0);
    expect(second.eventsApplied).toBe(0);
    expect(second.silentOverwriteRescans).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P1.7.e — Multi-device merge sim (deterministic ordering)
// ---------------------------------------------------------------------------

describe('P1.7.e — multi-device merge sim (deterministic ordering)', () => {
  it('orders events by (timestamp ASC, deviceId ASC, eventId ASC) when devices interleave', async () => {
    const { pipeline, store, appliers } = makeHarness('desktop-A');

    // Mixed events from device A and B, intentionally out of timestamp order
    // in the file. Pipeline must sort before apply.
    store.setShardContent('conversations', STREAM, SHARD, [
      { id: 'e3', timestamp: 30, deviceId: 'B' },
      { id: 'e1', timestamp: 10, deviceId: 'A' },
      { id: 'e2', timestamp: 20, deviceId: 'B' },
      { id: 'e0', timestamp: 10, deviceId: 'B' }, // tie on timestamp; B > A
      { id: 'e4', timestamp: 30, deviceId: 'A' }  // tie on timestamp; A < B
    ]);

    await pipeline.reconcileShard(SHARD_VAULT_PATH);

    const applyOrder = appliers.conversation.applied.map((a) => a.id);
    // Expected order:
    //   t=10, A, e1   (deviceA first because A < B at same timestamp)
    //   t=10, B, e0
    //   t=20, B, e2
    //   t=30, A, e4   (deviceA first because A < B at same timestamp)
    //   t=30, B, e3
    expect(applyOrder).toEqual(['e1', 'e0', 'e2', 'e4', 'e3']);
  });

  it('preserves both devices events when reconciling a merged 2-device fixture', async () => {
    const { pipeline, store, applied } = makeHarness('desktop-A');

    store.setShardContent('conversations', STREAM, SHARD, [
      { id: 'a-1', timestamp: 1, deviceId: 'A' },
      { id: 'a-2', timestamp: 3, deviceId: 'A' },
      { id: 'b-1', timestamp: 2, deviceId: 'B' },
      { id: 'b-2', timestamp: 4, deviceId: 'B' }
    ]);
    // Second shard from same device combo
    store.setShardContent('conversations', STREAM, 'shard-000002.jsonl', [
      { id: 'a-3', timestamp: 5, deviceId: 'A' },
      { id: 'b-3', timestamp: 6, deviceId: 'B' }
    ]);

    const result = await pipeline.reconcileStream('conversations', STREAM);

    expect(result.success).toBe(true);
    expect(result.eventsApplied).toBe(6);
    for (const id of ['a-1', 'a-2', 'a-3', 'b-1', 'b-2', 'b-3']) {
      expect(applied.has(id)).toBe(true);
    }
  });

  it('eventId tiebreak when timestamp + deviceId are equal', async () => {
    const { pipeline, store, appliers } = makeHarness('desktop-A');

    // Identical timestamp + deviceId; eventId is the only differentiator.
    store.setShardContent('conversations', STREAM, SHARD, [
      { id: 'evt-zzz', timestamp: 100, deviceId: 'A' },
      { id: 'evt-aaa', timestamp: 100, deviceId: 'A' }
    ]);

    await pipeline.reconcileShard(SHARD_VAULT_PATH);

    const order = appliers.conversation.applied.map((a) => a.id);
    expect(order).toEqual(['evt-aaa', 'evt-zzz']);
  });
});

// ---------------------------------------------------------------------------
// P1.7.f — Watcher external-mutation → reconcileStream flow
// ---------------------------------------------------------------------------
//
// Per auditor YELLOW #1: HybridStorageAdapter.handleExternalJsonlChange calls
// `syncCoordinator.reconcileStream(category, streamId)` per modified entry,
// NOT `reconcileShard(shardPath)`. Tests assert on the reconcileStream surface,
// which is what production actually uses.
// ---------------------------------------------------------------------------

describe('P1.7.f — watcher external-mutation → reconcileStream flow', () => {
  it('reconcileStream is per-stream-scoped (does not sweep other streams)', async () => {
    const { pipeline, store, appliers } = makeHarness('desktop-A');

    store.setShardContent('conversations', 'conv_target', SHARD, [
      { id: 'tgt-1', timestamp: 1, deviceId: 'A' }
    ]);
    store.setShardContent('conversations', 'conv_other', SHARD, [
      { id: 'oth-1', timestamp: 2, deviceId: 'A' }
    ]);

    const result = await pipeline.reconcileStream('conversations', 'conv_target');

    expect(result.success).toBe(true);
    expect(result.eventsApplied).toBe(1);
    const ids = appliers.conversation.applied.map((a) => a.id);
    expect(ids).toEqual(['tgt-1']);
    expect(ids).not.toContain('oth-1');
  });

  it('reconcileStream covers all shards within the stream including conflict siblings', async () => {
    const { pipeline, store, applied } = makeHarness('desktop-A');

    store.setShardContent('conversations', STREAM, 'shard-000001.jsonl', [
      { id: 'canon-1', timestamp: 1, deviceId: 'A' }
    ]);
    store.setShardContent('conversations', STREAM, 'shard-000001 (1).jsonl', [
      { id: 'conflict-1', timestamp: 2, deviceId: 'B' }
    ]);
    store.setShardContent('conversations', STREAM, 'shard-000001 [Conflict].jsonl', [
      { id: 'conflict-2', timestamp: 3, deviceId: 'B' }
    ]);

    const result = await pipeline.reconcileStream('conversations', STREAM);

    expect(result.success).toBe(true);
    expect(result.eventsApplied).toBe(3);
    expect(applied.has('canon-1')).toBe(true);
    expect(applied.has('conflict-1')).toBe(true);
    expect(applied.has('conflict-2')).toBe(true);
  });

  it('reconcileShard for unparsable path returns error, no events applied', async () => {
    const { pipeline, applied } = makeHarness('desktop-A');

    const result = await pipeline.reconcileShard('NotNexus/data/foo/bar.jsonl');

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('Cannot parse shard path');
    expect(result.filesProcessed).toEqual([]);
    expect(applied.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Nominal shard coverage receipt
// ---------------------------------------------------------------------------

describe('ReconcilePipeline nominal shard coverage receipt', () => {
  it('reports a scanned delta path once and applies its exclusive event', async () => {
    const { pipeline, store, applied } = makeHarness('desktop-A');
    store.setShardContent('conversations', STREAM, DELTA_SHARD, [
      { id: 'delta-exclusive', timestamp: 1, deviceId: 'B' }
    ]);

    const result = await pipeline.reconcileShard(DELTA_SHARD_VAULT_PATH);

    expect(result.success).toBe(true);
    expect(result.shardsScanned).toBe(1);
    expect(result.filesProcessed).toEqual([DELTA_SHARD_VAULT_PATH]);
    expect(result.eventsApplied).toBe(1);
    expect(applied.has('delta-exclusive')).toBe(true);
  });

  it('reports a cursor-fast-pathed delta without applying its event twice', async () => {
    const { pipeline, store, applied } = makeHarness('desktop-A');
    store.setShardContent('conversations', STREAM, DELTA_SHARD, [
      { id: 'delta-exclusive', timestamp: 1, deviceId: 'B' }
    ]);
    await pipeline.reconcileShard(DELTA_SHARD_VAULT_PATH);
    const appliedAfterFirst = applied.count();

    const second = await pipeline.reconcileShard(DELTA_SHARD_VAULT_PATH);

    expect(second.success).toBe(true);
    expect(second.shardsFastPathed).toBe(1);
    expect(second.eventsApplied).toBe(0);
    expect(second.filesProcessed).toEqual([DELTA_SHARD_VAULT_PATH]);
    expect(applied.count()).toBe(appliedAfterFirst);
  });

  it('aggregates stream coverage in first-seen order without duplicate paths', async () => {
    const { pipeline, store } = makeHarness('desktop-A');
    store.setShardContent('conversations', 'conv_alpha', DELTA_SHARD, [
      { id: 'alpha-exclusive', timestamp: 1, deviceId: 'A' }
    ]);
    store.setShardContent('conversations', 'conv_beta', SHARD, [
      { id: 'beta-exclusive', timestamp: 2, deviceId: 'B' }
    ]);
    jest.spyOn(store, 'listFiles').mockImplementation(async (category) =>
      category === 'conversations'
        ? [
            'conversations/conv_alpha.jsonl',
            'conversations/conv_alpha.jsonl',
            'conversations/conv_beta.jsonl'
          ]
        : []
    );

    const result = await pipeline.reconcileAll();

    expect(result.success).toBe(true);
    expect(result.filesProcessed).toEqual([
      `${ROOT_PATH}/conversations/conv_alpha/${DELTA_SHARD}`,
      `${ROOT_PATH}/conversations/conv_beta/${SHARD}`
    ]);
  });

  it('does not claim coverage for a missing parseable shard', async () => {
    const { pipeline } = makeHarness('desktop-A');

    const result = await pipeline.reconcileShard(DELTA_SHARD_VAULT_PATH);

    expect(result.success).toBe(false);
    expect(result.filesProcessed).toEqual([]);
  });

  it('fails closed when a listed shard disappears before adapter read', async () => {
    const { pipeline, store, cursors } = makeHarness('desktop-A');
    store.setShardContent('conversations', STREAM, DELTA_SHARD, [
      { id: 'delta-vanished', timestamp: 1, deviceId: 'B' }
    ]);
    store.removeShardAfterNextList('conversations', STREAM, DELTA_SHARD);

    const result = await pipeline.reconcileShard(DELTA_SHARD_VAULT_PATH);

    expect(result.success).toBe(false);
    expect(result.filesProcessed).toEqual([]);
    expect(cursors.upsertCalls).toBe(0);
  });
});

describe('ReconcilePipeline incomplete shard application', () => {
  it('retries a failed apply without advancing the cursor or duplicating applied event ids', async () => {
    const { pipeline, store, cursors, applied, appliers } = makeHarness('desktop-A');
    store.setShardContent('conversations', STREAM, SHARD, [
      { id: 'e1', timestamp: 1, deviceId: 'A' },
      { id: 'e2', timestamp: 2, deviceId: 'A' },
      { id: 'e3', timestamp: 3, deviceId: 'A' }
    ]);
    const originalApply = appliers.conversation.apply.bind(appliers.conversation);
    let failE2Once = true;
    jest.spyOn(appliers.conversation, 'apply').mockImplementation(async (event) => {
      if (event.id === 'e2' && failE2Once) {
        failE2Once = false;
        throw new Error('Fake applier: apply failed for e2');
      }
      await originalApply(event);
    });

    const failed = await pipeline.reconcileShard(SHARD_VAULT_PATH);

    expect(failed.success).toBe(false);
    expect(failed.filesProcessed).toEqual([SHARD_VAULT_PATH]);
    expect(await cursors.getCursor('desktop-A', SHARD_VAULT_PATH)).toBeNull();
    expect(cursors.upsertCalls).toBe(0);
    expect(applied.has('e1')).toBe(true);
    expect(applied.has('e2')).toBe(false);
    expect(applied.has('e3')).toBe(true);

    const retried = await pipeline.reconcileShard(SHARD_VAULT_PATH);

    expect(retried.success).toBe(true);
    expect(retried.eventsApplied).toBe(1);
    expect(retried.eventsSkipped).toBe(2);
    expect((await cursors.getCursor('desktop-A', SHARD_VAULT_PATH))?.lastEventId).toBe('e3');
    expect(cursors.upsertCalls).toBe(1);
    const appliedIds = appliers.conversation.applied.map((event) => event.id);
    expect(appliedIds.filter((id) => id === 'e1')).toHaveLength(1);
    expect(appliedIds.filter((id) => id === 'e2')).toHaveLength(1);
    expect(appliedIds.filter((id) => id === 'e3')).toHaveLength(1);

    const fastPathed = await pipeline.reconcileShard(SHARD_VAULT_PATH);
    expect(fastPathed.shardsFastPathed).toBe(1);
  });

  it('does not advance the cursor when applied_events marking fails', async () => {
    const { pipeline, store, cursors, sqliteCache } = makeHarness('desktop-A');
    store.setShardContent('conversations', STREAM, SHARD, [
      { id: 'e1', timestamp: 1, deviceId: 'A' },
      { id: 'e2', timestamp: 2, deviceId: 'A' }
    ]);
    sqliteCache.failNextMark('e2');

    const failed = await pipeline.reconcileShard(SHARD_VAULT_PATH);

    expect(failed.success).toBe(false);
    expect(failed.filesProcessed).toEqual([SHARD_VAULT_PATH]);
    expect(await cursors.getCursor('desktop-A', SHARD_VAULT_PATH)).toBeNull();
    expect(cursors.upsertCalls).toBe(0);

    const retried = await pipeline.reconcileShard(SHARD_VAULT_PATH);
    expect(retried.success).toBe(true);
    expect((await cursors.getCursor('desktop-A', SHARD_VAULT_PATH))?.lastEventId).toBe('e2');

    const fastPathed = await pipeline.reconcileShard(SHARD_VAULT_PATH);
    expect(fastPathed.shardsFastPathed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P1.7.d — Performance gate (10K-event shard < 100ms warm reconcile)
//
// Auditor YELLOW #2 callout: cursor fast-path is `lastEventId`-tail-match only
// in Phase 1 (lastOffset=0 unconditional). Warm reconcile must still hit
// <100ms via the parse-tail-then-compare path.
// ---------------------------------------------------------------------------

describe('P1.7.d — performance gate', () => {
  it('warm reconcileShard on 10K-event shard completes in < 100ms (gate)', async () => {
    const { pipeline, store } = makeHarness('desktop-A');

    const events = Array.from({ length: 10_000 }, (_, i) => ({
      id: `evt-${i.toString().padStart(6, '0')}`,
      timestamp: i,
      deviceId: 'A'
    }));
    store.setShardContent('conversations', STREAM, SHARD, events);

    // Cold pass — populates cursor.
    await pipeline.reconcileShard(SHARD_VAULT_PATH);

    // Warm pass — cursor matches tail; should fast-path.
    const start = Date.now();
    const warm = await pipeline.reconcileShard(SHARD_VAULT_PATH);
    const elapsed = Date.now() - start;

    expect(warm.shardsFastPathed).toBe(1);
    expect(warm.shardsScanned).toBe(0);
    expect(elapsed).toBeLessThan(100);
  });

  it('cold reconcileAll trend at 100/1k/10k event scales (report only)', async () => {
    const trend: { scale: number; ms: number }[] = [];

    for (const scale of [100, 1_000, 10_000]) {
      const { pipeline, store } = makeHarness('desktop-A');
      const events = Array.from({ length: scale }, (_, i) => ({
        id: `evt-${scale}-${i}`,
        timestamp: i,
        deviceId: 'A'
      }));
      store.setShardContent('conversations', STREAM, SHARD, events);

      const start = Date.now();
      await pipeline.reconcileAll();
      trend.push({ scale, ms: Date.now() - start });
    }

    // Trend reporting only — no gate. CI machine variance is high.
    // eslint-disable-next-line no-console
    console.log('[reconcile cold trend]', JSON.stringify(trend));
    expect(trend).toHaveLength(3);
  });

  it('warm reconcile is genuinely O(parse-tail-then-compare), not O(N applies)', async () => {
    const { pipeline, store, appliers } = makeHarness('desktop-A');

    const events = Array.from({ length: 1_000 }, (_, i) => ({
      id: `evt-${i}`,
      timestamp: i,
      deviceId: 'A'
    }));
    store.setShardContent('conversations', STREAM, SHARD, events);

    // Cold pass populates cursor + applies events.
    await pipeline.reconcileShard(SHARD_VAULT_PATH);
    const appliedAfterCold = appliers.conversation.applied.length;
    expect(appliedAfterCold).toBe(1_000);

    // Warm pass MUST NOT re-call the applier (proves O(N applies) is avoided).
    appliers.conversation.applied.length = 0;
    const warm = await pipeline.reconcileShard(SHARD_VAULT_PATH);

    expect(warm.shardsFastPathed).toBe(1);
    expect(appliers.conversation.applied.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseShardVaultPath — covers the public helper directly.
// ---------------------------------------------------------------------------

describe('parseShardVaultPath', () => {
  it('parses canonical conversation shard path', () => {
    const parsed = parseShardVaultPath(
      'Nexus/data/conversations/conv_abc/shard-000001.jsonl',
      'Nexus/data'
    );
    expect(parsed).toEqual<ParsedShardPath>({
      category: 'conversations',
      streamId: 'conv_abc',
      businessId: 'abc',
      shardFileName: 'shard-000001.jsonl'
    });
  });

  it('parses conflict-suffixed shard path', () => {
    const parsed = parseShardVaultPath(
      'Nexus/data/tasks/tasks_xyz/shard-000001 [Conflict].jsonl',
      'Nexus/data'
    );
    expect(parsed?.shardFileName).toBe('shard-000001 [Conflict].jsonl');
    expect(parsed?.category).toBe('tasks');
    expect(parsed?.businessId).toBe('xyz');
  });

  it('rejects paths outside the data root', () => {
    expect(parseShardVaultPath('Other/data/conversations/conv_a/shard-000001.jsonl', 'Nexus/data')).toBeNull();
  });

  it('rejects paths with wrong segment count', () => {
    expect(parseShardVaultPath('Nexus/data/conv_a/shard-000001.jsonl', 'Nexus/data')).toBeNull();
    expect(parseShardVaultPath('Nexus/data/conversations/conv_a/sub/shard-000001.jsonl', 'Nexus/data')).toBeNull();
  });

  it('rejects unknown category', () => {
    expect(parseShardVaultPath('Nexus/data/unknown/conv_a/shard-000001.jsonl', 'Nexus/data')).toBeNull();
  });

  it('rejects non-jsonl extension', () => {
    expect(parseShardVaultPath('Nexus/data/conversations/conv_a/shard-000001.txt', 'Nexus/data')).toBeNull();
  });

  it('handles trailing slash on data root', () => {
    const parsed = parseShardVaultPath(
      'Nexus/data/conversations/conv_a/shard-000001.jsonl',
      'Nexus/data/'
    );
    expect(parsed?.streamId).toBe('conv_a');
  });
});
