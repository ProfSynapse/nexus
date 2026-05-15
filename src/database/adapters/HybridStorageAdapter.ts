/**
 * Location: src/database/adapters/HybridStorageAdapter.ts
 *
 * Hybrid Storage Adapter — facade over JSONL (source of truth) + SQLite (cache).
 *
 * SOLID layout (May 2026 refactor):
 * - Composition root: lifecycle/StorageAdapterAssembler builds infrastructure.
 * - Init saga: lifecycle/StorageInitializationPipeline runs ordered steps.
 * - Plan + cache-backend wiring: lifecycle/StoragePlanApplier.
 * - Missing-entity reconcile: lifecycle/MissingEntityReconcilers (registry).
 * - External JSONL watcher + events: lifecycle/ExternalSyncController.
 * - Rebuild cache: lifecycle/CacheRebuildOperation (coalesced).
 * - Vault-root relocate: lifecycle/VaultRootRelocator.
 *
 * What stays on this class:
 * - Public IStorageAdapter surface (delegation to repositories).
 * - Lifecycle state queries (isReady, waitForQueryReady, getInitError).
 * - Subscription pass-throughs for external sync events.
 * - Thin pass-throughs for a handful of private methods that unit tests
 *   pin by name (applyStoragePlan, runCacheBackendMigration,
 *   reconcileMissing{Workspaces,Conversations,Tasks}).
 *
 * Related Files:
 * - src/database/repositories/* - Entity repositories
 * - src/database/services/* - Business services
 * - src/database/adapters/lifecycle/* - Adapter sub-components
 * - src/database/interfaces/IStorageAdapter.ts - Interface (now segregated)
 */

import { App, EventRef, Plugin } from 'obsidian';
import { IStorageAdapter, QueryOptions, ImportOptions } from '../interfaces/IStorageAdapter';
import { JSONLWriter } from '../storage/JSONLWriter';
import { SQLiteCacheManager } from '../storage/SQLiteCacheManager';
import { SyncCoordinator } from '../sync/SyncCoordinator';
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
import {
  PluginScopedStorageCoordinator,
  PluginScopedStoragePlan
} from '../migration/PluginScopedStorageCoordinator';
import type { CacheBlobStore } from '../storage/CacheBlobStore';
import {
  StartupHydrationController,
  type StartupHydrationState,
  shouldBlockStartupHydrationForVerifiedCutover
} from './lifecycle/StartupHydrationController';
import { InitLifecycleController } from './lifecycle/InitLifecycleController';
import { ReconciliationCoordinator } from './lifecycle/ReconciliationCoordinator';
import { VaultEventStore } from '../storage/vaultRoot/VaultEventStore';
import { type VaultRootRelocationResult } from '../migration/VaultRootRelocationService';
import { assembleStorageAdapter } from './lifecycle/StorageAdapterAssembler';
import { StoragePlanApplier } from './lifecycle/StoragePlanApplier';
import { MissingEntityReconcilerRunner } from './lifecycle/MissingEntityReconcilers';
import { ExternalSyncController, type ExternalSyncEvent } from './lifecycle/ExternalSyncController';
import { CacheRebuildOperation } from './lifecycle/CacheRebuildOperation';
import { VaultRootRelocator } from './lifecycle/VaultRootRelocator';
import { StorageInitializationPipeline } from './lifecycle/StorageInitializationPipeline';

// Repository types (referenced by getter return types)
import { MessageRepository } from '../repositories/MessageRepository';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { TaskRepository } from '../repositories/TaskRepository';
import { WorkspaceRepository } from '../repositories/WorkspaceRepository';
import { SessionRepository } from '../repositories/SessionRepository';
import { StateRepository } from '../repositories/StateRepository';
import { TraceRepository } from '../repositories/TraceRepository';
import { ConversationRepository } from '../repositories/ConversationRepository';
import { ExportService } from '../services/ExportService';

/**
 * Configuration options for HybridStorageAdapter
 */
export interface HybridStorageAdapterOptions {
  app: App;
  plugin: Plugin;
  /** Base path for storage (default: '.nexus') */
  basePath?: string;
  /** Auto-sync on initialization (default: true). Reserved for future use. */
  autoSync?: boolean;
  /** Query cache TTL in ms (default: 60000) */
  cacheTTL?: number;
  /** Query cache max size (default: 500) */
  cacheMaxSize?: number;
}

export { ExternalSyncEvent, StartupHydrationState, shouldBlockStartupHydrationForVerifiedCutover };

/**
 * Hybrid Storage Adapter — thin facade. Implementation logic lives in
 * `./lifecycle/*` modules; this class wires them together and exposes
 * the IStorageAdapter surface.
 */
export class HybridStorageAdapter implements IStorageAdapter {
  private app: App;
  private plugin: Plugin;
  private basePath: string;

  // Lifecycle state machines
  private readonly hydration = new StartupHydrationController();
  private readonly initLifecycle = new InitLifecycleController();

  // Infrastructure (assembled at construction)
  private jsonlWriter: JSONLWriter;
  private sqliteCache: SQLiteCacheManager;
  private syncCoordinator: SyncCoordinator;
  private queryCache: QueryCache;
  private storageCoordinator: PluginScopedStorageCoordinator;
  private cacheBlobStore: CacheBlobStore;

  // Adapter-managed state that crosses sub-components
  private vaultEventStore: VaultEventStore | null = null;
  private reconcilePipeline: ReconcilePipeline | null = null;
  private reconciliationCoordinator!: ReconciliationCoordinator;

  // Repositories (composed via the assembler)
  private workspaceRepo: WorkspaceRepository;
  private sessionRepo: SessionRepository;
  private stateRepo: StateRepository;
  private traceRepo: TraceRepository;
  private conversationRepo: ConversationRepository;
  private messageRepo: MessageRepository;
  private projectRepo: ProjectRepository;
  private taskRepo: TaskRepository;
  private exportService: ExportService;

  // Sub-components
  private planApplier: StoragePlanApplier;
  private reconcilers: MissingEntityReconcilerRunner;
  private externalSync: ExternalSyncController;
  private cacheRebuild: CacheRebuildOperation;
  private vaultRootRelocator: VaultRootRelocator;

  constructor(options: HybridStorageAdapterOptions) {
    this.app = options.app;
    this.plugin = options.plugin;
    this.basePath = options.basePath ?? '.nexus';

    const bundle = assembleStorageAdapter({
      app: this.app,
      plugin: this.plugin,
      basePath: this.basePath,
      cacheTTL: options.cacheTTL,
      cacheMaxSize: options.cacheMaxSize
    });

    this.jsonlWriter = bundle.jsonlWriter;
    this.sqliteCache = bundle.sqliteCache;
    this.syncCoordinator = bundle.syncCoordinator;
    this.queryCache = bundle.queryCache;
    this.storageCoordinator = bundle.storageCoordinator;
    this.cacheBlobStore = bundle.cacheBlobStore;
    this.workspaceRepo = bundle.repositories.workspace;
    this.sessionRepo = bundle.repositories.session;
    this.stateRepo = bundle.repositories.state;
    this.traceRepo = bundle.repositories.trace;
    this.conversationRepo = bundle.repositories.conversation;
    this.messageRepo = bundle.repositories.message;
    this.projectRepo = bundle.repositories.project;
    this.taskRepo = bundle.repositories.task;
    this.exportService = bundle.exportService;

    this.planApplier = new StoragePlanApplier({
      app: this.app,
      jsonlWriter: this.jsonlWriter,
      sqliteCache: this.sqliteCache,
      syncCoordinator: this.syncCoordinator,
      storageCoordinator: this.storageCoordinator,
      cacheBlobStore: this.cacheBlobStore,
      onVaultEventStoreChanged: (store) => { this.vaultEventStore = store; },
      onBasePathChanged: (path) => { this.basePath = path; }
    });

    this.reconcilers = new MissingEntityReconcilerRunner(
      () => this.reconciliationCoordinator,
      {
        sqliteCache: this.sqliteCache,
        workspaceRepo: this.workspaceRepo,
        conversationRepo: this.conversationRepo
      }
    );

    this.externalSync = new ExternalSyncController({
      app: this.app,
      getDataPath: () => this.basePath,
      jsonlWriter: this.jsonlWriter,
      syncCoordinator: this.syncCoordinator,
      queryCache: this.queryCache,
      reconcilers: this.reconcilers,
      isReconcilePipelineWired: () => this.planApplier.getReconcilePipeline() !== null,
      fallbackFullSync: () => this.sync()
    });

    this.cacheRebuild = new CacheRebuildOperation({
      getSqliteCache: () => this.sqliteCache,
      getSyncCoordinator: () => this.syncCoordinator,
      getCacheBlobStore: () => this.cacheBlobStore,
      getInitLifecycle: () => this.initLifecycle
    });

    this.vaultRootRelocator = new VaultRootRelocator({
      app: this.app,
      jsonlWriter: this.jsonlWriter,
      queryCache: this.queryCache,
      planApplier: this.planApplier,
      externalSync: this.externalSync,
      onBasePathChanged: (path) => { this.basePath = path; }
    });
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(blocking = false): Promise<void> {
    await this.initLifecycle.run(() => this.performInitialization(), { blocking });
  }

  private performInitialization(): Promise<void> {
    const pipeline = new StorageInitializationPipeline({
      app: this.app,
      jsonlWriter: this.jsonlWriter,
      sqliteCache: this.sqliteCache,
      syncCoordinator: this.syncCoordinator,
      storageCoordinator: this.storageCoordinator,
      hydration: this.hydration,
      planApplier: this.planApplier,
      reconcilers: this.reconcilers,
      onReconciliationCoordinatorReady: (coord) => {
        this.reconciliationCoordinator = coord;
        this.reconcilePipeline = this.planApplier.getReconcilePipeline();
      },
      startExternalSyncWatcher: () => this.externalSync.start()
    });
    return pipeline.run().catch((error: unknown) => {
      console.error('[HybridStorageAdapter] Initialization failed:', error);
      throw error;
    });
  }

  isReady(): boolean {
    return this.initLifecycle.isReady();
  }

  isQueryReady(): boolean {
    return this.isReady() && this.hydration.isQueryReadyPhase();
  }

  waitForReady(): Promise<boolean> {
    return this.initLifecycle.waitForReady();
  }

  waitForQueryReady(maxWaitMs = 60_000): Promise<boolean> {
    if (this.isQueryReady()) return Promise.resolve(true);
    if (this.initLifecycle.isInitialized() && this.initLifecycle.getError()) {
      return Promise.resolve(false);
    }
    return this.hydration.waitForReady({
      maxWaitMs,
      readyProbe: () => this.isQueryReady(),
      onTimeout: (ms) => console.error('[HybridStorageAdapter] waitForQueryReady timed out after', ms, 'ms')
    });
  }

  getInitError(): Error | null {
    return this.initLifecycle.getError();
  }

  getStartupHydrationState(): StartupHydrationState {
    return this.hydration.getState();
  }

  isStartupHydrationBlocking(): boolean {
    return this.hydration.isBlocking();
  }

  /** Used by EmbeddingManager for vector storage. */
  get cache(): SQLiteCacheManager {
    return this.sqliteCache;
  }

  /** Used by ConversationEmbeddingWatcher to register completion callbacks. */
  get messages(): MessageRepository {
    return this.messageRepo;
  }

  /** Used by TaskService for project operations. */
  get projects(): ProjectRepository {
    return this.projectRepo;
  }

  /** Used by TaskService for task operations. */
  get tasks(): TaskRepository {
    return this.taskRepo;
  }

  async close(): Promise<void> {
    if (!this.initLifecycle.isInitialized()) return;
    try {
      this.externalSync.stop();
      this.queryCache.clear();
      await this.sqliteCache.close();
    } catch (error) {
      console.error('[HybridStorageAdapter] Error during close:', error);
      throw error;
    }
  }

  rebuildCache(options: { onProgress?: (label: string, done: number, total: number) => void } = {}): Promise<void> {
    return this.cacheRebuild.run(options);
  }

  // ============================================================================
  // External sync (vault-event-driven reconciliation)
  // ============================================================================

  onExternalSync(callback: (event: ExternalSyncEvent) => void): EventRef {
    return this.externalSync.on(callback);
  }

  offExternalSync(ref: EventRef): void {
    this.externalSync.off(ref);
  }

  async sync(): Promise<SyncResult> {
    try {
      const result = await this.syncCoordinator.sync();
      await this.reconcilers.runAll();
      // Invalidate all query cache on sync.
      this.queryCache.clear();
      return result;
    } catch (error) {
      console.error('[HybridStorageAdapter] Sync failed:', error);
      throw error;
    }
  }

  async relocateVaultRoot(
    targetRootPath: string,
    options?: { maxShardBytes?: number }
  ): Promise<VaultRootRelocationResult & { switched: boolean }> {
    return this.vaultRootRelocator.relocate(targetRootPath, options);
  }

  // ============================================================================
  // Test seams — thin pass-throughs to private helpers.
  //
  // These exist because tests pin the method names by calling them via
  // `(adapter as any).<method>(...)` against a hand-constructed prototype.
  // New code should call StoragePlanApplier / MissingEntityReconcilerRunner
  // directly instead of going through the adapter.
  // ============================================================================

  private applyStoragePlan(plan: PluginScopedStoragePlan): void {
    this.planApplier.applyStoragePlan(plan);
    this.reconcilePipeline = this.planApplier.getReconcilePipeline();
  }

  private runCacheBackendMigration(plan: PluginScopedStoragePlan): Promise<void> {
    return this.planApplier.runCacheBackendMigration(plan);
  }

  private reconcileMissingWorkspaces(): Promise<number> {
    return this.reconcilers.workspaces();
  }

  private reconcileMissingConversations(): Promise<number> {
    return this.reconcilers.conversations();
  }

  private reconcileMissingTasks(): Promise<number> {
    return this.reconcilers.tasks();
  }

  // ============================================================================
  // IStorageAdapter delegations
  //
  // The verbosity below is unavoidable: 60+ external call sites depend on
  // `adapter.<method>(...)` shape. Each method awaits init then forwards
  // to its repository. Body intentionally one-liner-ish; logic lives in
  // the repos.
  // ============================================================================

  // ---- Workspace -------------------------------------------------------------

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

  // ---- Session ---------------------------------------------------------------

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

  // ---- State -----------------------------------------------------------------

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

  // ---- Trace -----------------------------------------------------------------

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
    const result = await this.traceRepo.searchTraces(workspaceId, query, sessionId);
    return result.items;
  };

  // ---- Conversation ----------------------------------------------------------

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

    // Cascade delete: find and delete any child branch conversations.
    const branches = await this.conversationRepo.getConversations({
      pageSize: 100,
      includeBranches: true
    });
    for (const branch of branches.items) {
      if (branch.metadata?.parentConversationId === id) {
        await this.deleteConversation(branch.id);
      }
    }

    return this.conversationRepo.delete(id);
  };

  searchConversations = async (query: string): Promise<ConversationMetadata[]> => {
    await this.ensureInitialized();
    return this.conversationRepo.search(query);
  };

  // ---- Message ---------------------------------------------------------------

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

    // Cascade delete: child branches tied to this message.
    const branches = await this.conversationRepo.getConversations({
      pageSize: 100,
      includeBranches: true
    });
    for (const branch of branches.items) {
      if (branch.metadata?.parentMessageId === messageId) {
        await this.deleteConversation(branch.id);
      }
    }

    return this.messageRepo.deleteMessage(conversationId, messageId);
  };

  // ---- Export/Import ---------------------------------------------------------

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

  private async ensureInitialized(): Promise<void> {
    if (this.initLifecycle.isReady()) return;
    if (!this.initLifecycle.hasStarted()) {
      throw new Error('HybridStorageAdapter not initialized. Call initialize() first.');
    }
    const ok = await this.initLifecycle.waitForReady();
    if (!ok) {
      throw this.initLifecycle.getError() ?? new Error('HybridStorageAdapter initialization failed.');
    }
  }
}
