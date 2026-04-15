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
  PluginScopedMigrationState,
  PluginScopedStorageState,
  PluginScopedStoragePlan
} from '../migration/PluginScopedStorageCoordinator';
import { VaultRootMigrationService } from '../migration/VaultRootMigrationService';
import {
  VaultRootRelocationService,
  type VaultRootRelocationResult
} from '../migration/VaultRootRelocationService';
import { resolvePluginStorageRoot } from '../storage/PluginStoragePathResolver';
import { resolveVaultRoot } from '../storage/VaultRootResolver';
import { VaultEventStore } from '../storage/vaultRoot/VaultEventStore';
import { DEFAULT_STORAGE_SETTINGS } from '../../types/plugin/PluginTypes';

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
}

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

export interface StartupHydrationState {
  phase: 'idle' | 'running' | 'complete' | 'error';
  isBlocking: boolean;
  stage: string;
  progress: number;
  total: number;
  percent: number;
  statusText: string;
  error?: string;
}

export function shouldBlockStartupHydrationForVerifiedCutover(input: {
  migrationState: PluginScopedMigrationState;
  sourceOfTruthLocation: PluginScopedStorageState['sourceOfTruthLocation'];
  conversationFileCount: number;
  cachedConversationCount: number;
  cachedMessageCount: number;
}): boolean {
  return input.migrationState === 'verified'
    && input.sourceOfTruthLocation === 'vault-root'
    && input.conversationFileCount > 0
    && input.cachedConversationCount === 0
    && input.cachedMessageCount === 0;
}

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
  private initialized = false;
  private syncInterval?: NodeJS.Timeout;
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
  private startupHydrationState: StartupHydrationState = {
    phase: 'idle',
    isBlocking: false,
    stage: '',
    progress: 0,
    total: 0,
    percent: 0,
    statusText: ''
  };

  // Deferred initialization support
  private initPromise: Promise<void> | null = null;
  private initResolve: (() => void) | null = null;
  private initError: Error | null = null;

  // Infrastructure (owned by adapter)
  private jsonlWriter: JSONLWriter;
  private sqliteCache: SQLiteCacheManager;
  private syncCoordinator: SyncCoordinator;
  private queryCache: QueryCache;
  private storageCoordinator: PluginScopedStorageCoordinator;
  private vaultEventStore: VaultEventStore | null = null;

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
    const storageRoots = resolvePluginStorageRoot(this.app, this.plugin);
    this.storageCoordinator = new PluginScopedStorageCoordinator(this.app, this.plugin, this.basePath);

    // Initialize infrastructure
    this.jsonlWriter = new JSONLWriter({
      app: this.app,
      basePath: this.basePath
    });

    this.sqliteCache = new SQLiteCacheManager({
      app: this.app,
      dbPath: `${storageRoots.dataRoot}/cache.db`,
      wasmPath: `${storageRoots.pluginDir}/sqlite3.wasm`
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
   * Initialize the storage adapter.
   * By default, starts initialization in background and returns immediately.
   * Use waitForReady() to wait for completion if needed.
   *
   * @param blocking - If true, waits for initialization to complete before returning
   */
  async initialize(blocking = false): Promise<void> {
    if (this.initialized) {
      return;
    }

    // If already initializing, optionally wait for it
    if (this.initPromise) {
      if (blocking) {
        await this.initPromise;
      }
      return;
    }

    // Create the promise that will resolve when initialization completes
    this.initPromise = new Promise<void>((resolve) => {
      this.initResolve = resolve;
    });

    // Start initialization in background
    this.performInitialization().catch((error: unknown) => {
      this.initError = error instanceof Error ? error : new Error(String(error));
      console.error('[HybridStorageAdapter] Background initialization failed:', error);
    });

    // If blocking mode, wait for completion
    if (blocking) {
      await this.initPromise;
      if (this.initError) {
        throw this.initError;
      }
    }
  }

  /**
   * Perform the actual initialization work
   */
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

      // 1. Initialize SQLite cache
      await this.sqliteCache.initialize();

      const shouldBlockStartupHydration = await this.shouldBlockStartupHydration(storagePlan);
      if (shouldBlockStartupHydration) {
        this.startBlockingStartupHydration();
      } else {
        this.clearStartupHydrationState();
      }

      // 2. Ensure JSONL directories exist
      await this.jsonlWriter.ensureDirectory('workspaces');
      await this.jsonlWriter.ensureDirectory('conversations');
      await this.jsonlWriter.ensureDirectory('tasks');

      // Mark as initialized BEFORE sync so the UI isn't blocked.
      // SQLite schema is ready — sync populates data in the background.
      this.initialized = true;
      if (this.initResolve) {
        this.initResolve();
      }

      // 4. Perform initial sync (rebuild cache from JSONL) in background
      // This can take a long time for large vaults (168MB+ JSONL files).
      // The UI will show incrementally as data syncs in.
      const syncState = await this.sqliteCache.getSyncState(this.jsonlWriter.getDeviceId());
      if (!syncState || actuallyMigrated || shouldBlockStartupHydration) {
        try {
          await this.syncCoordinator.fullRebuild({
            onProgress: (stage, progress, total) => {
              this.updateStartupHydrationProgress(stage, progress, total, shouldBlockStartupHydration);
            }
          });
        } catch (rebuildError) {
          console.error('[HybridStorageAdapter] Full rebuild failed:', rebuildError);
          this.failStartupHydration(rebuildError instanceof Error ? rebuildError.message : String(rebuildError));
        }
      } else {
        try {
          await this.syncCoordinator.sync();
        } catch (syncError) {
          console.error('[HybridStorageAdapter] Incremental sync failed:', syncError);
        }

        // 5. Reconcile JSONL workspaces missing from SQLite
        try {
          await this.reconcileMissingWorkspaces();
        } catch (reconcileError) {
          console.error('[HybridStorageAdapter] Workspace reconciliation failed:', reconcileError);
        }

        // 6. Reconcile JSONL conversations missing from SQLite
        try {
          await this.reconcileMissingConversations();
        } catch (reconcileError) {
          console.error('[HybridStorageAdapter] Conversation reconciliation failed:', reconcileError);
        }

        // 7. Reconcile JSONL tasks missing from SQLite
        try {
          await this.reconcileMissingTasks();
        } catch (reconcileError) {
          console.error('[HybridStorageAdapter] Task reconciliation failed:', reconcileError);
        }
      }

      if (shouldBlockStartupHydration && this.startupHydrationState.phase !== 'error') {
        this.completeStartupHydration();
      }

      // Watch the plugin data folder for JSONL changes landed by Obsidian
      // Sync (or external tools). When something changes, reconcile SQLite
      // and emit `external-sync` so open views can refresh.
      this.startJsonlVaultWatcher();
    } catch (error) {
      console.error('[HybridStorageAdapter] Initialization failed:', error);
      this.initError = error as Error;
      if (this.initResolve) {
        this.initResolve(); // Resolve even on error so waiters don't hang
      }
      throw error;
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

  private startBlockingStartupHydration(): void {
    this.startupHydrationState = {
      phase: 'running',
      isBlocking: true,
      stage: 'Preparing cache rebuild',
      progress: 0,
      total: 1,
      percent: 0,
      statusText: 'Updating local chat index...'
    };
  }

  private updateStartupHydrationProgress(
    stage: string,
    progress: number,
    total: number,
    isBlocking: boolean
  ): void {
    const safeTotal = total > 0 ? total : 1;
    const normalizedProgress = Math.max(0, Math.min(progress, safeTotal));
    this.startupHydrationState = {
      phase: 'running',
      isBlocking,
      stage,
      progress: normalizedProgress,
      total: safeTotal,
      percent: Math.round((normalizedProgress / safeTotal) * 100),
      statusText: stage === 'Complete'
        ? 'Local chat index updated'
        : `Updating local chat index: ${stage}`
    };
  }

  private completeStartupHydration(): void {
    this.startupHydrationState = {
      phase: 'complete',
      isBlocking: false,
      stage: 'Complete',
      progress: 1,
      total: 1,
      percent: 100,
      statusText: 'Local chat index updated'
    };
  }

  private failStartupHydration(error: string): void {
    this.startupHydrationState = {
      phase: 'error',
      isBlocking: false,
      stage: 'Error',
      progress: 0,
      total: 1,
      percent: 0,
      statusText: 'Local chat index update failed',
      error
    };
  }

  private clearStartupHydrationState(): void {
    this.startupHydrationState = {
      phase: 'idle',
      isBlocking: false,
      stage: '',
      progress: 0,
      total: 0,
      percent: 0,
      statusText: ''
    };
  }

  /**
   * Reconcile JSONL workspace files that are missing from SQLite.
   * This handles the case where incremental sync skips same-device events,
   * leaving workspaces in JSONL but absent from the SQLite cache.
   */
  private async reconcileMissingWorkspaces(): Promise<number> {
    const workspaceFiles = await this.jsonlWriter.listFiles('workspaces');
    if (workspaceFiles.length === 0) return 0;

    // Extract workspace IDs from filenames (pattern: workspaces/ws_{id}.jsonl)
    const jsonlWorkspaceIds: { id: string; file: string }[] = [];
    for (const file of workspaceFiles) {
      const match = file.match(/workspaces\/ws_(.+)\.jsonl$/);
      if (match) {
        jsonlWorkspaceIds.push({ id: match[1], file });
      }
    }

    if (jsonlWorkspaceIds.length === 0) return 0;

    // Check which IDs are missing from SQLite
    const workspaceApplier = new WorkspaceEventApplier(this.sqliteCache);
    let reconciled = 0;

    for (const { id, file } of jsonlWorkspaceIds) {
      const existing = await this.workspaceRepo.getById(id);
      if (existing) continue;

      // Missing from SQLite — replay all events from this JSONL file
      try {
        const events = await this.jsonlWriter.readEvents<WorkspaceEvent>(file);
        events.sort((a, b) => a.timestamp - b.timestamp);
        // Skip deleted workspaces — no need to create then immediately delete
        const hasDeleteEvent = events.some(e => e.type === 'workspace_deleted');
        if (hasDeleteEvent) continue;

        // Skip files with no workspace_created event (corrupt/incomplete)
        const hasCreateEvent = events.some(e => e.type === 'workspace_created');
        if (!hasCreateEvent) continue;

        for (const event of events) {
          await workspaceApplier.apply(event);
        }
        reconciled++;
      } catch (e) {
        console.error(`[HybridStorageAdapter] Failed to reconcile workspace ${id}:`, e);
      }
    }

    if (reconciled > 0) {
      await this.sqliteCache.save();
    }
    return reconciled;
  }

  /**
   * Reconcile JSONL conversation files that are missing from SQLite.
   * This handles the case where incremental sync skips remote files because
   * their event timestamps predate the local sync watermark.
   */
  private async reconcileMissingConversations(): Promise<number> {
    const conversationFiles = await this.jsonlWriter.listFiles('conversations');
    if (conversationFiles.length === 0) return 0;

    const conversationApplier = new ConversationEventApplier(this.sqliteCache);
    let reconciled = 0;

    for (const file of conversationFiles) {
      const match = file.match(/conversations\/conv_(.+)\.jsonl$/);
      if (!match) continue;

      const conversationId = match[1];
      const existing = await this.conversationRepo.getById(conversationId);
      if (existing) continue;

      try {
        const events = await this.jsonlWriter.readEvents<ConversationEvent>(file);
        events.sort((a, b) => a.timestamp - b.timestamp);

        // Skip deleted conversations — no need to create then immediately delete
        const hasDeleteEvent = events.some(e => e.type === 'conversation_deleted');
        if (hasDeleteEvent) continue;

        const hasMetadataEvent = events.some(event => event.type === 'metadata');
        if (!hasMetadataEvent) continue;

        for (const event of events) {
          await conversationApplier.apply(event);
        }
        reconciled++;
      } catch (e) {
        console.error(`[HybridStorageAdapter] Failed to reconcile conversation ${conversationId}:`, e);
      }
    }

    if (reconciled > 0) {
      await this.sqliteCache.save();
    }
    return reconciled;
  }

  /**
   * Reconcile JSONL task files that are missing from SQLite.
   * Handles the case where incremental sync skips same-device events,
   * leaving tasks in JSONL but absent from the SQLite cache.
   */
  private async reconcileMissingTasks(): Promise<number> {
    const taskFiles = await this.jsonlWriter.listFiles('tasks');
    if (taskFiles.length === 0) return 0;

    const taskApplier = new TaskEventApplier(this.sqliteCache);
    let reconciled = 0;

    for (const file of taskFiles) {
      // Extract workspaceId from filename (pattern: tasks/tasks_{workspaceId}.jsonl)
      const match = file.match(/tasks\/tasks_(.+)\.jsonl$/);
      if (!match) continue;

      const fileWorkspaceId = match[1];

      // Resolve workspace ID (handles name → UUID transparently)
      const resolved = await resolveWorkspaceId(fileWorkspaceId, this.sqliteCache);
      const effectiveId = resolved.id ?? fileWorkspaceId;

      // Check if any projects already exist for this workspace in SQLite
      const existingProjects = await this.sqliteCache.query<{ id: string }>(
        'SELECT id FROM projects WHERE workspaceId = ? LIMIT 1',
        [effectiveId]
      );

      if (existingProjects.length > 0) continue;

      // No projects found for this workspace — replay all events from JSONL
      try {
        const events = await this.jsonlWriter.readEvents<TaskEvent>(file);
        events.sort((a, b) => a.timestamp - b.timestamp);

        for (const event of events) {
          await taskApplier.apply(event);
        }
        reconciled++;
      } catch (e) {
        console.error(`[HybridStorageAdapter] Failed to reconcile tasks from ${file}:`, e);
      }
    }

    if (reconciled > 0) {
      await this.sqliteCache.save();
    }
    return reconciled;
  }

  /**
   * Check if the adapter is ready for use
   */
  isReady(): boolean {
    return this.initialized && !this.initError;
  }

  isQueryReady(): boolean {
    if (!this.isReady()) {
      return false;
    }

    return this.startupHydrationState.phase !== 'running' && this.startupHydrationState.phase !== 'error';
  }

  /**
   * Wait for initialization to complete
   * @returns true if initialization succeeded, false if it failed
   */
  async waitForReady(): Promise<boolean> {
    if (this.initialized) {
      return !this.initError;
    }
    if (this.initPromise) {
      await this.initPromise;
    }
    return this.initialized && !this.initError;
  }

  async waitForQueryReady(maxWaitMs = 60_000): Promise<boolean> {
    const ready = await this.waitForReady();
    if (!ready) {
      return false;
    }

    const deadline = Date.now() + maxWaitMs;
    while (this.startupHydrationState.phase === 'running') {
      if (Date.now() >= deadline) {
        console.error('[HybridStorageAdapter] waitForQueryReady timed out after', maxWaitMs, 'ms');
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    return this.isQueryReady();
  }

  /**
   * Get initialization error if any
   */
  getInitError(): Error | null {
    return this.initError;
  }

  /**
   * Get the underlying SQLite cache manager
   * Used by EmbeddingManager for vector storage
   */
  get cache(): SQLiteCacheManager {
    return this.sqliteCache;
  }

  getStartupHydrationState(): StartupHydrationState {
    return { ...this.startupHydrationState };
  }

  isStartupHydrationBlocking(): boolean {
    return this.startupHydrationState.phase === 'running' && this.startupHydrationState.isBlocking;
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
    if (!this.initialized) {
      return;
    }

    try {
      // Stop sync timer
      if (this.syncInterval) {
        clearInterval(this.syncInterval);
        this.syncInterval = undefined;
      }

      // Stop the JSONL vault watcher and its before-write hook on the writer.
      this.stopJsonlVaultWatcher();

      // Clear query cache
      this.queryCache.clear();

      // Close SQLite
      await this.sqliteCache.close();

      this.initialized = false;

    } catch (error) {
      console.error('[HybridStorageAdapter] Error during close:', error);
      throw error;
    }
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
   */
  private async handleExternalJsonlChange(modified: ModifiedStream[]): Promise<void> {
    if (modified.length === 0) {
      return;
    }
    try {
      const result = await this.sync();
      this.externalEvents.trigger('external-sync', { result, modified } satisfies ExternalSyncEvent);
    } catch (error) {
      console.error('[HybridStorageAdapter] External JSONL change sync failed:', error);
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

  createSession = async (workspaceId: string, session: Omit<SessionMetadata, 'id' | 'workspaceId'>): Promise<string> => {
    await this.ensureInitialized();
    return this.sessionRepo.create({ ...session, workspaceId });
  };

  updateSession = async (workspaceId: string, sessionId: string, updates: Partial<SessionMetadata>): Promise<void> => {
    await this.ensureInitialized();
    // Extract fields that are valid for UpdateSessionData (includes required workspaceId)
    const { name, description, endTime, isActive } = updates;
    return this.sessionRepo.update(sessionId, { name, description, endTime, isActive, workspaceId });
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
    if (this.initialized) {
      return;
    }

    // If initialization is in progress, wait for it
    if (this.initPromise) {
      await this.initPromise;
      if (this.initError) {
        throw this.initError;
      }
      if (!this.initialized) {
        throw new Error('HybridStorageAdapter initialization failed.');
      }
      return;
    }

    throw new Error('HybridStorageAdapter not initialized. Call initialize() first.');
  }
}
