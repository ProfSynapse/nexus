/**
 * Phase 0 characterization tests for the HybridStorageAdapter split
 * (docs/plans/hybrid-storage-adapter-split-plan.md).
 *
 * These tests pin the CURRENT behavior of surfaces that Phases 1–2 will move:
 *   - rebuildCache idempotency/coalescing (`rebuildInFlight`)
 *   - onExternalSync/offExternalSync event flow
 *   - relocateVaultRoot happy + failure paths
 *   - close() teardown ordering
 *   - per-entity delegation smoke (public surface → repository args)
 *
 * They intentionally characterize, not improve: where current behavior is
 * imperfect it is pinned as-is and flagged with
 * `// pins current behavior; see report`.
 */

jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

jest.mock('../../src/database/migration/VaultRootRelocationService', () => {
  const relocateVaultRoot = jest.fn();
  const VaultRootRelocationService = jest.fn().mockImplementation(() => ({
    relocateVaultRoot
  }));
  return { VaultRootRelocationService, __relocateVaultRootMock: relocateVaultRoot };
});

import { Events, EventRef, App, Plugin } from 'obsidian';
import {
  HybridStorageAdapter,
  ExternalSyncEvent
} from '../../src/database/adapters/HybridStorageAdapter';
import { InitLifecycleController } from '../../src/database/adapters/lifecycle/InitLifecycleController';
import { ReconcilePipeline } from '../../src/database/sync/ReconcilePipeline';
import type { ModifiedStream } from '../../src/database/sync/JsonlVaultWatcher';
import type {
  SessionMetadata,
  WorkspaceMetadata,
  ConversationMetadata,
  MemoryTraceData,
  SyncResult
} from '../../src/types/storage/HybridStorageTypes';
import { DEFAULT_STORAGE_SETTINGS } from '../../src/types/plugin/PluginTypes';

const relocationModule = jest.requireMock('../../src/database/migration/VaultRootRelocationService') as {
  VaultRootRelocationService: jest.Mock;
  __relocateVaultRootMock: jest.Mock;
};

/** InitLifecycleController that has already completed a successful no-op init. */
async function createReadyLifecycle(): Promise<InitLifecycleController> {
  const lifecycle = new InitLifecycleController();
  await lifecycle.run(async () => undefined, { blocking: true });
  return lifecycle;
}

const successfulSyncResult: SyncResult = {
  success: true,
  eventsApplied: 0,
  eventsSkipped: 0,
  errors: [],
  duration: 0,
  filesProcessed: [],
  lastSyncTimestamp: 1
};

describe('HybridStorageAdapter (Phase 0 characterization)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // 1. rebuildCache — idempotency / coalescing
  // ==========================================================================

  describe('rebuildCache', () => {
    type RebuildHarness = HybridStorageAdapter & {
      initLifecycle: InitLifecycleController;
      sqliteCache: {
        stopAutoSave: jest.Mock;
        close: jest.Mock;
        initialize: jest.Mock;
      };
      cacheBlobStore: { remove: jest.Mock };
      syncCoordinator: { fullRebuild: jest.Mock };
    };

    async function makeHarness(initialized = true): Promise<RebuildHarness> {
      const adapter = Object.create(HybridStorageAdapter.prototype) as RebuildHarness;
      adapter.initLifecycle = initialized
        ? await createReadyLifecycle()
        : new InitLifecycleController();
      adapter.sqliteCache = {
        stopAutoSave: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
        initialize: jest.fn().mockResolvedValue(undefined)
      };
      adapter.cacheBlobStore = { remove: jest.fn().mockResolvedValue(undefined) };
      adapter.syncCoordinator = {
        fullRebuild: jest.fn().mockResolvedValue(successfulSyncResult)
      };
      return adapter;
    }

    it('coalesces concurrent invocations into a single rebuild', async () => {
      const adapter = await makeHarness();
      let resolveRebuild!: (result: SyncResult) => void;
      adapter.syncCoordinator.fullRebuild.mockReturnValue(
        new Promise<SyncResult>((resolve) => {
          resolveRebuild = resolve;
        })
      );

      const first = adapter.rebuildCache();
      const second = adapter.rebuildCache();

      resolveRebuild(successfulSyncResult);
      await Promise.all([first, second]);

      expect(adapter.sqliteCache.stopAutoSave).toHaveBeenCalledTimes(1);
      expect(adapter.sqliteCache.close).toHaveBeenCalledTimes(1);
      expect(adapter.cacheBlobStore.remove).toHaveBeenCalledTimes(1);
      expect(adapter.sqliteCache.initialize).toHaveBeenCalledTimes(1);
      expect(adapter.syncCoordinator.fullRebuild).toHaveBeenCalledTimes(1);

      // After settling, the in-flight slot is cleared: a third call re-runs.
      await adapter.rebuildCache();
      expect(adapter.syncCoordinator.fullRebuild).toHaveBeenCalledTimes(2);
    });

    it('reports progress phases through onProgress and forwards it to fullRebuild', async () => {
      const adapter = await makeHarness();
      adapter.syncCoordinator.fullRebuild.mockImplementation(
        ({ onProgress }: { onProgress?: (label: string, done: number, total: number) => void }) => {
          onProgress?.('Processing workspaces', 1, 2);
          return Promise.resolve(successfulSyncResult);
        }
      );

      const labels: string[] = [];
      await adapter.rebuildCache({ onProgress: (label) => labels.push(label) });

      expect(labels).toEqual([
        'Stopping auto-save',
        'Closing cache',
        'Removing cache blob',
        'Reopening cache',
        'Rebuilding from JSONL',
        'Processing workspaces',
        'Complete'
      ]);
    });

    it('rejects when the adapter is not initialized', async () => {
      const adapter = await makeHarness(false);

      await expect(adapter.rebuildCache()).rejects.toThrow(
        'Storage adapter is not initialized; cannot rebuild cache'
      );
      expect(adapter.sqliteCache.stopAutoSave).not.toHaveBeenCalled();
      expect(adapter.sqliteCache.close).not.toHaveBeenCalled();
    });

    it('propagates a failed rebuild to all concurrent callers and clears the in-flight slot', async () => {
      const adapter = await makeHarness();
      let resolveRebuild!: (result: SyncResult) => void;
      adapter.syncCoordinator.fullRebuild.mockReturnValueOnce(
        new Promise<SyncResult>((resolve) => {
          resolveRebuild = resolve;
        })
      );

      const first = adapter.rebuildCache();
      const second = adapter.rebuildCache();
      const firstRejection = expect(first).rejects.toThrow('Cache rebuild failed: disk vanished');
      const secondRejection = expect(second).rejects.toThrow('Cache rebuild failed: disk vanished');

      resolveRebuild({ ...successfulSyncResult, success: false, errors: ['disk vanished'] });
      await firstRejection;
      await secondRejection;

      // The failure cleared rebuildInFlight, so a retry runs a fresh rebuild.
      adapter.syncCoordinator.fullRebuild.mockResolvedValue(successfulSyncResult);
      await adapter.rebuildCache();
      expect(adapter.syncCoordinator.fullRebuild).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // 2. External sync event flow — onExternalSync / offExternalSync
  // ==========================================================================

  describe('external sync events', () => {
    type ExternalSyncHarness = HybridStorageAdapter & {
      externalEvents: Events;
      syncCoordinator: { reconcileStream: jest.Mock };
      reconcilePipeline: unknown;
      queryCache: { clear: jest.Mock };
      reconcileMissingWorkspaces: jest.Mock;
      reconcileMissingConversations: jest.Mock;
      reconcileMissingTasks: jest.Mock;
    };

    function makeHarness(): ExternalSyncHarness {
      const adapter = Object.create(HybridStorageAdapter.prototype) as ExternalSyncHarness;
      adapter.externalEvents = new Events();
      adapter.reconcilePipeline = {};
      adapter.syncCoordinator = {
        reconcileStream: jest.fn().mockResolvedValue(undefined)
      };
      adapter.queryCache = { clear: jest.fn() };
      // Instance properties shadow the private prototype methods so the
      // post-sync reconcilers are observable without a full repo stack.
      adapter.reconcileMissingWorkspaces = jest.fn().mockResolvedValue(0);
      adapter.reconcileMissingConversations = jest.fn().mockResolvedValue(0);
      adapter.reconcileMissingTasks = jest.fn().mockResolvedValue(0);
      return adapter;
    }

    function fireChange(adapter: ExternalSyncHarness, modified: ModifiedStream[]): Promise<void> {
      return (adapter as unknown as {
        handleExternalJsonlChange(modified: ModifiedStream[]): Promise<void>;
      }).handleExternalJsonlChange(modified);
    }

    const modifiedStreams: ModifiedStream[] = [
      {
        category: 'conversations',
        streamId: 'conv_abc',
        businessId: 'abc',
        samplePath: 'conversations/conv_abc/shard-000001.jsonl'
      },
      {
        category: 'workspaces',
        streamId: 'ws_xyz',
        businessId: 'xyz',
        samplePath: 'workspaces/ws_xyz/shard-000001.jsonl'
      }
    ];

    it('reconciles each modified stream and delivers external-sync to a subscriber', async () => {
      const adapter = makeHarness();
      const received: ExternalSyncEvent[] = [];
      adapter.onExternalSync((event) => received.push(event));

      await fireChange(adapter, modifiedStreams);

      expect(adapter.syncCoordinator.reconcileStream).toHaveBeenCalledTimes(2);
      expect(adapter.syncCoordinator.reconcileStream).toHaveBeenNthCalledWith(1, 'conversations', 'conv_abc');
      expect(adapter.syncCoordinator.reconcileStream).toHaveBeenNthCalledWith(2, 'workspaces', 'ws_xyz');
      expect(adapter.reconcileMissingWorkspaces).toHaveBeenCalledTimes(1);
      expect(adapter.reconcileMissingConversations).toHaveBeenCalledTimes(1);
      expect(adapter.reconcileMissingTasks).toHaveBeenCalledTimes(1);
      expect(adapter.queryCache.clear).toHaveBeenCalledTimes(1);

      expect(received).toHaveLength(1);
      expect(received[0].modified).toBe(modifiedStreams);
      expect(received[0].result.success).toBe(true);
      expect(received[0].result.filesProcessed).toEqual([
        'conversations/conv_abc/shard-000001.jsonl',
        'workspaces/ws_xyz/shard-000001.jsonl'
      ]);
    });

    it('offExternalSync removes only the unsubscribed listener', async () => {
      const adapter = makeHarness();
      const firstListener = jest.fn();
      const secondListener = jest.fn();
      const firstRef: EventRef = adapter.onExternalSync(firstListener);
      adapter.onExternalSync(secondListener);

      await fireChange(adapter, modifiedStreams);
      expect(firstListener).toHaveBeenCalledTimes(1);
      expect(secondListener).toHaveBeenCalledTimes(1);

      adapter.offExternalSync(firstRef);

      await fireChange(adapter, modifiedStreams);
      expect(firstListener).toHaveBeenCalledTimes(1);
      expect(secondListener).toHaveBeenCalledTimes(2);
    });

    it('multiple subscribers each receive the same event payload', async () => {
      const adapter = makeHarness();
      const payloads: ExternalSyncEvent[] = [];
      adapter.onExternalSync((event) => payloads.push(event));
      adapter.onExternalSync((event) => payloads.push(event));
      adapter.onExternalSync((event) => payloads.push(event));

      await fireChange(adapter, [modifiedStreams[0]]);

      expect(payloads).toHaveLength(3);
      expect(payloads[1]).toBe(payloads[0]);
      expect(payloads[2]).toBe(payloads[0]);
    });

    it('does nothing for an empty modified list', async () => {
      const adapter = makeHarness();
      const listener = jest.fn();
      adapter.onExternalSync(listener);

      await fireChange(adapter, []);

      expect(adapter.syncCoordinator.reconcileStream).not.toHaveBeenCalled();
      expect(adapter.queryCache.clear).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 3. relocateVaultRoot
  // ==========================================================================

  describe('relocateVaultRoot', () => {
    type RelocateHarness = HybridStorageAdapter & {
      app: unknown;
      basePath: string;
      vaultEventStore: unknown;
      jsonlWriter: {
        setBasePath: jest.Mock;
        setVaultEventStore: jest.Mock;
        setVaultEventStoreReadEnabled: jest.Mock;
        getDeviceId: jest.Mock;
      };
      jsonlVaultWatcher?: { setDataPath: jest.Mock };
      syncCoordinator: {
        getAppliers: jest.Mock;
        setReconcilePipeline: jest.Mock;
      };
      sqliteCache: { getSyncStateStore: jest.Mock };
      queryCache: { clear: jest.Mock };
      reconcilePipeline: unknown;
    };

    const baseRelocationResult = {
      success: true,
      verified: true,
      relation: 'identical' as const,
      durationMs: 5,
      sourceRootPath: 'Nexus',
      destinationRootPath: 'Archive/Nexus',
      sourceStreamCount: 2,
      destinationStreamCountBefore: 0,
      destinationStreamCountAfter: 2,
      copiedEventCount: 10,
      skippedEventCount: 0,
      fileResults: [],
      conflicts: [],
      errors: []
    };

    function makeHarness(): RelocateHarness {
      const adapter = Object.create(HybridStorageAdapter.prototype) as RelocateHarness;
      adapter.app = { vault: { configDir: '.obsidian', adapter: {} } };
      adapter.basePath = 'Nexus/data';
      adapter.vaultEventStore = { marker: 'source-store' };
      adapter.jsonlWriter = {
        setBasePath: jest.fn(),
        setVaultEventStore: jest.fn(),
        setVaultEventStoreReadEnabled: jest.fn(),
        getDeviceId: jest.fn().mockReturnValue('device-1')
      };
      adapter.jsonlVaultWatcher = { setDataPath: jest.fn() };
      adapter.syncCoordinator = {
        getAppliers: jest.fn().mockReturnValue({
          workspace: {},
          conversation: {},
          task: {}
        }),
        setReconcilePipeline: jest.fn()
      };
      adapter.sqliteCache = { getSyncStateStore: jest.fn().mockReturnValue({}) };
      adapter.queryCache = { clear: jest.fn() };
      adapter.reconcilePipeline = null;
      return adapter;
    }

    it('returns switched:false with an error when the vault event store is not initialized', async () => {
      const adapter = makeHarness();
      adapter.vaultEventStore = null;

      const result = await adapter.relocateVaultRoot('Archive/Nexus');

      expect(result.switched).toBe(false);
      expect(result.success).toBe(false);
      expect(result.errors).toEqual(['Vault event store is not initialized.']);
      expect(result.destinationRootPath).toBe('Archive/Nexus');
      expect(relocationModule.VaultRootRelocationService).not.toHaveBeenCalled();
      expect(adapter.jsonlWriter.setBasePath).not.toHaveBeenCalled();
    });

    it('returns switched:false and leaves wiring untouched when relocation fails verification', async () => {
      const adapter = makeHarness();
      relocationModule.__relocateVaultRootMock.mockResolvedValue({
        ...baseRelocationResult,
        success: false,
        errors: ['copy mismatch'],
        destinationStore: { marker: 'dest-store' }
      });

      const result = await adapter.relocateVaultRoot('Archive/Nexus');

      expect(result.switched).toBe(false);
      expect(result.errors).toEqual(['copy mismatch']);
      expect(adapter.basePath).toBe('Nexus/data');
      expect(adapter.vaultEventStore).toEqual({ marker: 'source-store' });
      expect(adapter.jsonlWriter.setBasePath).not.toHaveBeenCalled();
      expect(adapter.jsonlWriter.setVaultEventStore).not.toHaveBeenCalled();
      expect(adapter.queryCache.clear).not.toHaveBeenCalled();
      expect(adapter.syncCoordinator.setReconcilePipeline).not.toHaveBeenCalled();
    });

    it('returns switched:false when the result is verified but carries no destination store', async () => {
      const adapter = makeHarness();
      relocationModule.__relocateVaultRootMock.mockResolvedValue({
        ...baseRelocationResult
        // no destinationStore
      });

      const result = await adapter.relocateVaultRoot('Archive/Nexus');

      expect(result.switched).toBe(false);
      expect(adapter.jsonlWriter.setBasePath).not.toHaveBeenCalled();
    });

    it('hot-swaps the event store, paths, watcher, and reconcile pipeline on success', async () => {
      const adapter = makeHarness();
      const destinationStore = { marker: 'dest-store' };
      relocationModule.__relocateVaultRootMock.mockResolvedValue({
        ...baseRelocationResult,
        destinationStore
      });

      const result = await adapter.relocateVaultRoot('Archive/Nexus');

      expect(result.switched).toBe(true);
      expect(result.success).toBe(true);

      // Service was constructed against the current store with the default shard size.
      expect(relocationModule.VaultRootRelocationService).toHaveBeenCalledTimes(1);
      const ctorOptions = relocationModule.VaultRootRelocationService.mock.calls[0][0] as {
        sourceStore: unknown;
        targetRootPath: string;
        maxShardBytes: number;
      };
      expect(ctorOptions.sourceStore).toEqual({ marker: 'source-store' });
      expect(ctorOptions.targetRootPath).toBe('Archive/Nexus');
      expect(ctorOptions.maxShardBytes).toBe(DEFAULT_STORAGE_SETTINGS.maxShardBytes);

      // Hot-swap: all reads/writes now point at the destination.
      expect(adapter.vaultEventStore).toBe(destinationStore);
      expect(adapter.basePath).toBe('Archive/Nexus/data');
      expect(adapter.jsonlWriter.setBasePath).toHaveBeenCalledWith('Archive/Nexus/data');
      expect(adapter.jsonlWriter.setVaultEventStore).toHaveBeenCalledWith(destinationStore);
      expect(adapter.jsonlWriter.setVaultEventStoreReadEnabled).toHaveBeenCalledWith(true);
      expect(adapter.jsonlVaultWatcher?.setDataPath).toHaveBeenCalledWith('Archive/Nexus/data');
      expect(adapter.syncCoordinator.setReconcilePipeline).toHaveBeenCalledWith(expect.any(ReconcilePipeline));
      expect(adapter.reconcilePipeline).toBeInstanceOf(ReconcilePipeline);
      expect(adapter.queryCache.clear).toHaveBeenCalledTimes(1);
    });

    it('honors an explicit maxShardBytes override', async () => {
      const adapter = makeHarness();
      relocationModule.__relocateVaultRootMock.mockResolvedValue({
        ...baseRelocationResult,
        destinationStore: { marker: 'dest-store' }
      });

      await adapter.relocateVaultRoot('Archive/Nexus', { maxShardBytes: 1024 });

      const ctorOptions = relocationModule.VaultRootRelocationService.mock.calls[0][0] as {
        maxShardBytes: number;
      };
      expect(ctorOptions.maxShardBytes).toBe(1024);
    });
  });

  // ==========================================================================
  // 4. close() teardown
  // ==========================================================================

  describe('close', () => {
    type CloseHarness = HybridStorageAdapter & {
      initLifecycle: InitLifecycleController;
      syncInterval?: number;
      jsonlVaultWatcher?: { stop: jest.Mock };
      jsonlWriter: { setBeforeWriteHook: jest.Mock };
      queryCache: { clear: jest.Mock };
      sqliteCache: { close: jest.Mock };
    };

    async function makeHarness(initialized = true): Promise<CloseHarness> {
      const adapter = Object.create(HybridStorageAdapter.prototype) as CloseHarness;
      adapter.initLifecycle = initialized
        ? await createReadyLifecycle()
        : new InitLifecycleController();
      adapter.jsonlVaultWatcher = { stop: jest.fn() };
      adapter.jsonlWriter = { setBeforeWriteHook: jest.fn() };
      adapter.queryCache = { clear: jest.fn() };
      adapter.sqliteCache = { close: jest.fn().mockResolvedValue(undefined) };
      return adapter;
    }

    it('is a no-op before initialization has run', async () => {
      const adapter = await makeHarness(false);

      await expect(adapter.close()).resolves.toBeUndefined();

      expect(adapter.jsonlVaultWatcher?.stop).not.toHaveBeenCalled();
      expect(adapter.queryCache.clear).not.toHaveBeenCalled();
      expect(adapter.sqliteCache.close).not.toHaveBeenCalled();
    });

    it('stops the watcher, clears the query cache, then closes the SQLite cache', async () => {
      const adapter = await makeHarness();
      const watcher = adapter.jsonlVaultWatcher as { stop: jest.Mock };
      adapter.syncInterval = window.setInterval(() => undefined, 60_000) as unknown as number;

      await adapter.close();

      // Watcher teardown: hook removed, watcher stopped and dereferenced.
      expect(adapter.jsonlWriter.setBeforeWriteHook).toHaveBeenCalledWith(undefined);
      expect(watcher.stop).toHaveBeenCalledTimes(1);
      expect(adapter.jsonlVaultWatcher).toBeUndefined();
      expect(adapter.syncInterval).toBeUndefined();
      expect(adapter.queryCache.clear).toHaveBeenCalledTimes(1);
      expect(adapter.sqliteCache.close).toHaveBeenCalledTimes(1);

      // Ordering: watcher stop → query cache clear → sqlite close.
      const stopOrder = watcher.stop.mock.invocationCallOrder[0];
      const clearOrder = adapter.queryCache.clear.mock.invocationCallOrder[0];
      const closeOrder = adapter.sqliteCache.close.mock.invocationCallOrder[0];
      expect(stopOrder).toBeLessThan(clearOrder);
      expect(clearOrder).toBeLessThan(closeOrder);
    });

    it('runs teardown again on double-close without throwing', async () => {
      // pins current behavior; see report — close() is NOT idempotent-guarded:
      // a second call re-clears the query cache and re-closes the SQLite
      // cache (the watcher branch is a no-op because the handle was cleared).
      const adapter = await makeHarness();
      const watcher = adapter.jsonlVaultWatcher as { stop: jest.Mock };

      await adapter.close();
      await expect(adapter.close()).resolves.toBeUndefined();

      expect(watcher.stop).toHaveBeenCalledTimes(1);
      expect(adapter.queryCache.clear).toHaveBeenCalledTimes(2);
      expect(adapter.sqliteCache.close).toHaveBeenCalledTimes(2);
    });

    it('rethrows when closing the SQLite cache fails', async () => {
      const adapter = await makeHarness();
      adapter.sqliteCache.close.mockRejectedValue(new Error('wasm teardown failed'));

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(adapter.close()).rejects.toThrow('wasm teardown failed');
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  // ==========================================================================
  // 5. Per-entity delegation smoke — public surface → repository args
  // ==========================================================================

  describe('entity delegation', () => {
    type MockRepo = Record<string, jest.Mock>;
    type DelegationHarness = HybridStorageAdapter & {
      initLifecycle: InitLifecycleController;
      sqliteCache: unknown;
      workspaceRepo: MockRepo;
      sessionRepo: MockRepo;
      stateRepo: MockRepo;
      traceRepo: MockRepo;
      conversationRepo: MockRepo;
      messageRepo: MockRepo;
      projectRepo: MockRepo;
      taskRepo: MockRepo;
      exportService: MockRepo;
    };

    /**
     * The entity delegates are class fields (arrow functions) assigned during
     * construction, so a prototype-only harness cannot reach them. The full
     * constructor is side-effect-light (it only wires collaborators), so we
     * construct for real against a minimal App/Plugin and then swap the
     * private repositories for mocks.
     */
    function makeRealAdapter(): HybridStorageAdapter {
      const app = {
        vault: { configDir: '.obsidian', adapter: {} },
        loadLocalStorage: jest.fn().mockReturnValue('phase0-device-id'),
        saveLocalStorage: jest.fn()
      } as unknown as App;
      const plugin = {
        manifest: { id: 'claudesidian-mcp', dir: '.obsidian/plugins/claudesidian-mcp' }
      } as unknown as Plugin;
      return new HybridStorageAdapter({ app, plugin });
    }

    async function makeHarness(): Promise<DelegationHarness> {
      const adapter = makeRealAdapter() as DelegationHarness;
      adapter.initLifecycle = await createReadyLifecycle();
      adapter.sqliteCache = { marker: 'sqlite-cache' };
      adapter.workspaceRepo = {
        getById: jest.fn().mockResolvedValue(null),
        getWorkspaces: jest.fn().mockResolvedValue({ items: [] }),
        create: jest.fn().mockResolvedValue('ws-id'),
        update: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
        search: jest.fn().mockResolvedValue([])
      };
      adapter.sessionRepo = {
        getById: jest.fn().mockResolvedValue(null),
        getByWorkspaceId: jest.fn().mockResolvedValue({ items: [] }),
        create: jest.fn().mockResolvedValue('session-id'),
        update: jest.fn().mockResolvedValue(undefined),
        moveToWorkspace: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined)
      };
      adapter.stateRepo = {
        getStateData: jest.fn().mockResolvedValue(null),
        getStates: jest.fn().mockResolvedValue({ items: [] }),
        saveState: jest.fn().mockResolvedValue('state-id'),
        updateState: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
        countStates: jest.fn().mockResolvedValue(3)
      };
      adapter.traceRepo = {
        getTraces: jest.fn().mockResolvedValue({ items: [] }),
        addTrace: jest.fn().mockResolvedValue('trace-id'),
        searchTraces: jest.fn().mockResolvedValue({ items: [] })
      };
      adapter.conversationRepo = {
        getById: jest.fn().mockResolvedValue(null),
        getConversations: jest.fn().mockResolvedValue({ items: [] }),
        create: jest.fn().mockResolvedValue('conv-id'),
        update: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
        search: jest.fn().mockResolvedValue([])
      };
      adapter.messageRepo = {
        getMessages: jest.fn().mockResolvedValue({ items: [] }),
        addMessage: jest.fn().mockResolvedValue('msg-id'),
        update: jest.fn().mockResolvedValue(undefined),
        deleteMessage: jest.fn().mockResolvedValue(undefined)
      };
      adapter.projectRepo = {};
      adapter.taskRepo = {};
      adapter.exportService = {
        exportForFineTuning: jest.fn().mockResolvedValue('jsonl-export'),
        exportAllData: jest.fn().mockResolvedValue({ marker: 'export' })
      };
      return adapter;
    }

    it('workspace methods delegate to WorkspaceRepository with the same args', async () => {
      const adapter = await makeHarness();
      const workspace = { name: 'My Workspace' } as Omit<WorkspaceMetadata, 'id'>;

      await adapter.getWorkspace('ws-1');
      await adapter.createWorkspace(workspace);
      await adapter.updateWorkspace('ws-1', { name: 'Renamed' });
      await adapter.deleteWorkspace('ws-1');
      await adapter.searchWorkspaces('query');

      expect(adapter.workspaceRepo.getById).toHaveBeenCalledWith('ws-1');
      expect(adapter.workspaceRepo.create).toHaveBeenCalledWith(workspace);
      expect(adapter.workspaceRepo.update).toHaveBeenCalledWith('ws-1', { name: 'Renamed' });
      expect(adapter.workspaceRepo.delete).toHaveBeenCalledWith('ws-1');
      expect(adapter.workspaceRepo.search).toHaveBeenCalledWith('query');
    });

    it('session create merges workspaceId; update forwards updatable fields incl. startTime', async () => {
      const adapter = await makeHarness();

      await adapter.createSession('ws-1', { name: 'Session A' } as Omit<SessionMetadata, 'id' | 'workspaceId'>);
      expect(adapter.sessionRepo.create).toHaveBeenCalledWith({ name: 'Session A', workspaceId: 'ws-1' });

      // The positional workspaceId always wins over one in `updates` (it routes
      // the JSONL write; moving a session goes through moveSessionToWorkspace).
      // All other updatable SessionMetadata fields pass through, incl. startTime.
      await adapter.updateSession('ws-1', 'session-1', {
        name: 'Renamed',
        description: 'desc',
        endTime: 123,
        isActive: false,
        workspaceId: 'SHOULD-BE-IGNORED',
        startTime: 999
      } as Partial<SessionMetadata>);
      expect(adapter.sessionRepo.update).toHaveBeenCalledWith('session-1', {
        name: 'Renamed',
        description: 'desc',
        startTime: 999,
        endTime: 123,
        isActive: false,
        workspaceId: 'ws-1'
      });

      await adapter.moveSessionToWorkspace('session-1', 'ws-2');
      expect(adapter.sessionRepo.moveToWorkspace).toHaveBeenCalledWith('session-1', 'ws-2');

      await adapter.deleteSession('session-1');
      expect(adapter.sessionRepo.delete).toHaveBeenCalledWith('session-1');
    });

    it('state methods delegate to StateRepository with the same args', async () => {
      const adapter = await makeHarness();
      const stateContent = { name: 'Checkpoint', content: { foo: 'bar' } };

      await adapter.getState('state-1');
      await adapter.getStates('ws-1', 'session-1', { page: 0, pageSize: 10 });
      await adapter.saveState('ws-1', 'session-1', stateContent as never);
      await adapter.updateState('state-1', { name: 'Renamed', tags: ['a'] });
      await adapter.deleteState('state-1');
      await expect(adapter.countStates('ws-1', 'session-1')).resolves.toBe(3);

      expect(adapter.stateRepo.getStateData).toHaveBeenCalledWith('state-1');
      expect(adapter.stateRepo.getStates).toHaveBeenCalledWith('ws-1', 'session-1', { page: 0, pageSize: 10 });
      expect(adapter.stateRepo.saveState).toHaveBeenCalledWith('ws-1', 'session-1', stateContent);
      expect(adapter.stateRepo.updateState).toHaveBeenCalledWith('state-1', { name: 'Renamed', tags: ['a'] });
      expect(adapter.stateRepo.delete).toHaveBeenCalledWith('state-1');
      expect(adapter.stateRepo.countStates).toHaveBeenCalledWith('ws-1', 'session-1');
    });

    it('trace methods delegate; searchTraces unwraps the paginated result', async () => {
      const adapter = await makeHarness();
      const trace = { content: 'tool ran' } as Omit<MemoryTraceData, 'id' | 'workspaceId' | 'sessionId'>;
      const foundTrace = { id: 'trace-9' } as MemoryTraceData;
      adapter.traceRepo.searchTraces.mockResolvedValue({ items: [foundTrace] });

      await adapter.getTraces('ws-1', 'session-1', { page: 1, pageSize: 5 });
      await adapter.addTrace('ws-1', 'session-1', trace);
      const results = await adapter.searchTraces('ws-1', 'needle', 'session-1');

      expect(adapter.traceRepo.getTraces).toHaveBeenCalledWith('ws-1', 'session-1', { page: 1, pageSize: 5 });
      expect(adapter.traceRepo.addTrace).toHaveBeenCalledWith('ws-1', 'session-1', trace);
      expect(adapter.traceRepo.searchTraces).toHaveBeenCalledWith('ws-1', 'needle', 'session-1');
      expect(results).toEqual([foundTrace]);
    });

    it('conversation methods delegate; delete cascades into child branches first', async () => {
      const adapter = await makeHarness();
      const branch = {
        id: 'branch-1',
        metadata: { parentConversationId: 'conv-1' }
      } as unknown as ConversationMetadata;
      const unrelated = {
        id: 'other-1',
        metadata: { parentConversationId: 'conv-OTHER' }
      } as unknown as ConversationMetadata;
      adapter.conversationRepo.getConversations.mockResolvedValue({ items: [branch, unrelated] });

      await adapter.getConversation('conv-1');
      await adapter.createConversation({ title: 'Chat' } as Omit<ConversationMetadata, 'id' | 'messageCount'>);
      await adapter.updateConversation('conv-1', { title: 'Renamed' } as Partial<ConversationMetadata>);
      await adapter.searchConversations('needle');
      await adapter.deleteConversation('conv-1');

      expect(adapter.conversationRepo.getById).toHaveBeenCalledWith('conv-1');
      expect(adapter.conversationRepo.create).toHaveBeenCalledWith({ title: 'Chat' });
      expect(adapter.conversationRepo.update).toHaveBeenCalledWith('conv-1', { title: 'Renamed' });
      expect(adapter.conversationRepo.search).toHaveBeenCalledWith('needle');

      // Cascade: branch lookup uses the fixed page shape, child deleted before parent.
      expect(adapter.conversationRepo.getConversations).toHaveBeenCalledWith({
        pageSize: 100,
        includeBranches: true
      });
      expect(adapter.conversationRepo.delete.mock.calls.map((call) => call[0])).toEqual([
        'branch-1',
        'conv-1'
      ]);
    });

    it('message methods delegate; updateMessage forwards conversationId for validation', async () => {
      const adapter = await makeHarness();
      const message = { role: 'user', content: 'hi' };
      adapter.conversationRepo.getConversations.mockResolvedValue({ items: [] });

      await adapter.getMessages('conv-1', { page: 0, pageSize: 50 });
      await adapter.addMessage('conv-1', message as never);
      await adapter.updateMessage('conv-1', 'msg-1', { content: 'edited' } as never);
      await adapter.deleteMessage('conv-1', 'msg-1');

      expect(adapter.messageRepo.getMessages).toHaveBeenCalledWith('conv-1', { page: 0, pageSize: 50 });
      expect(adapter.messageRepo.addMessage).toHaveBeenCalledWith('conv-1', message);
      expect(adapter.messageRepo.update).toHaveBeenCalledWith('msg-1', { content: 'edited' }, 'conv-1');
      expect(adapter.messageRepo.deleteMessage).toHaveBeenCalledWith('conv-1', 'msg-1');
    });

    it('deleteMessage cascades into branch conversations anchored on the message', async () => {
      const adapter = await makeHarness();
      const messageBranch = {
        id: 'branch-2',
        metadata: { parentMessageId: 'msg-1' }
      } as unknown as ConversationMetadata;
      adapter.conversationRepo.getConversations.mockResolvedValue({ items: [messageBranch] });

      await adapter.deleteMessage('conv-1', 'msg-1');

      expect(adapter.conversationRepo.delete).toHaveBeenCalledWith('branch-2');
      expect(adapter.messageRepo.deleteMessage).toHaveBeenCalledWith('conv-1', 'msg-1');
    });

    it('project/task/message accessors expose the underlying repositories; cache accessors expose SQLite', async () => {
      const adapter = await makeHarness();

      expect(adapter.projects).toBe(adapter.projectRepo);
      expect(adapter.tasks).toBe(adapter.taskRepo);
      expect(adapter.messages).toBe(adapter.messageRepo);
      expect(adapter.cache).toBe(adapter.sqliteCache);
      expect(adapter.getSqliteCache()).toBe(adapter.sqliteCache);
    });

    it('export methods delegate to ExportService; importData is unimplemented', async () => {
      const adapter = await makeHarness();
      const filter = { workspaceId: 'ws-1' } as never;

      await expect(adapter.exportConversationsForFineTuning(filter)).resolves.toBe('jsonl-export');
      await expect(adapter.exportAllData()).resolves.toEqual({ marker: 'export' });
      expect(adapter.exportService.exportForFineTuning).toHaveBeenCalledWith(filter);
      expect(adapter.exportService.exportAllData).toHaveBeenCalledTimes(1);

      // pins current behavior; see report — importData throws unconditionally.
      await expect(adapter.importData({} as never)).rejects.toThrow('importData not yet implemented');
    });

    it('delegates reject when initialize() was never called', async () => {
      const adapter = await makeHarness();
      adapter.initLifecycle = new InitLifecycleController();

      await expect(adapter.getWorkspace('ws-1')).rejects.toThrow(
        'HybridStorageAdapter not initialized. Call initialize() first.'
      );
      expect(adapter.workspaceRepo.getById).not.toHaveBeenCalled();
    });

    it('delegates surface the init error when initialization failed', async () => {
      const adapter = await makeHarness();
      const failed = new InitLifecycleController();
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await failed.run(async () => {
          throw new Error('boot exploded');
        }, { blocking: false });
        await failed.waitForReady();
      } finally {
        errSpy.mockRestore();
      }
      adapter.initLifecycle = failed;

      await expect(adapter.getWorkspace('ws-1')).rejects.toThrow('boot exploded');
      expect(adapter.workspaceRepo.getById).not.toHaveBeenCalled();
    });
  });
});
