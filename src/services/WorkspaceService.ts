// Location: src/services/WorkspaceService.ts
// Centralized workspace management service with split-file storage
// Used by: MemoryManager agents, WorkspaceEditModal, UI components
// Dependencies: FileSystemService, IndexManager for data access (legacy)
//               IStorageAdapter for new hybrid storage backend

import { Plugin } from 'obsidian';
import { FileSystemService } from './storage/FileSystemService';
import { IndexManager } from './storage/IndexManager';
import { IndividualWorkspace, WorkspaceMetadata, SessionData, MemoryTrace, StateData } from '../types/storage/StorageTypes';
import { IStorageAdapter } from '../database/interfaces/IStorageAdapter';
import * as HybridTypes from '../types/storage/HybridStorageTypes';
import { TraceMetadata } from '../database/types/memory/MemoryTypes';
import { WorkspaceState } from '../database/types/session/SessionTypes';
import { StorageAdapterOrGetter, resolveAdapter, withDualBackend } from './helpers/DualBackendExecutor';
import { convertWorkspaceMetadata } from './helpers/WorkspaceTypeConverters';
import { normalizeWorkspaceData, normalizeWorkspaceContext } from './helpers/WorkspaceNormalizer';

// Export constant for backward compatibility
export const GLOBAL_WORKSPACE_ID = 'default';

export class WorkspaceService {
  private storageAdapterOrGetter: StorageAdapterOrGetter;

  constructor(
    private plugin: Plugin,
    private fileSystem: FileSystemService,
    private indexManager: IndexManager,
    storageAdapter?: StorageAdapterOrGetter
  ) {
    this.storageAdapterOrGetter = storageAdapter;
  }

  /**
   * Resolve the storage adapter if available and ready.
   * Delegates to shared DualBackendExecutor helper.
   */
  private getReadyAdapter(): IStorageAdapter | undefined {
    return resolveAdapter(this.storageAdapterOrGetter);
  }

  // ============================================================================
  // Public API Methods (dual-backend support)
  // ============================================================================

  /**
   * List workspaces (uses index only - lightweight and fast)
   */
  async listWorkspaces(limit?: number): Promise<WorkspaceMetadata[]> {
    return withDualBackend(
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
    return withDualBackend(
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
    return withDualBackend(
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
    return withDualBackend(
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
        dedicatedAgentId: data.dedicatedAgentId, // Pass through dedicatedAgentId
        context: hybridContext
      };

      const id = await adapterForCreate.createWorkspace(hybridData);

      return {
        id,
        name: hybridData.name,
        description: hybridData.description,
        rootFolder: hybridData.rootFolder,
        created: hybridData.created,
        lastAccessed: hybridData.lastAccessed,
        isActive: hybridData.isActive,
        context: data.context,
        sessions: {}
      };
    }

    // Fall back to legacy implementation
    const id = data.id || `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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
   * Lightweight operation that only updates the timestamp in both file and index
   */
  async updateLastAccessed(id: string): Promise<void> {
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

  /**
   * Add session to workspace
   * Ensures the workspace exists before creating session
   */
  async addSession(workspaceId: string, sessionData: Partial<SessionData>): Promise<SessionData> {
    // Use new adapter if available and ready (avoids blocking on SQLite initialization)
    const adapterForAddSession = this.getReadyAdapter();
    if (adapterForAddSession) {
      // Ensure workspace exists before creating session (referential integrity)
      const existingWorkspace = await this.getWorkspace(workspaceId);
      if (!existingWorkspace) {
        // For 'default' workspace, create it automatically
        if (workspaceId === GLOBAL_WORKSPACE_ID) {
          await this.createWorkspace({
            id: GLOBAL_WORKSPACE_ID,
            name: 'Default Workspace',
            description: 'Default workspace for general use',
            rootFolder: '/'
          });
        } else {
          throw new Error(`Workspace ${workspaceId} not found. Create it first or use the default workspace.`);
        }
      }

      const hybridSession: Omit<HybridTypes.SessionMetadata, 'id' | 'workspaceId'> = {
        name: sessionData.name || 'Untitled Session',
        description: sessionData.description,
        startTime: sessionData.startTime || Date.now(),
        endTime: sessionData.endTime,
        isActive: sessionData.isActive ?? true
      };

      const sessionId = await adapterForAddSession.createSession(workspaceId, hybridSession);

      // Update workspace lastAccessed
      await adapterForAddSession.updateWorkspace(workspaceId, { lastAccessed: Date.now() });

      return {
        id: sessionId,
        name: hybridSession.name,
        description: hybridSession.description,
        startTime: hybridSession.startTime,
        endTime: hybridSession.endTime,
        isActive: hybridSession.isActive,
        memoryTraces: {},
        states: {}
      };
    }

    // Fall back to legacy implementation
    // Load workspace
    const workspace = await this.fileSystem.readWorkspace(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    // Create session
    const sessionId = sessionData.id || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const session: SessionData = {
      id: sessionId,
      name: sessionData.name,
      description: sessionData.description,
      startTime: sessionData.startTime || Date.now(),
      endTime: sessionData.endTime,
      isActive: sessionData.isActive ?? true,
      memoryTraces: sessionData.memoryTraces || {},
      states: sessionData.states || {}
    };

    // Add to workspace
    workspace.sessions[sessionId] = session;
    workspace.lastAccessed = Date.now();

    // Save workspace
    await this.fileSystem.writeWorkspace(workspaceId, workspace);

    // Update index
    await this.indexManager.updateWorkspaceInIndex(workspace);

    return session;
  }

  /**
   * Update session in workspace
   */
  async updateSession(workspaceId: string, sessionId: string, updates: Partial<SessionData>): Promise<void> {
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const hybridUpdates: Partial<HybridTypes.SessionMetadata> = {};
        if (updates.name !== undefined) hybridUpdates.name = updates.name;
        if (updates.description !== undefined) hybridUpdates.description = updates.description;
        if (updates.endTime !== undefined) hybridUpdates.endTime = updates.endTime;
        if (updates.isActive !== undefined) hybridUpdates.isActive = updates.isActive;

        await adapter.updateSession(workspaceId, sessionId, hybridUpdates);
        await adapter.updateWorkspace(workspaceId, { lastAccessed: Date.now() });
      },
      async () => {
        const workspace = await this.fileSystem.readWorkspace(workspaceId);
        if (!workspace) {
          throw new Error(`Workspace ${workspaceId} not found`);
        }
        if (!workspace.sessions[sessionId]) {
          throw new Error(`Session ${sessionId} not found in workspace ${workspaceId}`);
        }
        workspace.sessions[sessionId] = {
          ...workspace.sessions[sessionId],
          ...updates,
          id: sessionId
        };
        workspace.lastAccessed = Date.now();
        await this.fileSystem.writeWorkspace(workspaceId, workspace);
        await this.indexManager.updateWorkspaceInIndex(workspace);
      }
    );
  }

  /**
   * Delete session from workspace
   */
  async deleteSession(workspaceId: string, sessionId: string): Promise<void> {
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        await adapter.deleteSession(sessionId);
        await adapter.updateWorkspace(workspaceId, { lastAccessed: Date.now() });
      },
      async () => {
        const workspace = await this.fileSystem.readWorkspace(workspaceId);
        if (!workspace) {
          throw new Error(`Workspace ${workspaceId} not found`);
        }
        delete workspace.sessions[sessionId];
        workspace.lastAccessed = Date.now();
        await this.fileSystem.writeWorkspace(workspaceId, workspace);
        await this.indexManager.updateWorkspaceInIndex(workspace);
      }
    );
  }

  /**
   * Get session from workspace
   */
  async getSession(workspaceId: string, sessionId: string): Promise<SessionData | null> {
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const session = await adapter.getSession(sessionId);
        if (!session) {
          return null;
        }
        return {
          id: session.id,
          name: session.name,
          description: session.description,
          startTime: session.startTime,
          endTime: session.endTime,
          isActive: session.isActive,
          memoryTraces: {},
          states: {}
        };
      },
      async () => {
        const workspace = await this.fileSystem.readWorkspace(workspaceId);
        if (!workspace) {
          return null;
        }
        return workspace.sessions[sessionId] || null;
      }
    );
  }

  /**
   * Add memory trace to session
   * Ensures the session exists before saving (creates it if needed)
   */
  async addMemoryTrace(workspaceId: string, sessionId: string, traceData: Partial<MemoryTrace>): Promise<MemoryTrace> {
    // Use new adapter if available and ready (avoids blocking on SQLite initialization)
    const adapterForAddTrace = this.getReadyAdapter();
    if (adapterForAddTrace) {
      // Ensure session exists before saving trace (referential integrity)
      const existingSession = await this.getSession(workspaceId, sessionId);
      if (!existingSession) {
        await this.addSession(workspaceId, {
          id: sessionId,
          name: `Session ${new Date().toLocaleString()}`,
          description: `Auto-created session for trace storage`,
          startTime: Date.now(),
          isActive: true
        });
      }

      const hybridTrace: Omit<HybridTypes.MemoryTraceData, 'id' | 'workspaceId' | 'sessionId'> = {
        timestamp: traceData.timestamp || Date.now(),
        type: traceData.type,
        content: traceData.content || '',
        metadata: traceData.metadata
      };

      const traceId = await adapterForAddTrace.addTrace(workspaceId, sessionId, hybridTrace);
      await adapterForAddTrace.updateWorkspace(workspaceId, { lastAccessed: Date.now() });

      return {
        id: traceId,
        timestamp: hybridTrace.timestamp,
        type: hybridTrace.type || 'generic',
        content: hybridTrace.content,
        // Safe conversion: HybridTypes.MemoryTraceData.metadata (Record<string, unknown>)
        // is cast to TraceMetadata which is the expected type for MemoryTrace.metadata
        // Note: This metadata may be either TraceMetadata or legacy trace metadata at runtime
        metadata: hybridTrace.metadata as TraceMetadata | undefined
      };
    }

    // Fall back to legacy implementation
    // Load workspace
    const workspace = await this.fileSystem.readWorkspace(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    if (!workspace.sessions[sessionId]) {
      throw new Error(`Session ${sessionId} not found in workspace ${workspaceId}`);
    }

    // Create trace
    const traceId = traceData.id || `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const trace: MemoryTrace = {
      id: traceId,
      timestamp: traceData.timestamp || Date.now(),
      type: traceData.type || 'generic',
      content: traceData.content || '',
      metadata: traceData.metadata
    };

    // Add to session
    workspace.sessions[sessionId].memoryTraces[traceId] = trace;
    workspace.lastAccessed = Date.now();

    // Save workspace
    await this.fileSystem.writeWorkspace(workspaceId, workspace);

    // Update index
    await this.indexManager.updateWorkspaceInIndex(workspace);

    return trace;
  }

  /**
   * Get memory traces from session
   */
  async getMemoryTraces(workspaceId: string, sessionId: string): Promise<MemoryTrace[]> {
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getTraces(workspaceId, sessionId);
        return result.items.map(t => ({
          id: t.id,
          timestamp: t.timestamp,
          type: t.type || 'generic',
          content: t.content,
          // Safe conversion: HybridTypes.MemoryTraceData.metadata (Record<string, unknown>)
          // is cast to TraceMetadata which is the expected type for MemoryTrace.metadata
          metadata: t.metadata as TraceMetadata | undefined
        }));
      },
      async () => {
        const workspace = await this.fileSystem.readWorkspace(workspaceId);
        if (!workspace || !workspace.sessions[sessionId]) {
          return [];
        }
        return Object.values(workspace.sessions[sessionId].memoryTraces);
      }
    );
  }

  /**
   * Add state to session
   * Ensures the session exists before saving (creates it if needed)
   */
  async addState(workspaceId: string, sessionId: string, stateData: Partial<StateData>): Promise<StateData> {
    // Use new adapter if available and ready (avoids blocking on SQLite initialization)
    const adapterForAddState = this.getReadyAdapter();
    if (adapterForAddState) {
      // Ensure session exists before saving state (referential integrity)
      const existingSession = await this.getSession(workspaceId, sessionId);
      if (!existingSession) {
        await this.addSession(workspaceId, {
          id: sessionId,
          name: `Session ${new Date().toLocaleString()}`,
          description: `Auto-created session for state storage`,
          startTime: Date.now(),
          isActive: true
        });
      }

      // Support both new 'state' property and legacy 'snapshot' property
      const stateContent = stateData.state ||
        (stateData as Partial<StateData> & { snapshot?: WorkspaceState }).snapshot ||
        {};

      const hybridState: Omit<HybridTypes.StateData, 'id' | 'workspaceId' | 'sessionId'> = {
        name: stateData.name || 'Untitled State',
        created: stateData.created || Date.now(),
        description: undefined,
        tags: undefined,
        content: stateContent
      };

      const stateId = await adapterForAddState.saveState(workspaceId, sessionId, hybridState);
      await adapterForAddState.updateWorkspace(workspaceId, { lastAccessed: Date.now() });

      return {
        id: stateId,
        name: hybridState.name,
        created: hybridState.created,
        state: hybridState.content
      };
    }

    // Fall back to legacy implementation
    // Load workspace
    const workspace = await this.fileSystem.readWorkspace(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    if (!workspace.sessions[sessionId]) {
      throw new Error(`Session ${sessionId} not found in workspace ${workspaceId}`);
    }

    // Create state
    const stateId = stateData.id || `state_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Support both new 'state' property and legacy 'snapshot' property
    const stateContent = stateData.state ||
      (stateData as Partial<StateData> & { snapshot?: WorkspaceState }).snapshot ||
      {} as WorkspaceState;

    const state: StateData = {
      id: stateId,
      name: stateData.name || 'Untitled State',
      created: stateData.created || Date.now(),
      state: stateContent
    };

    // Add to session
    workspace.sessions[sessionId].states[stateId] = state;
    workspace.lastAccessed = Date.now();

    // Save workspace
    await this.fileSystem.writeWorkspace(workspaceId, workspace);

    // Update index
    await this.indexManager.updateWorkspaceInIndex(workspace);

    return state;
  }

  /**
   * Get state from session
   */
  async getState(workspaceId: string, sessionId: string, stateId: string): Promise<StateData | null> {
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const state = await adapter.getState(stateId);
        if (!state) {
          return null;
        }
        return {
          id: state.id,
          name: state.name,
          created: state.created,
          state: state.content
        };
      },
      async () => {
        const workspace = await this.fileSystem.readWorkspace(workspaceId);
        if (!workspace || !workspace.sessions[sessionId]) {
          return null;
        }
        return workspace.sessions[sessionId].states[stateId] || null;
      }
    );
  }

  /**
   * Search workspaces (uses index search data)
   */
  async searchWorkspaces(query: string, limit?: number): Promise<WorkspaceMetadata[]> {
    if (!query) {
      return this.listWorkspaces(limit);
    }

    return withDualBackend(
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
    return withDualBackend(
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
    return withDualBackend(
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
   * Get workspace by name or ID (unified lookup)
   * Tries ID lookup first (more specific), then falls back to name lookup (case-insensitive)
   * @param identifier Workspace name or ID
   * @returns Full workspace data or null if not found
   */
  async getWorkspaceByNameOrId(identifier: string): Promise<IndividualWorkspace | null> {
    // Try ID lookup first (more specific)
    const byId = await this.getWorkspace(identifier);
    if (byId) {
      return byId;
    }

    // Name lookup via dual backend
    const matchId = await withDualBackend<string | null>(
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

  /**
   * Get session by name or ID within a workspace (unified lookup)
   * Tries ID lookup first, then falls back to name lookup (case-insensitive)
   * @param workspaceId Workspace ID to search in
   * @param identifier Session name or ID
   * @returns Session data or null if not found
   */
  async getSessionByNameOrId(workspaceId: string, identifier: string): Promise<SessionData | null> {
    // Try ID lookup first
    const byId = await this.getSession(workspaceId, identifier);
    if (byId) {
      return byId;
    }

    // Name lookup via dual backend
    return withDualBackend<SessionData | null>(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getSessions(workspaceId, { pageSize: 100 });
        const match = result.items.find(
          session => session.name?.toLowerCase() === identifier.toLowerCase()
        );
        if (!match) {
          return null;
        }
        return this.getSession(workspaceId, match.id);
      },
      async () => {
        const workspace = await this.fileSystem.readWorkspace(workspaceId);
        if (!workspace) {
          return null;
        }
        const sessions = Object.values(workspace.sessions);
        return sessions.find(
          session => session.name?.toLowerCase() === identifier.toLowerCase()
        ) || null;
      }
    );
  }

  /**
   * Get state by name or ID within a session (unified lookup)
   * Tries ID lookup first, then falls back to name lookup (case-insensitive)
   * @param workspaceId Workspace ID
   * @param sessionId Session ID to search in
   * @param identifier State name or ID
   * @returns State data or null if not found
   */
  async getStateByNameOrId(workspaceId: string, sessionId: string, identifier: string): Promise<StateData | null> {
    // Try ID lookup first
    const byId = await this.getState(workspaceId, sessionId, identifier);
    if (byId) {
      return byId;
    }

    // Name lookup via dual backend
    return withDualBackend<StateData | null>(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getStates(workspaceId, sessionId, { pageSize: 100 });
        const match = result.items.find(
          state => state.name?.toLowerCase() === identifier.toLowerCase()
        );
        if (!match) {
          return null;
        }
        return this.getState(workspaceId, sessionId, match.id);
      },
      async () => {
        const workspace = await this.fileSystem.readWorkspace(workspaceId);
        if (!workspace || !workspace.sessions[sessionId]) {
          return null;
        }
        const states = Object.values(workspace.sessions[sessionId].states);
        return states.find(
          state => state.name?.toLowerCase() === identifier.toLowerCase()
        ) || null;
      }
    );
  }

}
