// Location: src/services/workspace/WorkspaceStateService.ts
// State and memory trace CRUD operations extracted from WorkspaceService.
// Handles addState, getState, getStateByNameOrId, addMemoryTrace, getMemoryTraces.
// Used by: WorkspaceService (composition delegate)

import { FileSystemService } from '../storage/FileSystemService';
import { IndexManager } from '../storage/IndexManager';
import { MemoryTrace, StateData } from '../../types/storage/StorageTypes';
import * as HybridTypes from '../../types/storage/HybridStorageTypes';
import { TraceMetadata } from '../../database/types/memory/MemoryTypes';
import { WorkspaceState } from '../../database/types/session/SessionTypes';
import { StorageAdapterOrGetter, resolveAdapter, withDualBackend } from '../helpers/DualBackendExecutor';

interface AutoCreatedSessionData {
  id: string;
  name: string;
  description: string;
  startTime: number;
  isActive: boolean;
}

type LegacyStateData = Partial<StateData> & {
  snapshot?: WorkspaceState;
};

function createAutoCreatedSession(sessionId: string, description: string): AutoCreatedSessionData {
  return {
    id: sessionId,
    name: `Session ${new Date().toLocaleString()}`,
    description,
    startTime: Date.now(),
    isActive: true
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTraceMetadata(value: unknown): TraceMetadata | undefined {
  return isRecord(value) ? (value as TraceMetadata) : undefined;
}

function toWorkspaceState(value: unknown): WorkspaceState {
  return isRecord(value) ? (value as WorkspaceState) : {} as WorkspaceState;
}

function resolveStateContent(stateData: LegacyStateData): WorkspaceState {
  return stateData.state ?? stateData.snapshot ?? ({} as WorkspaceState);
}

function buildEntityId(prefix: 'trace' | 'state'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Dependencies injected from WorkspaceService to avoid circular references.
 * WorkspaceStateService needs session-level operations for referential integrity
 * (e.g., ensuring session exists before creating a state or trace).
 */
export interface WorkspaceStateDeps {
  getSession: (workspaceId: string, sessionId: string) => Promise<unknown>;
  addSession: (workspaceId: string, sessionData: AutoCreatedSessionData) => Promise<unknown>;
}

export class WorkspaceStateService {
  constructor(
    private fileSystem: FileSystemService,
    private indexManager: IndexManager,
    private storageAdapterOrGetter: StorageAdapterOrGetter,
    private sessionDeps: WorkspaceStateDeps
  ) {}

  /**
   * Add memory trace to session.
   * Ensures the session exists before saving (creates it if needed).
   */
  async addMemoryTrace(workspaceId: string, sessionId: string, traceData: Partial<MemoryTrace>): Promise<MemoryTrace> {
    const adapter = resolveAdapter(this.storageAdapterOrGetter);
    if (adapter) {
      // Ensure session exists before saving trace (referential integrity)
      const existingSession = await this.sessionDeps.getSession(workspaceId, sessionId);
      if (!existingSession) {
        await this.sessionDeps.addSession(
          workspaceId,
          createAutoCreatedSession(sessionId, 'Auto-created session for trace storage')
        );
      }

      const hybridTrace: Omit<HybridTypes.MemoryTraceData, 'id' | 'workspaceId' | 'sessionId'> = {
        timestamp: traceData.timestamp || Date.now(),
        type: traceData.type,
        content: traceData.content || '',
        metadata: traceData.metadata
      };

      const traceId = await adapter.addTrace(workspaceId, sessionId, hybridTrace);
      await adapter.updateWorkspace(workspaceId, { lastAccessed: Date.now() });

      return {
        id: traceId,
        timestamp: hybridTrace.timestamp,
        type: hybridTrace.type || 'generic',
        content: hybridTrace.content,
        // Safe conversion: HybridTypes.MemoryTraceData.metadata (Record<string, unknown>)
        // is cast to TraceMetadata which is the expected type for MemoryTrace.metadata
        // Note: This metadata may be either TraceMetadata or legacy trace metadata at runtime
        metadata: toTraceMetadata(hybridTrace.metadata)
      };
    }

    // Fall back to legacy implementation
    const workspace = await this.fileSystem.readWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    if (!workspace.sessions[sessionId]) {
      throw new Error(`Session ${sessionId} not found in workspace ${workspaceId}`);
    }

    const traceId = traceData.id || buildEntityId('trace');
    const trace: MemoryTrace = {
      id: traceId,
      timestamp: traceData.timestamp || Date.now(),
      type: traceData.type || 'generic',
      content: traceData.content || '',
      metadata: traceData.metadata
    };

    workspace.sessions[sessionId].memoryTraces[traceId] = trace;
    workspace.lastAccessed = Date.now();
    await this.fileSystem.writeWorkspace(workspaceId, workspace);
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
          metadata: toTraceMetadata(t.metadata)
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
   * Add state to session.
   * Ensures the session exists before saving (creates it if needed).
   */
  async addState(workspaceId: string, sessionId: string, stateData: Partial<StateData>): Promise<StateData> {
    const adapter = resolveAdapter(this.storageAdapterOrGetter);
    if (adapter) {
      // Ensure session exists before saving state (referential integrity)
      const existingSession = await this.sessionDeps.getSession(workspaceId, sessionId);
      if (!existingSession) {
        await this.sessionDeps.addSession(
          workspaceId,
          createAutoCreatedSession(sessionId, 'Auto-created session for state storage')
        );
      }

      // Support both new 'state' property and legacy 'snapshot' property
      const stateContent = resolveStateContent(stateData);

      const hybridState: Omit<HybridTypes.StateData, 'id' | 'workspaceId' | 'sessionId'> = {
        name: stateData.name || 'Untitled State',
        created: stateData.created || Date.now(),
        description: undefined,
        tags: undefined,
        content: stateContent
      };

      const stateId = await adapter.saveState(workspaceId, sessionId, hybridState);
      await adapter.updateWorkspace(workspaceId, { lastAccessed: Date.now() });

      return {
        id: stateId,
        name: hybridState.name,
        created: hybridState.created,
        state: toWorkspaceState(hybridState.content)
      };
    }

    // Fall back to legacy implementation
    const workspace = await this.fileSystem.readWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    if (!workspace.sessions[sessionId]) {
      throw new Error(`Session ${sessionId} not found in workspace ${workspaceId}`);
    }

    const stateId = stateData.id || buildEntityId('state');

    // Support both new 'state' property and legacy 'snapshot' property
    const stateContent = resolveStateContent(stateData);

    const state: StateData = {
      id: stateId,
      name: stateData.name || 'Untitled State',
      created: stateData.created || Date.now(),
      state: stateContent
    };

    workspace.sessions[sessionId].states[stateId] = state;
    workspace.lastAccessed = Date.now();
    await this.fileSystem.writeWorkspace(workspaceId, workspace);
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
          state: toWorkspaceState(state.content)
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
   * Get state by name or ID within a session (unified lookup).
   * Tries ID lookup first, then falls back to name lookup (case-insensitive).
   * @param workspaceId Workspace ID
   * @param sessionId Session ID to search in
   * @param identifier State name or ID
   * @returns State data or null if not found
   */
  async getStateByNameOrId(workspaceId: string, sessionId: string, identifier: string): Promise<StateData | null> {
    const byId = await this.getState(workspaceId, sessionId, identifier);
    if (byId) {
      return byId;
    }

    return withDualBackend<StateData | null>(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getStates(workspaceId, sessionId, { pageSize: 100 });
        const match = result.items.find(
          (state: HybridTypes.StateData) => state.name?.toLowerCase() === identifier.toLowerCase()
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
