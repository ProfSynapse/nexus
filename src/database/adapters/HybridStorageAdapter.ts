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

import { App } from 'obsidian';
import { IStorageAdapter, QueryOptions, ImportOptions } from '../interfaces/IStorageAdapter';
import { JSONLWriter } from '../storage/JSONLWriter';
import { SQLiteCacheManager } from '../storage/SQLiteCacheManager';
import { SyncCoordinator } from '../sync/SyncCoordinator';
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
import { WorkspaceEvent } from '../interfaces/StorageEvents';
import { WorkspaceEventApplier } from '../sync/WorkspaceEventApplier';

// Import all repositories
import { WorkspaceRepository } from '../repositories/WorkspaceRepository';
import { SessionRepository } from '../repositories/SessionRepository';
import { StateRepository } from '../repositories/StateRepository';
import { TraceRepository } from '../repositories/TraceRepository';
import { ConversationRepository } from '../repositories/ConversationRepository';
import { MessageRepository } from '../repositories/MessageRepository';
// Import services
import { ExportService } from '../services/ExportService';

/**
 * Configuration options for HybridStorageAdapter
 */
export interface HybridStorageAdapterOptions {
  /** Obsidian app instance */
  app: App;
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
 * Hybrid Storage Adapter
 *
 * Thin facade that composes repositories and handles lifecycle.
 * Reduced from 1,696 lines to ~350 lines by delegating to repositories.
 */
export class HybridStorageAdapter implements IStorageAdapter {
  private app: App;
  private basePath: string;
  private initialized = false;
  private syncInterval?: NodeJS.Timeout;

  // Deferred initialization support
  private initPromise: Promise<void> | null = null;
  private initResolve: (() => void) | null = null;
  private initError: Error | null = null;

  // Infrastructure (owned by adapter)
  private jsonlWriter: JSONLWriter;
  private sqliteCache: SQLiteCacheManager;
  private syncCoordinator: SyncCoordinator;
  private queryCache: QueryCache;

  // Repositories (composed)
  private workspaceRepo!: WorkspaceRepository;
  private sessionRepo!: SessionRepository;
  private stateRepo!: StateRepository;
  private traceRepo!: TraceRepository;
  private conversationRepo!: ConversationRepository;
  private messageRepo!: MessageRepository;

  // Services
  private exportService!: ExportService;

  constructor(options: HybridStorageAdapterOptions) {
    this.app = options.app;
    this.basePath = options.basePath ?? '.nexus';

    // Initialize infrastructure
    this.jsonlWriter = new JSONLWriter({
      app: this.app,
      basePath: this.basePath
    });

    this.sqliteCache = new SQLiteCacheManager({
      app: this.app,
      dbPath: `${this.basePath}/cache.db`
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

    // Initialize services
    this.exportService = new ExportService({
      app: this.app,
      conversationRepo: this.conversationRepo,
      messageRepo: this.messageRepo,
      workspaceRepo: this.workspaceRepo,
      sessionRepo: this.sessionRepo,
      stateRepo: this.stateRepo,
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
    this.performInitialization().catch(error => {
      this.initError = error;
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
      // 1. Initialize SQLite cache
      await this.sqliteCache.initialize();

      // 2. Ensure JSONL directories exist
      await this.jsonlWriter.ensureDirectory('workspaces');
      await this.jsonlWriter.ensureDirectory('conversations');

      const migrator = new LegacyMigrator(this.app);
      const migrationNeeded = await migrator.isMigrationNeeded();
      let actuallyMigrated = false;

      if (migrationNeeded) {
        const migrationResult = await migrator.migrate();
        // Only count as "actually migrated" if something was migrated
        actuallyMigrated = migrationResult.needed &&
          (migrationResult.stats.workspacesMigrated > 0 || migrationResult.stats.conversationsMigrated > 0);
      }

      // 4. Perform initial sync (rebuild cache from JSONL)
      // Only full rebuild if no sync state OR if we actually migrated new data
      const syncState = await this.sqliteCache.getSyncState(this.jsonlWriter.getDeviceId());
      if (!syncState || actuallyMigrated) {
        try {
          await this.syncCoordinator.fullRebuild();
        } catch (rebuildError) {
          console.error('[HybridStorageAdapter] Full rebuild failed:', rebuildError);
          // Continue anyway - partial data is better than no data
        }
      } else {
        try {
          await this.syncCoordinator.sync();
        } catch (syncError) {
          console.error('[HybridStorageAdapter] Incremental sync failed:', syncError);
        }

        // 5. Reconcile JSONL workspaces missing from SQLite
        // Incremental sync skips same-device events, so workspaces created
        // by this device may be missing from SQLite if cache was rebuilt earlier
        try {
          await this.reconcileMissingWorkspaces();
        } catch (reconcileError) {
          console.error('[HybridStorageAdapter] Workspace reconciliation failed:', reconcileError);
        }
      }

      this.initialized = true;

      // Resolve the ready promise
      if (this.initResolve) {
        this.initResolve();
      }

    } catch (error) {
      console.error('[HybridStorageAdapter] Initialization failed:', error);
      this.initError = error as Error;
      if (this.initResolve) {
        this.initResolve(); // Resolve even on error so waiters don't hang
      }
      throw error;
    }
  }

  /**
   * Reconcile JSONL workspace files that are missing from SQLite.
   * This handles the case where incremental sync skips same-device events,
   * leaving workspaces in JSONL but absent from the SQLite cache.
   */
  private async reconcileMissingWorkspaces(): Promise<void> {
    const workspaceFiles = await this.jsonlWriter.listFiles('workspaces');
    if (workspaceFiles.length === 0) return;

    // Extract workspace IDs from filenames (pattern: workspaces/ws_{id}.jsonl)
    const jsonlWorkspaceIds: { id: string; file: string }[] = [];
    for (const file of workspaceFiles) {
      const match = file.match(/workspaces\/ws_(.+)\.jsonl$/);
      if (match) {
        jsonlWorkspaceIds.push({ id: match[1], file });
      }
    }

    if (jsonlWorkspaceIds.length === 0) return;

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
  }

  /**
   * Check if the adapter is ready for use
   */
  isReady(): boolean {
    return this.initialized && !this.initError;
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

  /**
   * Get the message repository instance.
   * Used by ConversationEmbeddingWatcher to register completion callbacks.
   */
  get messages(): MessageRepository {
    return this.messageRepo;
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

  async sync(): Promise<SyncResult> {
    try {
      const result = await this.syncCoordinator.sync();

      // Invalidate all query cache on sync
      this.queryCache.clear();

      return result;

    } catch (error) {
      console.error('[HybridStorageAdapter] Sync failed:', error);
      throw error;
    }
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
