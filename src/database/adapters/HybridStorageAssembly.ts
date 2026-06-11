/**
 * Location: src/database/adapters/HybridStorageAssembly.ts
 *
 * Construction wiring for HybridStorageAdapter (Phase 1 of
 * docs/plans/hybrid-storage-adapter-split-plan.md).
 *
 * Builds the storage backends (JSONLWriter, CacheBlobStore,
 * SQLiteCacheManager, SyncCoordinator, QueryCache,
 * PluginScopedStorageCoordinator), the eight entity repositories, and the
 * ExportService in the exact order the adapter constructor previously did.
 * Pure assembly only: anything that closes over adapter state (lifecycle
 * controllers, event subscriptions, the reconcile pipeline) stays in the
 * adapter constructor.
 *
 * Related Files:
 * - src/database/adapters/HybridStorageAdapter.ts - Sole consumer
 * - src/database/repositories/* - Entity repositories
 * - src/database/services/ExportService.ts - Export business service
 */

import { App, Plugin } from 'obsidian';
import { JSONLWriter } from '../storage/JSONLWriter';
import { SQLiteCacheManager } from '../storage/SQLiteCacheManager';
import { SyncCoordinator } from '../sync/SyncCoordinator';
import { QueryCache } from '../optimizations/QueryCache';
import { PluginScopedStorageCoordinator } from '../migration/PluginScopedStorageCoordinator';
import { resolvePluginStorageRoot, resolveActivePluginFolderName } from '../storage/PluginStoragePathResolver';
import { createCacheBlobStore, computeIdbKey } from '../storage/CacheBlobStoreFactory';
import type { CacheBlobStore } from '../storage/CacheBlobStore';
import { RepositoryDependencies } from '../repositories/base/BaseRepository';
import { StateData } from '../../types/storage/HybridStorageTypes';

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
 * Inputs the construction wiring consumes. Mirrors the subset of
 * HybridStorageAdapterOptions the old constructor body read, with
 * `basePath` already defaulted by the adapter.
 */
export interface HybridStorageAssemblyOptions {
  /** Obsidian app instance */
  app: App;
  /** Active plugin instance for plugin-scoped storage resolution */
  plugin: Plugin;
  /** Base path for storage (already defaulted by the adapter) */
  basePath: string;
  /** Query cache TTL in ms (default: 60000) */
  cacheTTL?: number;
  /** Query cache max size (default: 500) */
  cacheMaxSize?: number;
}

/**
 * The assembled collaborators handed back to the adapter constructor.
 */
export interface HybridStorageAssembly {
  storageCoordinator: PluginScopedStorageCoordinator;
  jsonlWriter: JSONLWriter;
  cacheBlobStore: CacheBlobStore;
  sqliteCache: SQLiteCacheManager;
  syncCoordinator: SyncCoordinator;
  queryCache: QueryCache;
  workspaceRepo: WorkspaceRepository;
  sessionRepo: SessionRepository;
  stateRepo: StateRepository;
  traceRepo: TraceRepository;
  conversationRepo: ConversationRepository;
  messageRepo: MessageRepository;
  projectRepo: ProjectRepository;
  taskRepo: TaskRepository;
  exportService: ExportService;
}

/**
 * Assemble the adapter's collaborators. Construction order matches the
 * pre-split constructor exactly; no I/O happens here (initialization is
 * deferred to `HybridStorageAdapter.initialize()`).
 */
export function assembleHybridStorage(options: HybridStorageAssemblyOptions): HybridStorageAssembly {
  const { app, plugin, basePath } = options;
  const storageRoots = resolvePluginStorageRoot(app, plugin);
  const storageCoordinator = new PluginScopedStorageCoordinator(app, plugin, basePath);

  // Initialize infrastructure
  const jsonlWriter = new JSONLWriter({
    app,
    basePath
  });

  // Build the cache-blob store ONCE here so the migration runner and the
  // SQLiteCacheManager share the same instance. The store is selected by
  // platform: IndexedDB on desktop (cloud-sync-immune), vault.adapter on
  // mobile (iOS WKWebView IDB durability is insufficient for 150+ MB blobs).
  const pluginFolderName = resolveActivePluginFolderName(plugin);
  const cacheBlobStore = createCacheBlobStore({
    app,
    vaultRelativePath: `${storageRoots.dataRoot}/cache.db`,
    idbKey: computeIdbKey(app, pluginFolderName)
  });

  const sqliteCache = new SQLiteCacheManager({
    app,
    dbPath: `${storageRoots.dataRoot}/cache.db`,
    wasmPath: `${storageRoots.pluginDir}/sqlite3.wasm`,
    blobStore: cacheBlobStore,
    plugin
  });

  const syncCoordinator = new SyncCoordinator(
    jsonlWriter,
    sqliteCache
  );

  const queryCache = new QueryCache({
    defaultTTL: options.cacheTTL ?? 60000,
    maxSize: options.cacheMaxSize ?? 500
  });

  // Create repository dependencies
  const deps: RepositoryDependencies = {
    jsonlWriter,
    sqliteCache,
    queryCache
  };

  // Initialize all repositories
  const workspaceRepo = new WorkspaceRepository(deps);
  const sessionRepo = new SessionRepository(deps);
  const stateRepo = new StateRepository(deps);
  const traceRepo = new TraceRepository(deps);
  const conversationRepo = new ConversationRepository(deps);
  const messageRepo = new MessageRepository(deps);
  const projectRepo = new ProjectRepository(deps);
  const taskRepo = new TaskRepository(deps);

  // Initialize services
  const exportService = new ExportService({
    app,
    conversationRepo,
    messageRepo,
    workspaceRepo,
    sessionRepo,
    stateRepo: stateRepo as unknown as ExportServiceStateRepo,
    traceRepo
  });

  return {
    storageCoordinator,
    jsonlWriter,
    cacheBlobStore,
    sqliteCache,
    syncCoordinator,
    queryCache,
    workspaceRepo,
    sessionRepo,
    stateRepo,
    traceRepo,
    conversationRepo,
    messageRepo,
    projectRepo,
    taskRepo,
    exportService
  };
}
