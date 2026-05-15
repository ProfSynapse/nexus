/**
 * Composition root for HybridStorageAdapter.
 *
 * The constructor used to wire ~30 collaborators inline (writer, cache,
 * sync coordinator, blob store, 8 repositories, services). Now the wiring
 * lives here and the adapter just holds the resulting bundle.
 */

import { App, Plugin } from 'obsidian';
import { JSONLWriter } from '../../storage/JSONLWriter';
import { SQLiteCacheManager } from '../../storage/SQLiteCacheManager';
import { SyncCoordinator } from '../../sync/SyncCoordinator';
import { QueryCache } from '../../optimizations/QueryCache';
import { PluginScopedStorageCoordinator } from '../../migration/PluginScopedStorageCoordinator';
import { resolvePluginStorageRoot, resolveActivePluginFolderName } from '../../storage/PluginStoragePathResolver';
import { createCacheBlobStore, computeIdbKey } from '../../storage/CacheBlobStoreFactory';
import type { CacheBlobStore } from '../../storage/CacheBlobStore';
import { RepositoryDependencies } from '../../repositories/base/BaseRepository';
import { WorkspaceRepository } from '../../repositories/WorkspaceRepository';
import { SessionRepository } from '../../repositories/SessionRepository';
import { StateRepository } from '../../repositories/StateRepository';
import { TraceRepository } from '../../repositories/TraceRepository';
import { ConversationRepository } from '../../repositories/ConversationRepository';
import { MessageRepository } from '../../repositories/MessageRepository';
import { ProjectRepository } from '../../repositories/ProjectRepository';
import { TaskRepository } from '../../repositories/TaskRepository';
import { ExportService } from '../../services/ExportService';
import { StateData } from '../../../types/storage/HybridStorageTypes';

export interface AssembleOptions {
  app: App;
  plugin: Plugin;
  basePath: string;
  cacheTTL?: number;
  cacheMaxSize?: number;
}

export interface RepositoryBundle {
  workspace: WorkspaceRepository;
  session: SessionRepository;
  state: StateRepository;
  trace: TraceRepository;
  conversation: ConversationRepository;
  message: MessageRepository;
  project: ProjectRepository;
  task: TaskRepository;
}

export interface StorageAdapterBundle {
  jsonlWriter: JSONLWriter;
  sqliteCache: SQLiteCacheManager;
  syncCoordinator: SyncCoordinator;
  queryCache: QueryCache;
  storageCoordinator: PluginScopedStorageCoordinator;
  cacheBlobStore: CacheBlobStore;
  repositories: RepositoryBundle;
  exportService: ExportService;
}

type ExportServiceStateRepo = {
  getStates(workspaceId: string, sessionId: string | undefined, options?: { pageSize?: number }): Promise<{ items: StateData[] }>;
};

export function assembleStorageAdapter(options: AssembleOptions): StorageAdapterBundle {
  const { app, plugin, basePath } = options;
  const storageRoots = resolvePluginStorageRoot(app, plugin);
  const storageCoordinator = new PluginScopedStorageCoordinator(app, plugin, basePath);

  const jsonlWriter = new JSONLWriter({ app, basePath });

  // Build the cache-blob store ONCE so the migration runner and the
  // SQLiteCacheManager share the same instance. Platform-selected:
  // IndexedDB on desktop (cloud-sync-immune), vault.adapter on mobile.
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

  const syncCoordinator = new SyncCoordinator(jsonlWriter, sqliteCache);

  const queryCache = new QueryCache({
    defaultTTL: options.cacheTTL ?? 60000,
    maxSize: options.cacheMaxSize ?? 500
  });

  const deps: RepositoryDependencies = { jsonlWriter, sqliteCache, queryCache };

  const repositories: RepositoryBundle = {
    workspace: new WorkspaceRepository(deps),
    session: new SessionRepository(deps),
    state: new StateRepository(deps),
    trace: new TraceRepository(deps),
    conversation: new ConversationRepository(deps),
    message: new MessageRepository(deps),
    project: new ProjectRepository(deps),
    task: new TaskRepository(deps)
  };

  const exportService = new ExportService({
    app,
    conversationRepo: repositories.conversation,
    messageRepo: repositories.message,
    workspaceRepo: repositories.workspace,
    sessionRepo: repositories.session,
    stateRepo: repositories.state as unknown as ExportServiceStateRepo,
    traceRepo: repositories.trace
  });

  return {
    jsonlWriter,
    sqliteCache,
    syncCoordinator,
    queryCache,
    storageCoordinator,
    cacheBlobStore,
    repositories,
    exportService
  };
}
