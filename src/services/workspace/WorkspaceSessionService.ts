// Location: src/services/workspace/WorkspaceSessionService.ts
// Session CRUD operations extracted from WorkspaceService.
// Handles addSession, updateSession, deleteSession, getSession, getSessionByNameOrId.
// Used by: WorkspaceService (composition delegate)

import { FileSystemService } from '../storage/FileSystemService';
import { IndexManager } from '../storage/IndexManager';
import { SessionData } from '../../types/storage/StorageTypes';
import { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import * as HybridTypes from '../../types/storage/HybridStorageTypes';
import { StorageAdapterOrGetter, resolveAdapter, withDualBackend } from '../helpers/DualBackendExecutor';

const GLOBAL_WORKSPACE_ID = 'default';

/**
 * Dependencies injected from WorkspaceService to avoid circular references.
 * WorkspaceSessionService needs access to workspace-level operations for
 * referential integrity checks (e.g., ensuring workspace exists before creating session).
 */
export interface WorkspaceSessionDeps {
  getWorkspace: (id: string) => Promise<any>;
  createWorkspace: (data: any) => Promise<any>;
}

export class WorkspaceSessionService {
  constructor(
    private fileSystem: FileSystemService,
    private indexManager: IndexManager,
    private storageAdapterOrGetter: StorageAdapterOrGetter,
    private workspaceDeps: WorkspaceSessionDeps
  ) {}

  /**
   * Add session to workspace.
   * Ensures the workspace exists before creating session.
   */
  async addSession(workspaceId: string, sessionData: Partial<SessionData>): Promise<SessionData> {
    const adapter = resolveAdapter(this.storageAdapterOrGetter);
    if (adapter) {
      // Ensure workspace exists before creating session (referential integrity)
      const existingWorkspace = await this.workspaceDeps.getWorkspace(workspaceId);
      if (!existingWorkspace) {
        if (workspaceId === GLOBAL_WORKSPACE_ID) {
          await this.workspaceDeps.createWorkspace({
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

      const sessionId = await adapter.createSession(workspaceId, hybridSession);
      await adapter.updateWorkspace(workspaceId, { lastAccessed: Date.now() });

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
    const workspace = await this.fileSystem.readWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

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

    workspace.sessions[sessionId] = session;
    workspace.lastAccessed = Date.now();
    await this.fileSystem.writeWorkspace(workspaceId, workspace);
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
   * Get session by name or ID within a workspace (unified lookup).
   * Tries ID lookup first, then falls back to name lookup (case-insensitive).
   * @param workspaceId Workspace ID to search in
   * @param identifier Session name or ID
   * @returns Session data or null if not found
   */
  async getSessionByNameOrId(workspaceId: string, identifier: string): Promise<SessionData | null> {
    const byId = await this.getSession(workspaceId, identifier);
    if (byId) {
      return byId;
    }

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
}
