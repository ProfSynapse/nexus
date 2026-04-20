// Location: src/services/WorkspaceService.ts
// Centralized workspace management service with split-file storage.
// Session and state/trace CRUD delegated to WorkspaceSessionService and WorkspaceStateService.
// Used by: MemoryManager agents, WorkspaceEditModal, UI components
// Dependencies: FileSystemService, IndexManager for data access (legacy)
//               IStorageAdapter for new hybrid storage backend

import { Plugin } from 'obsidian';
import { FileSystemService } from './storage/FileSystemService';
import { IndexManager } from './storage/IndexManager';
import { IndividualWorkspace, WorkspaceMetadata, SessionData, MemoryTrace, StateData } from '../types/storage/StorageTypes';
import { IStorageAdapter } from '../database/interfaces/IStorageAdapter';
import * as HybridTypes from '../types/storage/HybridStorageTypes';
import type { VaultOperations } from '../core/VaultOperations';
import type { MCPSettings } from '../types/plugin/PluginTypes';
import { StorageAdapterOrGetter, resolveAdapter, withDualBackend, withReadableBackend } from './helpers/DualBackendExecutor';
import { convertWorkspaceMetadata } from './helpers/WorkspaceTypeConverters';
import { normalizeWorkspaceData, normalizeWorkspaceContext } from './helpers/WorkspaceNormalizer';
import { WorkspaceSessionService } from './workspace/WorkspaceSessionService';
import { WorkspaceStateService } from './workspace/WorkspaceStateService';
import {
  SystemGuidesWorkspaceProvider,
  type SystemGuidesWorkspaceSummary,
  type SystemGuidesLoadResult
} from './workspace/SystemGuidesWorkspaceProvider';

// Export constant for backward compatibility
export const GLOBAL_WORKSPACE_ID = 'default';
const DEFAULT_WORKSPACE_NAME = 'Default Workspace';

interface WorkspaceServiceOptions {
  vaultOperations?: VaultOperations;
  getSettings?: () => Pick<MCPSettings, 'storage'> | undefined;
}

export class WorkspaceService {
  private storageAdapterOrGetter: StorageAdapterOrGetter;
  private sessionService: WorkspaceSessionService;
  private stateService: WorkspaceStateService;
  private systemGuidesProvider: SystemGuidesWorkspaceProvider | null;

  constructor(
    private plugin: Plugin,
    private fileSystem: FileSystemService,
    private indexManager: IndexManager,
    storageAdapter?: StorageAdapterOrGetter,
    options?: WorkspaceServiceOptions
  ) {
    this.storageAdapterOrGetter = storageAdapter;
    this.systemGuidesProvider =
      options?.vaultOperations && options.getSettings
        ? new SystemGuidesWorkspaceProvider(
          this.plugin.app,
          this.plugin.manifest.version,
          options.vaultOperations,
          options.getSettings
        )
        : null;

    this.sessionService = new WorkspaceSessionService(
      fileSystem,
      indexManager,
      storageAdapter,
      {
        getWorkspace: (id) => this.getWorkspace(id),
        getWorkspaceByNameOrId: (identifier) => this.getWorkspaceByNameOrId(identifier),
        createWorkspace: (data) => this.createWorkspace(data)
      }
    );

    this.stateService = new WorkspaceStateService(
      fileSystem,
      indexManager,
      storageAdapter,
      {
        getSession: (wId, sId) => this.getSession(wId, sId),
        addSession: (wId, data) => this.addSession(wId, data)
      }
    );
  }

  /**
   * Resolve the storage adapter if available and ready.
   * Delegates to shared DualBackendExecutor helper.
   */
  private getReadyAdapter(): IStorageAdapter | undefined {
    return resolveAdapter(this.storageAdapterOrGetter);
  }

  private isWorkspaceNameUniqueConstraint(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('UNIQUE constraint failed: workspaces.name');
  }

  private async reuseExistingWorkspaceAfterUniqueError(
    data: Partial<IndividualWorkspace>
  ): Promise<IndividualWorkspace | null> {
    const existingById = data.id ? await this.getWorkspace(data.id) : null;
    if (existingById) {
      return existingById;
    }

    if (!data.name) {
      return null;
    }

    return this.getWorkspaceByNameOrId(data.name);
  }

  isSystemWorkspaceId(identifier: string): boolean {
    return this.systemGuidesProvider?.matchesWorkspaceId(identifier) ?? false;
  }

  getSystemGuidesWorkspaceSummary(): SystemGuidesWorkspaceSummary | null {
    return this.systemGuidesProvider?.getWorkspaceSummary() ?? null;
  }

  async loadSystemGuidesWorkspace(limit = 5): Promise<SystemGuidesLoadResult | null> {
    if (!this.systemGuidesProvider) {
      return null;
    }

    return this.systemGuidesProvider.loadWorkspaceData(limit);
  }

  private isSystemWorkspaceName(identifier: string): boolean {
    const summary = this.systemGuidesProvider?.getWorkspaceSummary();
    return summary ? summary.name.toLowerCase() === identifier.toLowerCase() : false;
  }

  private isSystemWorkspaceIdentifier(identifier: string): boolean {
    return this.isSystemWorkspaceId(identifier) || this.isSystemWorkspaceName(identifier);
  }

  private getSystemWorkspace(): IndividualWorkspace | null {
    return this.systemGuidesProvider?.getWorkspace() ?? null;
  }

  private ensureSystemWorkspaceMutable(id: string): void {
    if (this.isSystemWorkspaceId(id)) {
      throw new Error('The system-managed guides workspace cannot be modified.');
    }
  }

  // ============================================================================
  // Workspace CRUD (kept in this file — core responsibility)
  // ============================================================================

  /**
   * List workspaces (uses index only - lightweight and fast)
   */
  async listWorkspaces(limit?: number): Promise<WorkspaceMetadata[]> {
    return withReadableBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getWorkspaces({
          pageSize: limit,
          sortBy: 'lastAccessed',
          sortOrder: 'desc'
        });
        return result.items.map(w => convertWorkspaceMetadata(w));
      },
      async () => {
        const index = await this.indexManager.loadWorkspaceIndex();
        let workspaces = Object.values(index.workspaces);
        workspaces.sort((a, b) => b.lastAccessed - a.lastAccessed);
        if (limit) {
          workspaces = workspaces.slice(0, limit);
        }
        return workspaces;
      }
    );
  }

  /**
   * Get workspaces with flexible sorting and filtering (uses index only - lightweight and fast)
   */
  async getWorkspaces(options?: {
    sortBy?: 'name' | 'created' | 'lastAccessed',
    sortOrder?: 'asc' | 'desc',
    limit?: number
  }): Promise<WorkspaceMetadata[]> {
    return withReadableBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getWorkspaces({
          pageSize: options?.limit,
          sortBy: options?.sortBy || 'lastAccessed',
          sortOrder: options?.sortOrder || 'desc'
        });
        return result.items.map(w => convertWorkspaceMetadata(w));
      },
      async () => {
        const index = await this.indexManager.loadWorkspaceIndex();
        let workspaces = Object.values(index.workspaces);
        const sortBy = options?.sortBy || 'lastAccessed';
        const sortOrder = options?.sortOrder || 'desc';

        workspaces.sort((a, b) => {
          let comparison = 0;
          switch (sortBy) {
            case 'name':
              comparison = a.name.localeCompare(b.name);
              break;
            case 'created':
              comparison = a.created - b.created;
              break;
            case 'lastAccessed':
            default:
              comparison = a.lastAccessed - b.lastAccessed;
              break;
          }
          return sortOrder === 'asc' ? comparison : -comparison;
        });

        if (options?.limit) {
          workspaces = workspaces.slice(0, options.limit);
        }
        return workspaces;
      }
    );
  }

  /**
   * Get full workspace with sessions and traces (loads individual file)
   * NOTE: When using IStorageAdapter, this only returns metadata.
   * Use getSessions/getTraces methods separately for full data.
   */
  async getWorkspace(id: string): Promise<IndividualWorkspace | null> {
    if (this.isSystemWorkspaceId(id)) {
      return this.getSystemWorkspace();
    }

    return withReadableBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const metadata = await adapter.getWorkspace(id);
        if (!metadata) {
          return null;
        }
        return {
          id: metadata.id,
          name: metadata.name,
          description: metadata.description,
          rootFolder: metadata.rootFolder,
          created: metadata.created,
          lastAccessed: metadata.lastAccessed,
          isActive: metadata.isActive,
          isArchived: metadata.isArchived,
          dedicatedAgentId: metadata.dedicatedAgentId,
          context: metadata.context ? normalizeWorkspaceContext(metadata.context).context : metadata.context,
          sessions: {}
        };
      },
      async () => {
        const workspace = await this.fileSystem.readWorkspace(id);
        if (!workspace) {
          return null;
        }
        const migrated = normalizeWorkspaceData(workspace);
        if (migrated) {
          await this.fileSystem.writeWorkspace(id, workspace);
        }
        return workspace;
      }
    );
  }

  /**
   * Get all workspaces with full data (expensive - avoid if possible)
   */
  async getAllWorkspaces(): Promise<IndividualWorkspace[]> {
    return withReadableBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getWorkspaces({
          pageSize: 1000,
          sortBy: 'lastAccessed',
          sortOrder: 'desc'
        });
        return result.items
          .filter(w => w.name && w.name !== 'undefined' && w.id && w.id !== 'undefined')
          .map(w => ({
            id: w.id,
            name: w.name,
            description: w.description,
            rootFolder: w.rootFolder,
            created: w.created,
            lastAccessed: w.lastAccessed,
            isActive: w.isActive,
            isArchived: w.isArchived,
            dedicatedAgentId: w.dedicatedAgentId,
            context: w.context ? normalizeWorkspaceContext(w.context).context : w.context,
            sessions: {}
          }));
      },
      async () => {
        const workspaceIds = await this.fileSystem.listWorkspaceIds();
        const workspaces: IndividualWorkspace[] = [];
        for (const id of workspaceIds) {
          const workspace = await this.fileSystem.readWorkspace(id);
          if (workspace) {
            const migrated = normalizeWorkspaceData(workspace);
            if (migrated) {
              await this.fileSystem.writeWorkspace(id, workspace);
            }
            workspaces.push(workspace);
          }
        }
        return workspaces;
      }
    );
  }

  /**
   * Create new workspace (writes file + updates index)
   */
  async createWorkspace(data: Partial<IndividualWorkspace>): Promise<IndividualWorkspace> {
    // Use new adapter if available and ready (avoids blocking on SQLite initialization)
    const adapterForCreate = this.getReadyAdapter();
    if (adapterForCreate) {
      // Convert context to HybridTypes format if provided
      const hybridContext = data.context ? {
        ...normalizeWorkspaceContext(data.context).context,
        dedicatedAgent: data.context.dedicatedAgent
      } : undefined;

      const hybridData: Omit<HybridTypes.WorkspaceMetadata, 'id'> & { id?: string } = {
        id: data.id, // Pass optional ID (e.g., 'default')
        name: data.name || 'Untitled Workspace',
        description: data.description,
        rootFolder: data.rootFolder || '/',
        created: data.created || Date.now(),
        lastAccessed: data.lastAccessed || Date.now(),
        isActive: data.isActive ?? true,
        isArchived: data.isArchived,
        dedicatedAgentId: data.dedicatedAgentId, // Pass through dedicatedAgentId
        context: hybridContext
      };

      try {
        const id = await adapterForCreate.createWorkspace(hybridData);

        return {
          id,
          name: hybridData.name,
          description: hybridData.description,
          rootFolder: hybridData.rootFolder,
          created: hybridData.created,
          lastAccessed: hybridData.lastAccessed,
          isActive: hybridData.isActive,
          isArchived: hybridData.isArchived,
          context: data.context,
          sessions: {}
        };
      } catch (error) {
        const isDefaultWorkspace =
          hybridData.id === GLOBAL_WORKSPACE_ID || hybridData.name === DEFAULT_WORKSPACE_NAME;

        if (isDefaultWorkspace && this.isWorkspaceNameUniqueConstraint(error)) {
          const existingWorkspace = await this.reuseExistingWorkspaceAfterUniqueError(hybridData);
          if (existingWorkspace) {
            return existingWorkspace;
          }
        }

        throw error;
      }
    }

    // Fall back to legacy implementation
    const id = data.id || `ws_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    const workspace: IndividualWorkspace = {
      id,
      name: data.name || 'Untitled Workspace',
      description: data.description,
      rootFolder: data.rootFolder || '/',
      created: data.created || Date.now(),
      lastAccessed: data.lastAccessed || Date.now(),
      isActive: data.isActive ?? true,
      context: data.context ? normalizeWorkspaceContext(data.context).context : data.context,
      sessions: data.sessions || {}
    };

    // Write workspace file
    await this.fileSystem.writeWorkspace(id, workspace);

    // Update index
    await this.indexManager.updateWorkspaceInIndex(workspace);

    return workspace;
  }

  /**
   * Update workspace (updates file + index metadata)
   */
  async updateWorkspace(id: string, updates: Partial<IndividualWorkspace>): Promise<void> {
    this.ensureSystemWorkspaceMutable(id);
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const hybridUpdates: Partial<HybridTypes.WorkspaceMetadata> = {};

        if (updates.name !== undefined) hybridUpdates.name = updates.name;
        if (updates.description !== undefined) hybridUpdates.description = updates.description;
        if (updates.rootFolder !== undefined) hybridUpdates.rootFolder = updates.rootFolder;
        if (updates.isActive !== undefined) hybridUpdates.isActive = updates.isActive;
        if (updates.isArchived !== undefined) hybridUpdates.isArchived = updates.isArchived;

        const updatesWithId = updates as IndividualWorkspace & { dedicatedAgentId?: string };
        if (updatesWithId.dedicatedAgentId !== undefined) {
          hybridUpdates.dedicatedAgentId = updatesWithId.dedicatedAgentId;
        }

        if (updates.context !== undefined) {
          const normalizedContext = normalizeWorkspaceContext(updates.context).context;
          hybridUpdates.context = {
            purpose: normalizedContext.purpose,
            workflows: normalizedContext.workflows,
            keyFiles: normalizedContext.keyFiles,
            preferences: normalizedContext.preferences,
            dedicatedAgent: updates.context.dedicatedAgent
          };
        }

        hybridUpdates.lastAccessed = Date.now();
        await adapter.updateWorkspace(id, hybridUpdates);
      },
      async () => {
        const workspace = await this.fileSystem.readWorkspace(id);
        if (!workspace) {
          throw new Error(`Workspace ${id} not found`);
        }

        const updatedWorkspace: IndividualWorkspace = {
          ...workspace,
          ...updates,
          id,
          lastAccessed: Date.now()
        };
        normalizeWorkspaceData(updatedWorkspace);
        await this.fileSystem.writeWorkspace(id, updatedWorkspace);
        await this.indexManager.updateWorkspaceInIndex(updatedWorkspace);
      }
    );
  }

  /**
   * Update last accessed timestamp for a workspace
   */
  async updateLastAccessed(id: string): Promise<void> {
    this.ensureSystemWorkspaceMutable(id);
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        await adapter.updateWorkspace(id, { lastAccessed: Date.now() });
      },
      async () => {
        const workspace = await this.fileSystem.readWorkspace(id);
        if (!workspace) {
          throw new Error(`Workspace ${id} not found`);
        }
        workspace.lastAccessed = Date.now();
        await this.fileSystem.writeWorkspace(id, workspace);
        await this.indexManager.updateWorkspaceInIndex(workspace);
      }
    );
  }

  /**
   * Delete workspace (deletes file + removes from index)
   */
  async deleteWorkspace(id: string): Promise<void> {
    this.ensureSystemWorkspaceMutable(id);
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        await adapter.deleteWorkspace(id);
      },
      async () => {
        await this.fileSystem.deleteWorkspace(id);
        await this.indexManager.removeWorkspaceFromIndex(id);
      }
    );
  }

  // ============================================================================
  // Session CRUD (delegated to WorkspaceSessionService)
  // ============================================================================

  async addSession(workspaceId: string, sessionData: Partial<SessionData>): Promise<SessionData> {
    return this.sessionService.addSession(workspaceId, sessionData);
  }

  async updateSession(workspaceId: string, sessionId: string, updates: Partial<SessionData>): Promise<void> {
    return this.sessionService.updateSession(workspaceId, sessionId, updates);
  }

  async deleteSession(workspaceId: string, sessionId: string): Promise<void> {
    return this.sessionService.deleteSession(workspaceId, sessionId);
  }

  async getSession(workspaceId: string, sessionId: string): Promise<SessionData | null> {
    return this.sessionService.getSession(workspaceId, sessionId);
  }

  async getSessionByNameOrId(workspaceId: string, identifier: string): Promise<SessionData | null> {
    return this.sessionService.getSessionByNameOrId(workspaceId, identifier);
  }

  // ============================================================================
  // State & Trace CRUD (delegated to WorkspaceStateService)
  // ============================================================================

  async addMemoryTrace(workspaceId: string, sessionId: string, traceData: Partial<MemoryTrace>): Promise<MemoryTrace> {
    return this.stateService.addMemoryTrace(workspaceId, sessionId, traceData);
  }

  async getMemoryTraces(workspaceId: string, sessionId: string): Promise<MemoryTrace[]> {
    return this.stateService.getMemoryTraces(workspaceId, sessionId);
  }

  async addState(workspaceId: string, sessionId: string, stateData: Partial<StateData>): Promise<StateData> {
    return this.stateService.addState(workspaceId, sessionId, stateData);
  }

  async getState(workspaceId: string, sessionId: string, stateId: string): Promise<StateData | null> {
    return this.stateService.getState(workspaceId, sessionId, stateId);
  }

  async getStateByNameOrId(workspaceId: string, sessionId: string, identifier: string): Promise<StateData | null> {
    return this.stateService.getStateByNameOrId(workspaceId, sessionId, identifier);
  }

  // ============================================================================
  // Workspace Query Methods (kept — workspace-level concerns)
  // ============================================================================

  /**
   * Search workspaces (uses index search data)
   */
  async searchWorkspaces(query: string, limit?: number): Promise<WorkspaceMetadata[]> {
    if (!query) {
      return this.listWorkspaces(limit);
    }

    return withReadableBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const results = await adapter.searchWorkspaces(query);
        const converted = results.map(w => convertWorkspaceMetadata(w));
        return limit ? converted.slice(0, limit) : converted;
      },
      async () => {
        const index = await this.indexManager.loadWorkspaceIndex();
        const words = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
        const matchedIds = new Set<string>();

        for (const word of words) {
          if (index.byName[word]) {
            index.byName[word].forEach((id: string) => matchedIds.add(id));
          }
          if (index.byDescription[word]) {
            index.byDescription[word].forEach((id: string) => matchedIds.add(id));
          }
        }

        const results = Array.from(matchedIds)
          .map(id => index.workspaces[id])
          .filter(ws => ws !== undefined)
          .sort((a, b) => b.lastAccessed - a.lastAccessed);

        return limit ? results.slice(0, limit) : results;
      }
    );
  }

  /**
   * Get workspace by folder (uses index)
   */
  async getWorkspaceByFolder(folder: string): Promise<WorkspaceMetadata | null> {
    return withReadableBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getWorkspaces({
          filter: { rootFolder: folder },
          pageSize: 1
        });
        if (result.items.length === 0) {
          return null;
        }
        return convertWorkspaceMetadata(result.items[0]);
      },
      async () => {
        const index = await this.indexManager.loadWorkspaceIndex();
        const workspaceId = index.byFolder[folder];
        if (!workspaceId) {
          return null;
        }
        return index.workspaces[workspaceId] || null;
      }
    );
  }

  /**
   * Get active workspace (uses index)
   */
  async getActiveWorkspace(): Promise<WorkspaceMetadata | null> {
    return withReadableBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getWorkspaces({
          filter: { isActive: true },
          pageSize: 1
        });
        if (result.items.length === 0) {
          return null;
        }
        return convertWorkspaceMetadata(result.items[0]);
      },
      async () => {
        const index = await this.indexManager.loadWorkspaceIndex();
        const workspaces = Object.values(index.workspaces);
        return workspaces.find(ws => ws.isActive) || null;
      }
    );
  }

  /**
   * Get workspace by name or ID (unified lookup).
   * Tries ID lookup first (more specific), then falls back to name lookup (case-insensitive).
   * @param identifier Workspace name or ID
   * @returns Full workspace data or null if not found
   */
  async getWorkspaceByNameOrId(identifier: string): Promise<IndividualWorkspace | null> {
    if (this.isSystemWorkspaceIdentifier(identifier)) {
      return this.getSystemWorkspace();
    }

    const byId = await this.getWorkspace(identifier);
    if (byId) {
      return byId;
    }

    const matchId = await withReadableBackend<string | null>(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getWorkspaces({
          search: identifier,
          pageSize: 100
        });
        const match = result.items.find(
          ws => ws.name.toLowerCase() === identifier.toLowerCase()
        );
        return match?.id ?? null;
      },
      async () => {
        const index = await this.indexManager.loadWorkspaceIndex();
        const workspaces = Object.values(index.workspaces);
        const match = workspaces.find(
          ws => ws.name.toLowerCase() === identifier.toLowerCase()
        );
        return match?.id ?? null;
      }
    );

    if (!matchId) {
      return null;
    }
    return this.getWorkspace(matchId);
  }

}
