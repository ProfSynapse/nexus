/**
 * Location: src/database/adapters/HybridStorageAdapter.ts
 *
 * Hybrid Storage Adapter - Thin Facade Following SOLID Principles
 *
 * This adapter coordinates JSONL (source of truth) + SQLite (cache) by:
 * 1. Owning infrastructure (JSONLWriter, SQLiteCache, SyncCoordinator, QueryCache)
 * 2. Delegating all entity operations to focused repositories
 * 3. Managing lifecycle (initialize, close, sync)
 *
 * SOLID Compliance:
 * - S: Only orchestration/lifecycle, no business logic
 * - O: Extensible through new repositories
 * - L: Implements IStorageAdapter
 * - I: Clean interface segregation
 * - D: Depends on repository abstractions
 *
 * Related Files:
 * - src/database/repositories/* - Entity repositories
 * - src/database/services/* - Business services
 * - src/database/interfaces/IStorageAdapter.ts - Interface definition
 */

import { App, Events, EventRef, Plugin } from 'obsidian';
import { IStorageAdapter, QueryOptions, ImportOptions } from '../interfaces/IStorageAdapter';
import { JSONLWriter } from '../storage/JSONLWriter';
import { SQLiteCacheManager } from '../storage/SQLiteCacheManager';
import { SyncCoordinator } from '../sync/SyncCoordinator';
import { JsonlVaultWatcher, ModifiedStream } from '../sync/JsonlVaultWatcher';
import { ReconcilePipeline } from '../sync/ReconcilePipeline';
import { QueryCache } from '../optimizations/QueryCache';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import {
  WorkspaceMetadata,
  SessionMetadata,
  StateMetadata,
  StateData,
  ConversationMetadata,
  MessageData,
  MemoryTraceData,
  ExportFilter,
  ExportData,
  SyncResult
} from '../../types/storage/HybridStorageTypes';
import { RepositoryDependencies } from '../repositories/base/BaseRepository';
import { LegacyMigrator } from '../migration/LegacyMigrator';
import { WorkspaceEvent, ConversationEvent, TaskEvent } from '../interfaces/StorageEvents';
import { WorkspaceEventApplier } from '../sync/WorkspaceEventApplier';
import { ConversationEventApplier } from '../sync/ConversationEventApplier';
import { TaskEventApplier } from '../sync/TaskEventApplier';
import { resolveWorkspaceId } from '../sync/resolveWorkspaceId';
import {
  PluginScopedStorageCoordinator,
  PluginScopedStoragePlan
} from '../migration/PluginScopedStorageCoordinator';
import {
  StartupHydrationController,
  type StartupHydrationState,
  shouldBlockStartupHydrationForVerifiedCutover
} from './lifecycle/StartupHydrationController';
import { InitLifecycleController } from './lifecycle/InitLifecycleController';
import {
  ReconciliationCoordinator,
  type ReconcileCategory
} from './lifecycle/ReconciliationCoordinator';
import { VaultRootMigrationService } from '../migration/VaultRootMigrationService';
import {
  VaultRootRelocationService,
  type VaultRootRelocationResult
} from '../migration/VaultRootRelocationService';
import { resolvePluginStorageRoot, resolveActivePluginFolderName } from '../storage/PluginStoragePathResolver';
import { resolveVaultRoot } from '../storage/VaultRootResolver';
import { VaultEventStore } from '../storage/vaultRoot/VaultEventStore';
import { DEFAULT_STORAGE_SETTINGS } from '../../types/plugin/PluginTypes';
import { CacheBackendMigration, type CacheBackendStateAccessor } from '../migration/CacheBackendMigration';
import { createCacheBlobStore, computeIdbKey } from '../storage/CacheBlobStoreFactory';
import type { CacheBlobStore } from '../storage/CacheBlobStore';
import { isDesktop } from '../../utils/platform';

// Import all repositories
import { WorkspaceRepository } from '../repositories/WorkspaceRepository';
import { SessionRepository } from '../repositories/SessionRepository';
import { StateRepository } from '../repositories/StateRepository';
import { TraceRepository } from '../repositories/TraceRepository';
import { ConversationRepository } from '../repositories/ConversationRepository';
import { MessageRepository } from '../repositories/MessageRepository';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { TaskRepository } from '../repositories/TaskRepository';
// Import services
import { ExportService } from '../services/ExportService';

type ExportServiceStateRepo = {
  getStates(workspaceId: string, sessionId: string | undefined, options?: { pageSize?: number }): Promise<{ items: StateData[] }>;
};

/**
 * Configuration options for HybridStorageAdapter
 */
export interface HybridStorageAdapterOptions {
  /** Obsidian app instance */
  app: App;
  /** Active plugin instance for plugin-scoped storage resolution */
  plugin: Plugin;
  /** Base path for storage (default: '.nexus') */
  basePath?: string;
  /** Auto-sync on initialization (default: true) */
  autoSync?: boolean;
  /** Query cache TTL in ms (default: 60000) */
  cacheTTL?: number;
  /** Query cache max size (default: 500) */
  cacheMaxSize?: number;
  /** Idle timeout for startup full rebuild progress (default: 120000) */
  startupRebuildIdleTimeoutMs?: number;
}

export const DEFAULT_STARTUP_REBUILD_IDLE_TIMEOUT_MS = 120_000;

/**
 * Payload delivered to subscribers of the adapter's `external-sync` event.
 * Fired after the JSONL vault watcher detects a change and the resulting
 * reconciliation has been applied to SQLite.
 */
export interface ExternalSyncEvent {
  /** Result of the reconciliation run that landed the remote JSONL events. */
  result: SyncResult;
  /**
   * The logical streams that triggered this sync (deduped across the
   * debounce window). UI consumers use this to decide whether content
   * they are currently displaying needs to re-query from SQLite.
   */
  modified: ModifiedStream[];
}

export { StartupHydrationState, shouldBlockStartupHydrationForVerifiedCutover };

/**
 * Hybrid Storage Adapter
 *
 * Thin facade that composes repositories and handles lifecycle.
 * Reduced from 1,696 lines to ~350 lines by delegating to repositories.
 */
export class HybridStorageAdapter implements IStorageAdapter {
  private app: App;
  private plugin: Plugin;
  private basePath: string;
  private syncInterval?: number;
  /**
   * Watches the plugin's vault data folder for JSONL changes landed by
   * Obsidian Sync (or otherwise) and triggers reconciliation + emits the
   * `external-sync` event. See JsonlVaultWatcher for design notes.
   */
  private jsonlVaultWatcher?: JsonlVaultWatcher;
  /**
   * Typed event bus for adapter consumers. Currently emits one event:
   *   `external-sync` — payload: { result: SyncResult, modified: ModifiedStream[] }
   * fired after a watcher-triggered sync completes.
   */
  private readonly externalEvents = new Events();
  private readonly hydration = new StartupHydrationController();
  private readonly initLifecycle = new InitLifecycleController();
  private readonly startupRebuildIdleTimeoutMs: number;

  /**
   * Coalesces concurrent `rebuildCache` invocations. When a rebuild is in
   * flight, subsequent calls return the same promise so a double-click on
   * "Nexus: Rebuild cache" cannot start two simultaneous rebuilds (which
   * would race over close/remove/initialize/save on `sqliteCache`).
   */
  private rebuildInFlight: Promise<void> | null = null;

  // Infrastructure (owned by adapter)
  private jsonlWriter: JSONLWriter;
  private sqliteCache: SQLiteCacheManager;
  private syncCoordinator: SyncCoordinator;
  private reconcilePipeline: ReconcilePipeline | null = null;
  private reconciliationCoordinator!: ReconciliationCoordinator;
  private queryCache: QueryCache;
  private storageCoordinator: PluginScopedStorageCoordinator;
  private vaultEventStore: VaultEventStore | null = null;
  private cacheBlobStore: CacheBlobStore;

  // Repositories (composed)
  private workspaceRepo!: WorkspaceRepository;
  private sessionRepo!: SessionRepository;
  private stateRepo!: StateRepository;
  private traceRepo!: TraceRepository;
  private conversationRepo!: ConversationRepository;
  private messageRepo!: MessageRepository;
  private projectRepo!: ProjectRepository;
  private taskRepo!: TaskRepository;

  // Services
  private exportService!: ExportService;

  constructor(options: HybridStorageAdapterOptions) {
    this.app = options.app;
    this.plugin = options.plugin;
    this.basePath = options.basePath ?? '.nexus';
    this.startupRebuildIdleTimeoutMs = options.startupRebuildIdleTimeoutMs ?? DEFAULT_STARTUP_REBUILD_IDLE_TIMEOUT_MS;
    const storageRoots = resolvePluginStorageRoot(this.app, this.plugin);
    this.storageCoordinator = new PluginScopedStorageCoordinator(this.app, this.plugin, this.basePath);

    // Initialize infrastructure
    this.jsonlWriter = new JSONLWriter({
      app: this.app,
      basePath: this.basePath
    });

    // Build the cache-blob store ONCE here so the migration runner and the
    // SQLiteCacheManager share the same instance. The store is selected by
    // platform: IndexedDB on desktop (cloud-sync-immune), vault.adapter on
    // mobile (iOS WKWebView IDB durability is insufficient for 150+ MB blobs).
    const pluginFolderName = resolveActivePluginFolderName(this.plugin);
    this.cacheBlobStore = createCacheBlobStore({
      app: this.app,
      vaultRelativePath: `${storageRoots.dataRoot}/cache.db`,
      idbKey: computeIdbKey(this.app, pluginFolderName)
    });

    this.sqliteCache = new SQLiteCacheManager({
      app: this.app,
      dbPath: `${storageRoots.dataRoot}/cache.db`,
      wasmPath: `${storageRoots.pluginDir}/sqlite3.wasm`,
      blobStore: this.cacheBlobStore,
      plugin: this.plugin
    });

    this.syncCoordinator = new SyncCoordinator(
      this.jsonlWriter,
      this.sqliteCache
    );

    this.queryCache = new QueryCache({
      defaultTTL: options.cacheTTL ?? 60000,
      maxSize: options.cacheMaxSize ?? 500
    });

    // Create repository dependencies
    const deps: RepositoryDependencies = {
      jsonlWriter: this.jsonlWriter,
      sqliteCache: this.sqliteCache,
      queryCache: this.queryCache
    };

    // Initialize all repositories
    this.workspaceRepo = new WorkspaceRepository(deps);
    this.sessionRepo = new SessionRepository(deps);
    this.stateRepo = new StateRepository(deps);
    this.traceRepo = new TraceRepository(deps);
    this.conversationRepo = new ConversationRepository(deps);
    this.messageRepo = new MessageRepository(deps);
    this.projectRepo = new ProjectRepository(deps);
    this.taskRepo = new TaskRepository(deps);

    // Initialize services
    this.exportService = new ExportService({
      app: this.app,
      conversationRepo: this.conversationRepo,
      messageRepo: this.messageRepo,
      workspaceRepo: this.workspaceRepo,
      sessionRepo: this.sessionRepo,
      stateRepo: this.stateRepo as unknown as ExportServiceStateRepo,
      traceRepo: this.traceRepo
    });
  }

  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  /**
   * Initialize the storage adapter. By default, starts initialization in
   * the background and returns immediately; use `waitForReady()` to await
   * completion. Pass `blocking: true` to wait inline.
   *
   * The init promise is GUARANTEED to settle (via `InitLifecycleController`)
   * regardless of how `performInitialization` resolves — this is what
   * prevents `waitForQueryReady` callers from hanging for the full timeout
   * window when an init step throws unexpectedly (issue #209).
   */
  async initialize(blocking = false): Promise<void> {
    await this.initLifecycle.run(() => this.performInitialization(), { blocking });
  }

  private async performInitialization(): Promise<void> {
    try {
      const migrator = new LegacyMigrator(this.app);
      const migrationNeeded = await migrator.isMigrationNeeded();
      let actuallyMigrated = false;

      if (migrationNeeded) {
        const migrationResult = await migrator.migrate();
        // Only count as "actually migrated" if something was migrated
        actuallyMigrated = migrationResult.needed &&
          (migrationResult.stats.workspacesMigrated > 0 || migrationResult.stats.conversationsMigrated > 0);
      }

      let storagePlan = await this.storageCoordinator.prepareStoragePlan();
      this.applyStoragePlan(storagePlan);
      storagePlan = await this.backfillVaultEventStore(storagePlan);

      // Cache-backend migration (cache.db file → IndexedDB on desktop). Runs
      // foreground-blocking with a Notice; mobile bypasses immediately. Must
      // execute BEFORE sqliteCache.initialize() so the cache manager loads
      // bytes from the destination backend, not the legacy file.
      await this.runCacheBackendMigration(storagePlan);

      await this.sqliteCache.initialize();
      this.reconciliationCoordinator = new ReconciliationCoordinator(this.jsonlWriter, this.sqliteCache);

      const shouldBlockStartupHydration = await this.shouldBlockStartupHydration(storagePlan);
      if (shouldBlockStartupHydration) {
        this.hydration.startBlocking();
      } else {
        this.hydration.clear();
      }

      await this.jsonlWriter.ensureDirectory('workspaces');
      await this.jsonlWriter.ensureDirectory('conversations');
      await this.jsonlWriter.ensureDirectory('tasks');

      // The SQLite schema is ready by this point — sync below populates
      // data in the background, but the adapter is already usable. Waiters
      // registered before now will settle when initLifecycle.run() returns.
      const syncState = await this.sqliteCache.getSyncState(this.jsonlWriter.getDeviceId());
      if (!syncState || actuallyMigrated || shouldBlockStartupHydration) {
        await this.runStartupFullRebuild(shouldBlockStartupHydration);
      } else {
        try {
          await this.syncCoordinator.sync();
        } catch (syncError) {
          console.error('[HybridStorageAdapter] Incremental sync failed:', syncError);
        }

        await this.runReconcile('workspace', () => this.reconcileMissingWorkspaces());
        await this.runReconcile('conversation', () => this.reconcileMissingConversations());
        await this.runReconcile('task', () => this.reconcileMissingTasks());
      }

      if (shouldBlockStartupHydration && this.hydration.getState().phase !== 'error') {
        this.hydration.complete();
      }

      // Watch the plugin data folder for JSONL changes landed by Obsidian
      // Sync (or external tools). When something changes, reconcile SQLite
      // and emit `external-sync` so open views can refresh.
      this.startJsonlVaultWatcher();
    } catch (error) {
      console.error('[HybridStorageAdapter] Initialization failed:', error);
      throw error;
    }
  }

  private async runStartupFullRebuild(isBlockingHydration: boolean): Promise<void> {
    let rejectIdleTimeout: ((error: Error) => void) | undefined;
    const idleTimeoutPromise = isBlockingHydration
      ? new Promise<never>((_, reject) => {
        rejectIdleTimeout = reject;
      })
      : undefined;

    const stopWatchdog = isBlockingHydration
      ? this.hydration.startIdleWatchdog({
        idleTimeoutMs: this.getStartupRebuildIdleTimeoutMs(),
        onTimeout: () => {
          const message = `Local chat index rebuild made no progress for ${this.getStartupRebuildIdleTimeoutMs()} ms`;
          this.hydration.fail(message);
          rejectIdleTimeout?.(new Error(message));
        }
      })
      : undefined;

    try {
      const rebuildPromise = this.syncCoordinator.fullRebuild({
        onProgress: (stage, progress, total) => {
          this.hydration.updateProgress(stage, progress, total, isBlockingHydration);
        }
      });
      const result = idleTimeoutPromise
        ? await Promise.race([rebuildPromise, idleTimeoutPromise])
        : await rebuildPromise;

      if (!result.success) {
        const summary = result.errors.length > 0 ? result.errors.join('; ') : 'Unknown error';
        const message = `Local chat index rebuild failed: ${summary}`;
        this.hydration.fail(message);
        throw new Error(message);
      }
    } catch (rebuildError) {
      console.error('[HybridStorageAdapter] Full rebuild failed:', rebuildError);
      if (this.hydration.getState().phase !== 'error') {
        this.hydration.fail(rebuildError instanceof Error ? rebuildError.message : String(rebuildError));
      }
      throw rebuildError instanceof Error ? rebuildError : new Error(String(rebuildError));
    } finally {
      stopWatchdog?.();
    }
  }

  private getStartupRebuildIdleTimeoutMs(): number {
    return this.startupRebuildIdleTimeoutMs ?? DEFAULT_STARTUP_REBUILD_IDLE_TIMEOUT_MS;
  }

  private async runReconcile(label: string, fn: () => Promise<number>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.error(`[HybridStorageAdapter] ${label} reconciliation failed:`, e);
    }
  }

  private applyStoragePlan(plan: PluginScopedStoragePlan): void {
    this.basePath = plan.vaultWriteBasePath;
    this.vaultEventStore = new VaultEventStore({
      app: this.app,
      resolution: plan.vaultRoot
    });
    this.jsonlWriter.setBasePath(plan.vaultWriteBasePath);
    this.jsonlWriter.setReadBasePaths(plan.legacyReadBasePaths);
    this.jsonlWriter.setVaultEventStore(this.vaultEventStore);
    this.jsonlWriter.setVaultEventStoreReadEnabled(
      plan.state.migration.state === 'verified' || plan.state.migration.state === 'not_needed'
    );
    this.sqliteCache.setDbPath(plan.pluginCacheDbPath);
    this.wireReconcilePipeline();
  }

  /**
   * Construct the sync-safe reconcile pipeline once `vaultEventStore` is
   * available and inject it into the `SyncCoordinator`. Called from
   * `applyStoragePlan` and `relocateVaultRoot`. Idempotent: replaces the
   * existing pipeline so cursor state from the old root is dropped.
   */
  private wireReconcilePipeline(): void {
    if (!this.syncCoordinator || !this.sqliteCache || !this.jsonlWriter) {
      this.reconcilePipeline = null;
      return;
    }
    if (!this.vaultEventStore) {
      this.reconcilePipeline = null;
      this.syncCoordinator.setReconcilePipeline(null);
      return;
    }
    const appliers = this.syncCoordinator.getAppliers();
    this.reconcilePipeline = new ReconcilePipeline({
      vaultEventStore: this.vaultEventStore,
      syncStateStore: this.sqliteCache.getSyncStateStore(),
      sqliteCache: this.sqliteCache,
      workspaceApplier: appliers.workspace,
      conversationApplier: appliers.conversation,
      taskApplier: appliers.task,
      deviceId: this.jsonlWriter.getDeviceId()
    });
    this.syncCoordinator.setReconcilePipeline(this.reconcilePipeline);
  }

  /**
   * Kick off cache-backend migration before SQLite initializes. On desktop,
   * reads any legacy `cache.db` from `vault.adapter` and writes it into IDB,
   * verifies, and marks complete. On mobile (or after a verified run), this
   * resolves immediately.
   *
   * Failure here is non-fatal: the migration runner persists 'failed' state,
   * surfaces a Notice to the user, and returns. The cache manager then opens
   * against an empty backend and the standard JSONL-replay path rebuilds it.
   */
  private async runCacheBackendMigration(plan: PluginScopedStoragePlan): Promise<void> {
    const accessor: CacheBackendStateAccessor = {
      read: () => this.storageCoordinator.readCacheBackendState(),
      write: (state) => this.storageCoordinator.writeCacheBackendState(state)
    };
    const migration = new CacheBackendMigration({
      adapter: this.app.vault.adapter,
      legacyDbPath: plan.pluginCacheDbPath,
      pluginDataRoot: plan.roots.dataRoot,
      blobStore: this.cacheBlobStore,
      stateAccessor: accessor,
      isMobile: !isDesktop()
    });
    await migration.runIfNeeded();
  }

  private async backfillVaultEventStore(plan: PluginScopedStoragePlan): Promise<PluginScopedStoragePlan> {
    if (plan.state.migration.state !== 'pending' || !this.vaultEventStore) {
      return plan;
    }

    try {
      const migrationService = new VaultRootMigrationService({
        app: this.app,
        vaultEventStore: this.vaultEventStore,
        legacyRoots: plan.legacyReadBasePaths
      });
      const result = await migrationService.backfillLegacyRoots();

      if (result.success && result.verified) {
        const nextState = await this.storageCoordinator.persistMigrationState(plan, 'verified', {
          completedAt: Date.now(),
          verifiedAt: Date.now()
        });
        this.jsonlWriter.setVaultEventStoreReadEnabled(true);
        return {
          ...plan,
          state: nextState
        };
      }

      const failureMessage = result.errors[0] ?? result.message;
      const nextState = await this.storageCoordinator.persistMigrationState(plan, 'failed', {
        completedAt: Date.now(),
        lastError: failureMessage
      });
      return {
        ...plan,
        state: nextState
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextState = await this.storageCoordinator.persistMigrationState(plan, 'failed', {
        completedAt: Date.now(),
        lastError: message
      });
      return {
        ...plan,
        state: nextState
      };
    }
  }

  private async shouldBlockStartupHydration(plan: PluginScopedStoragePlan): Promise<boolean> {
    const conversationFiles = await this.jsonlWriter.listFiles('conversations');
    const stats = await this.sqliteCache.getStatistics();
    return shouldBlockStartupHydrationForVerifiedCutover({
      migrationState: plan.state.migration.state,
      sourceOfTruthLocation: plan.state.sourceOfTruthLocation,
      conversationFileCount: conversationFiles.length,
      cachedConversationCount: stats.conversations,
      cachedMessageCount: stats.messages
    });
  }

  /**
   * Reconcile JSONL workspace files that are missing from SQLite.
   * Handles the case where incremental sync skips same-device events.
   */
  private reconcileMissingWorkspaces(): Promise<number> {
    const applier = new WorkspaceEventApplier(this.sqliteCache);
    const category: ReconcileCategory<WorkspaceEvent> = {
      label: 'workspace',
      subdir: 'workspaces',
      filenameRegex: /workspaces\/ws_(.+)\.jsonl$/,
      existsInCache: async (id) => (await this.workspaceRepo.getById(id)) !== null,
      shouldSkipEvents: (events) => {
        // Skip deletes — no need to create then immediately delete.
        if (events.some(e => e.type === 'workspace_deleted')) return true;
        // Skip files with no workspace_created event (corrupt/incomplete).
        return !events.some(e => e.type === 'workspace_created');
      },
      applyEvent: (e) => applier.apply(e)
    };
    return this.reconciliationCoordinator.reconcile(category);
  }

  /**
   * Reconcile JSONL conversation files that are missing from SQLite.
   * Handles the case where incremental sync skips remote files whose
   * event timestamps predate the local sync watermark.
   */
  private reconcileMissingConversations(): Promise<number> {
    const applier = new ConversationEventApplier(this.sqliteCache);
    const category: ReconcileCategory<ConversationEvent> = {
      label: 'conversation',
      subdir: 'conversations',
      filenameRegex: /conversations\/conv_(.+)\.jsonl$/,
      existsInCache: async (id) => (await this.conversationRepo.getById(id)) !== null,
      shouldSkipEvents: (events) => {
        if (events.some(e => e.type === 'conversation_deleted')) return true;
        return !events.some(e => e.type === 'metadata');
      },
      applyEvent: (e) => applier.apply(e)
    };
    return this.reconciliationCoordinator.reconcile(category);
  }

  /**
   * Reconcile JSONL task files that are missing from SQLite.
   *
   * Note: tasks resolve the workspace id (name → UUID) and probe `projects`
   * directly rather than going through a repository's getById — they are
   * keyed by workspaceId, not entity id, so the standard "exists?" probe
   * is a SQL count instead.
   */
  private reconcileMissingTasks(): Promise<number> {
    const applier = new TaskEventApplier(this.sqliteCache);
    const category: ReconcileCategory<TaskEvent> = {
      label: 'tasks',
      subdir: 'tasks',
      filenameRegex: /tasks\/tasks_(.+)\.jsonl$/,
      existsInCache: async (fileWorkspaceId) => {
        const resolved = await resolveWorkspaceId(fileWorkspaceId, this.sqliteCache);
        const effectiveId = resolved.id ?? fileWorkspaceId;
        const projects = await this.sqliteCache.query<{ id: string }>(
          'SELECT id FROM projects WHERE workspaceId = ? LIMIT 1',
          [effectiveId]
        );
        return projects.length > 0;
      },
      shouldSkipEvents: () => false,
      applyEvent: (e) => applier.apply(e)
    };
    return this.reconciliationCoordinator.reconcile(category);
  }

  /**
   * Check if the adapter is ready for use
   */
  isReady(): boolean {
    return this.initLifecycle.isReady();
  }

  isQueryReady(): boolean {
    return this.isReady() && this.hydration.isQueryReadyPhase();
  }

  /**
   * Wait for initialization to complete.
   * @returns true if initialization succeeded, false if it failed
   */
  waitForReady(): Promise<boolean> {
    return this.initLifecycle.waitForReady();
  }

  waitForQueryReady(maxWaitMs = this.getStartupRebuildIdleTimeoutMs()): Promise<boolean> {
    if (this.isQueryReady()) return Promise.resolve(true);
    if (this.initLifecycle.isInitialized() && this.initLifecycle.getError()) {
      return Promise.resolve(false);
    }
    if (this.initLifecycle.hasStarted() && !this.initLifecycle.isInitialized()) {
      return this.initLifecycle.waitForReady().then((ready) => {
        if (!ready) return false;
        if (this.isQueryReady()) return true;
        return this.hydration.waitForReady({
          maxWaitMs,
          timeoutMode: 'idle',
          readyProbe: () => this.isQueryReady(),
          onTimeout: (ms) => console.error('[HybridStorageAdapter] waitForQueryReady idle timed out after', ms, 'ms')
        });
      });
    }
    return this.hydration.waitForReady({
      maxWaitMs,
      timeoutMode: 'idle',
      readyProbe: () => this.isQueryReady(),
      onTimeout: (ms) => console.error('[HybridStorageAdapter] waitForQueryReady idle timed out after', ms, 'ms')
    });
  }

  /**
   * Get initialization error if any
   */
  getInitError(): Error | null {
    return this.initLifecycle.getError();
  }

  /**
   * Get the underlying SQLite cache manager
   * Used by EmbeddingManager for vector storage
   */
  get cache(): SQLiteCacheManager {
    return this.sqliteCache;
  }

  /**
   * Get the underlying SQLite cache manager (typed accessor).
   * Used by the Skills app's index service to query/upsert the derived
   * `skills` table without depending on the `cache` getter's exact shape.
   */
  getSqliteCache(): SQLiteCacheManager {
    return this.sqliteCache;
  }

  getStartupHydrationState(): StartupHydrationState {
    return this.hydration.getState();
  }

  isStartupHydrationBlocking(): boolean {
    return this.hydration.isBlocking();
  }

  /**
   * Get the message repository instance.
   * Used by ConversationEmbeddingWatcher to register completion callbacks.
   */
  get messages(): MessageRepository {
    return this.messageRepo;
  }

  /**
   * Get the project repository instance.
   * Used by TaskService for project operations.
   */
  get projects(): ProjectRepository {
    return this.projectRepo;
  }

  /**
   * Get the task repository instance.
   * Used by TaskService for task operations.
   */
  get tasks(): TaskRepository {
    return this.taskRepo;
  }

  async close(): Promise<void> {
    if (!this.initLifecycle.isInitialized()) {
      return;
    }

    try {
      if (this.syncInterval) {
        window.clearInterval(this.syncInterval);
        this.syncInterval = undefined;
      }

      this.stopJsonlVaultWatcher();
      this.queryCache.clear();
      await this.sqliteCache.close();
    } catch (error) {
      console.error('[HybridStorageAdapter] Error during close:', error);
      throw error;
    }
  }

  /**
   * Wipe the cache backend and rebuild SQLite from the JSONL source of truth.
   * Used by the "Nexus: Rebuild cache" command to recover from a corrupted or
   * out-of-sync cache without touching the (synced) JSONL event store.
   */
  async rebuildCache(options: { onProgress?: (label: string, done: number, total: number) => void } = {}): Promise<void> {
    // Coalesce concurrent invocations. A second click on "Nexus: Rebuild
    // cache" while one is in flight returns the same promise — both callers
    // settle on the same outcome, errors propagate to both.
    if (this.rebuildInFlight) {
      return this.rebuildInFlight;
    }

    this.rebuildInFlight = (async () => {
      try {
        if (!this.initLifecycle.isInitialized()) {
          throw new Error('Storage adapter is not initialized; cannot rebuild cache');
        }

        options.onProgress?.('Stopping auto-save', 0, 1);
        this.sqliteCache.stopAutoSave();

        options.onProgress?.('Closing cache', 0, 1);
        await this.sqliteCache.close();

        options.onProgress?.('Removing cache blob', 0, 1);
        await this.cacheBlobStore.remove();

        options.onProgress?.('Reopening cache', 0, 1);
        await this.sqliteCache.initialize();

        if (!this.syncCoordinator) {
          throw new Error('Sync coordinator unavailable; cannot rebuild from JSONL');
        }

        options.onProgress?.('Rebuilding from JSONL', 0, 1);
        const result = await this.syncCoordinator.fullRebuild({
          onProgress: options.onProgress
        });

        if (!result.success) {
          const summary = result.errors.length > 0 ? result.errors.join('; ') : 'Unknown error';
          throw new Error(`Cache rebuild failed: ${summary}`);
        }

        options.onProgress?.('Complete', 1, 1);
      } finally {
        // Clear on both success and failure so a follow-up rebuild can
        // re-run; the original error (if any) still rejects this promise.
        this.rebuildInFlight = null;
      }
    })();

    return this.rebuildInFlight;
  }

  // ============================================================================
  // External sync: vault-event-driven reconciliation
  // ============================================================================

  /**
   * Subscribe to external-sync events. Fired after the JSONL vault watcher
   * detects a change (e.g. a Sync-pushed JSONL from another device) and
   * the resulting reconciliation has been applied to SQLite. Subscribers
   * use the `modified` stream list to decide whether their currently-viewed
   * content needs to re-query.
   *
   * Returns an Obsidian EventRef. Pass it to `offExternalSync()` (or use
   * the plugin's `registerEvent(ref)` for auto-cleanup on unload).
   */
  onExternalSync(callback: (event: ExternalSyncEvent) => void): EventRef {
    // Obsidian's Events.on takes a variadic `unknown[]` handler; we narrow
    // here by wrapping so callers get a typed API.
    return this.externalEvents.on('external-sync', (...data: unknown[]) => {
      callback(data[0] as ExternalSyncEvent);
    });
  }

  /** Remove a subscription previously added via `onExternalSync`. */
  offExternalSync(ref: EventRef): void {
    this.externalEvents.offref(ref);
  }

  /**
   * Start the JSONL vault watcher. Idempotent. Wires the before-write hook
   * on `JSONLWriter` so self-writes don't echo back as sync triggers.
   */
  private startJsonlVaultWatcher(): void {
    if (this.jsonlVaultWatcher) {
      return;
    }

    const watcher = new JsonlVaultWatcher({
      app: this.app,
      dataPath: this.basePath,
      onChange: async (modified) => {
        await this.handleExternalJsonlChange(modified);
      }
    });

    this.jsonlVaultWatcher = watcher;
    this.jsonlWriter.setBeforeWriteHook((logicalPath) => {
      watcher.suppressLogicalPath(logicalPath);
    });

    watcher.start();
  }

  /**
   * Stop the watcher and tear down its hook. Safe if never started.
   */
  private stopJsonlVaultWatcher(): void {
    if (!this.jsonlVaultWatcher) {
      return;
    }
    this.jsonlWriter.setBeforeWriteHook(undefined);
    this.jsonlVaultWatcher.stop();
    this.jsonlVaultWatcher = undefined;
  }

  /**
   * Reconcile after the watcher detects a modified stream set and emit
   * `external-sync` so open UI can refresh only the affected content.
   * Called by JsonlVaultWatcher's onChange callback.
   *
   * Phase 1 sync-safe reconcile: when the ReconcilePipeline is wired, scope
   * reconcile to the precise streams that fired the modify event instead of
   * sweeping the whole cache. Falls back to a full `sync()` if the pipeline
   * isn't yet wired (e.g. legacy plugin-scoped storage layout) so behavior
   * stays compatible.
   */
  private async handleExternalJsonlChange(modified: ModifiedStream[]): Promise<void> {
    if (modified.length === 0) {
      return;
    }
    try {
      let result: SyncResult;
      if (this.reconcilePipeline) {
        for (const m of modified) {
          await this.syncCoordinator.reconcileStream(m.category, m.streamId);
        }
        await this.runMissingEntityReconcilers();
        this.queryCache.clear();
        result = {
          success: true,
          eventsApplied: 0,
          eventsSkipped: 0,
          errors: [],
          duration: 0,
          filesProcessed: modified.map((m) => m.samplePath),
          lastSyncTimestamp: Date.now()
        };
      } else {
        result = await this.sync();
      }
      this.externalEvents.trigger('external-sync', { result, modified } satisfies ExternalSyncEvent);
    } catch (error) {
      console.error('[HybridStorageAdapter] External JSONL change sync failed:', error);
    }
  }

  /**
   * Run the post-sync entity-existence reconcilers (workspaces, conversations,
   * tasks). Mirrors the existing `sync()` post-step so scoped reconcile via
   * `ReconcilePipeline` stays semantically equivalent to the full sweep for
   * cache-fill purposes. Errors are logged but do not propagate.
   */
  private async runMissingEntityReconcilers(): Promise<void> {
    try {
      await Promise.all([
        this.reconcileMissingWorkspaces(),
        this.reconcileMissingConversations(),
        this.reconcileMissingTasks()
      ]);
    } catch (reconcileError) {
      console.error('[HybridStorageAdapter] Post-sync reconciliation failed:', reconcileError);
    }
  }

  async sync(): Promise<SyncResult> {
    try {
      const result = await this.syncCoordinator.sync();

      try {
        await Promise.all([
          this.reconcileMissingWorkspaces(),
          this.reconcileMissingConversations(),
          this.reconcileMissingTasks()
        ]);
      } catch (reconcileError) {
        console.error('[HybridStorageAdapter] Post-sync reconciliation failed:', reconcileError);
      }

      // Invalidate all query cache on sync
      this.queryCache.clear();

      return result;

    } catch (error) {
      console.error('[HybridStorageAdapter] Sync failed:', error);
      throw error;
    }
  }

  /**
   * Relocate the vault-root event store to a new path.
   *
   * Copies all events from the current store to the destination, verifies
   * integrity, then hot-swaps internal state so all subsequent reads and
   * writes use the new location. Returns `switched: true` only when the
   * swap completed successfully.
   */
  async relocateVaultRoot(
    targetRootPath: string,
    options?: { maxShardBytes?: number }
  ): Promise<VaultRootRelocationResult & { switched: boolean }> {
    if (!this.vaultEventStore) {
      return {
        success: false,
        verified: false,
        relation: 'conflict',
        durationMs: 0,
        sourceRootPath: '',
        destinationRootPath: targetRootPath,
        sourceStreamCount: 0,
        destinationStreamCountBefore: 0,
        destinationStreamCountAfter: 0,
        copiedEventCount: 0,
        skippedEventCount: 0,
        fileResults: [],
        conflicts: [],
        errors: ['Vault event store is not initialized.'],
        switched: false
      };
    }

    const maxShardBytes = options?.maxShardBytes ?? DEFAULT_STORAGE_SETTINGS.maxShardBytes;

    const relocationService = new VaultRootRelocationService({
      app: this.app,
      sourceStore: this.vaultEventStore,
      targetRootPath,
      maxShardBytes
    });

    const result = await relocationService.relocateVaultRoot();

    if (!result.success || !result.verified || !result.destinationStore) {
      return { ...result, switched: false };
    }

    const resolution = resolveVaultRoot(
      { storage: { rootPath: targetRootPath, maxShardBytes } },
      { configDir: this.app.vault.configDir }
    );

    this.vaultEventStore = result.destinationStore;
    this.basePath = resolution.dataPath;
    this.jsonlWriter.setBasePath(resolution.dataPath);
    this.jsonlWriter.setVaultEventStore(this.vaultEventStore);
    this.jsonlWriter.setVaultEventStoreReadEnabled(true);
    this.jsonlVaultWatcher?.setDataPath(resolution.dataPath);
    this.wireReconcilePipeline();
    this.queryCache.clear();

    return { ...result, switched: true };
  }

  // ============================================================================
  // Workspace Operations - Delegate to WorkspaceRepository
  // ============================================================================

  getWorkspace = async (id: string): Promise<WorkspaceMetadata | null> => {
    await this.ensureInitialized();
    return this.workspaceRepo.getById(id);
  };

  getWorkspaces = async (options?: QueryOptions): Promise<PaginatedResult<WorkspaceMetadata>> => {
    await this.ensureInitialized();
    return this.workspaceRepo.getWorkspaces(options);
  };

  createWorkspace = async (workspace: Omit<WorkspaceMetadata, 'id'> & { id?: string }): Promise<string> => {
    await this.ensureInitialized();
    return this.workspaceRepo.create(workspace);
  };

  updateWorkspace = async (id: string, updates: Partial<WorkspaceMetadata>): Promise<void> => {
    await this.ensureInitialized();
    return this.workspaceRepo.update(id, updates);
  };

  deleteWorkspace = async (id: string): Promise<void> => {
    await this.ensureInitialized();
    return this.workspaceRepo.delete(id);
  };

  searchWorkspaces = async (query: string): Promise<WorkspaceMetadata[]> => {
    await this.ensureInitialized();
    return this.workspaceRepo.search(query);
  };

  // ============================================================================
  // Session Operations - Delegate to SessionRepository
  // ============================================================================

  getSession = async (id: string): Promise<SessionMetadata | null> => {
    await this.ensureInitialized();
    return this.sessionRepo.getById(id);
  };

  getSessions = async (workspaceId: string, options?: PaginationParams): Promise<PaginatedResult<SessionMetadata>> => {
    await this.ensureInitialized();
    return this.sessionRepo.getByWorkspaceId(workspaceId, options);
  };

  createSession = async (workspaceId: string, session: Omit<SessionMetadata, 'id' | 'workspaceId'> & { id?: string }): Promise<string> => {
    await this.ensureInitialized();
    return this.sessionRepo.create({ ...session, workspaceId });
  };

  updateSession = async (workspaceId: string, sessionId: string, updates: Partial<SessionMetadata>): Promise<void> => {
    await this.ensureInitialized();
    // Extract fields that are valid for UpdateSessionData (includes required workspaceId)
    const { name, description, endTime, isActive } = updates;
    return this.sessionRepo.update(sessionId, { name, description, endTime, isActive, workspaceId });
  };

  moveSessionToWorkspace = async (sessionId: string, workspaceId: string): Promise<void> => {
    await this.ensureInitialized();
    return this.sessionRepo.moveToWorkspace(sessionId, workspaceId);
  };

  deleteSession = async (sessionId: string): Promise<void> => {
    await this.ensureInitialized();
    return this.sessionRepo.delete(sessionId);
  };

  // ============================================================================
  // State Operations - Delegate to StateRepository
  // ============================================================================

  getState = async (id: string): Promise<StateData | null> => {
    await this.ensureInitialized();
    return this.stateRepo.getStateData(id);
  };

  getStates = async (
    workspaceId: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<StateMetadata>> => {
    await this.ensureInitialized();
    return this.stateRepo.getStates(workspaceId, sessionId, options);
  };

  saveState = async (
    workspaceId: string,
    sessionId: string,
    state: Omit<StateData, 'id' | 'workspaceId' | 'sessionId'>
  ): Promise<string> => {
    await this.ensureInitialized();
    return this.stateRepo.saveState(workspaceId, sessionId, state);
  };

  updateState = async (
    id: string,
    updates: {
      name?: string;
      description?: string;
      tags?: string[];
      content?: unknown;
    }
  ): Promise<void> => {
    await this.ensureInitialized();
    return this.stateRepo.updateState(id, updates);
  };

  deleteState = async (id: string): Promise<void> => {
    await this.ensureInitialized();
    return this.stateRepo.delete(id);
  };

  countStates = async (workspaceId: string, sessionId?: string): Promise<number> => {
    await this.ensureInitialized();
    return this.stateRepo.countStates(workspaceId, sessionId);
  };

  // ============================================================================
  // Trace Operations - Delegate to TraceRepository
  // ============================================================================

  getTraces = async (
    workspaceId: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MemoryTraceData>> => {
    await this.ensureInitialized();
    return this.traceRepo.getTraces(workspaceId, sessionId, options);
  };

  addTrace = async (
    workspaceId: string,
    sessionId: string,
    trace: Omit<MemoryTraceData, 'id' | 'workspaceId' | 'sessionId'>
  ): Promise<string> => {
    await this.ensureInitialized();
    return this.traceRepo.addTrace(workspaceId, sessionId, trace);
  };

  searchTraces = async (
    workspaceId: string,
    query: string,
    sessionId?: string
  ): Promise<MemoryTraceData[]> => {
    await this.ensureInitialized();
    // Repository returns paginated, but interface expects array
    const result = await this.traceRepo.searchTraces(workspaceId, query, sessionId);
    return result.items;
  };

  // ============================================================================
  // Conversation Operations - Delegate to ConversationRepository
  // ============================================================================

  getConversation = async (id: string): Promise<ConversationMetadata | null> => {
    await this.ensureInitialized();
    return this.conversationRepo.getById(id);
  };

  getConversations = async (options?: QueryOptions): Promise<PaginatedResult<ConversationMetadata>> => {
    await this.ensureInitialized();
    return this.conversationRepo.getConversations(options);
  };

  createConversation = async (params: Omit<ConversationMetadata, 'id' | 'messageCount'>): Promise<string> => {
    await this.ensureInitialized();
    return this.conversationRepo.create(params);
  };

  updateConversation = async (id: string, updates: Partial<ConversationMetadata>): Promise<void> => {
    await this.ensureInitialized();
    return this.conversationRepo.update(id, updates);
  };

  deleteConversation = async (id: string): Promise<void> => {
    await this.ensureInitialized();

    // Cascade delete: find and delete any child branch conversations
    const branches = await this.conversationRepo.getConversations({
      pageSize: 100,
      includeBranches: true
    });

    for (const branch of branches.items) {
      if (branch.metadata?.parentConversationId === id) {
        // Recursively delete child branches (they may have their own branches)
        await this.deleteConversation(branch.id);
      }
    }

    // Now delete the conversation itself
    return this.conversationRepo.delete(id);
  };

  searchConversations = async (query: string): Promise<ConversationMetadata[]> => {
    await this.ensureInitialized();
    return this.conversationRepo.search(query);
  };

  // ============================================================================
  // Message Operations - Delegate to MessageRepository
  // ============================================================================

  getMessages = async (
    conversationId: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MessageData>> => {
    await this.ensureInitialized();
    return this.messageRepo.getMessages(conversationId, options);
  };

  addMessage = async (
    conversationId: string,
    message: Omit<MessageData, 'id' | 'conversationId' | 'sequenceNumber'> & { id?: string }
  ): Promise<string> => {
    await this.ensureInitialized();
    return this.messageRepo.addMessage(conversationId, message);
  };

  updateMessage = async (
    _conversationId: string,
    messageId: string,
    updates: Partial<MessageData>
  ): Promise<void> => {
    await this.ensureInitialized();
    return this.messageRepo.update(messageId, updates);
  };

  deleteMessage = async (conversationId: string, messageId: string): Promise<void> => {
    await this.ensureInitialized();

    // Cascade delete: find and delete any branch conversations tied to this message
    const branches = await this.conversationRepo.getConversations({
      pageSize: 100,
      includeBranches: true
    });

    for (const branch of branches.items) {
      if (branch.metadata?.parentMessageId === messageId) {
        await this.deleteConversation(branch.id);
      }
    }

    // Now delete the message itself
    return this.messageRepo.deleteMessage(conversationId, messageId);
  };

  // ============================================================================
  // Export/Import Operations - Delegate to ExportService
  // ============================================================================

  exportConversationsForFineTuning = async (filter?: ExportFilter): Promise<string> => {
    await this.ensureInitialized();
    return this.exportService.exportForFineTuning(filter);
  };

  exportAllData = async (): Promise<ExportData> => {
    await this.ensureInitialized();
    return this.exportService.exportAllData();
  };

  async importData(_data: ExportData, _options?: ImportOptions): Promise<void> {
    await this.ensureInitialized();
    // TODO: Implement importData in ExportService
    throw new Error('importData not yet implemented');
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Ensure the adapter is initialized before use.
   * If initialization is in progress, waits for it to complete.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initLifecycle.isReady()) {
      return;
    }
    if (!this.initLifecycle.hasStarted()) {
      throw new Error('HybridStorageAdapter not initialized. Call initialize() first.');
    }
    const ok = await this.initLifecycle.waitForReady();
    if (!ok) {
      throw this.initLifecycle.getError() ?? new Error('HybridStorageAdapter initialization failed.');
    }
  }
}
