// Location: src/agents/memoryManager/services/MemoryService.ts
// Agent-specific memory management service that delegates to WorkspaceService or IStorageAdapter
// Used by: MemoryManager agent tools for memory operations
// Dependencies: WorkspaceService (legacy) or IStorageAdapter (new) for all data access

import { Plugin } from 'obsidian';
import { WorkspaceService } from '../../../services/WorkspaceService';
import { IStorageAdapter } from '../../../database/interfaces/IStorageAdapter';
import {
  WorkspaceMemoryTrace,
  WorkspaceSession,
  WorkspaceState
} from '../../../database/workspace-types';
import { MemoryTraceData, SessionMetadata } from '../../../types/storage/HybridStorageTypes';
import { PaginatedResult, PaginationParams, calculatePaginationMetadata } from '../../../types/pagination/PaginationTypes';
import { normalizeLegacyTraceMetadata } from '../../../services/memory/LegacyTraceMetadataNormalizer';

/**
 * MemoryService provides agent-specific logic for memory management
 * Data access is delegated to either:
 * - IStorageAdapter (new hybrid JSONL+SQLite backend with pagination)
 * - WorkspaceService (legacy JSON file backend)
 */
export class MemoryService {
  constructor(
    private plugin: Plugin,
    private workspaceService: WorkspaceService,
    private storageAdapter?: IStorageAdapter
  ) {}

  /**
   * Get memory traces from a workspace/session
   * @param workspaceId - Workspace ID
   * @param sessionId - Optional session ID to filter by
   * @param options - Optional pagination parameters
   * @returns Always returns PaginatedResult for consistent API
   */
  async getMemoryTraces(
    workspaceId: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<WorkspaceMemoryTrace>> {
    // Use new storage adapter if available
    if (this.storageAdapter) {
      const result = await this.storageAdapter.getTraces(workspaceId, sessionId, options);

      // Convert MemoryTraceData to WorkspaceMemoryTrace format
      const convertedItems = result.items.map(trace => this.convertToLegacyTrace(trace));

      return {
        ...result,
        items: convertedItems
      };
    }

    // Legacy path: use WorkspaceService
    let allTraces: WorkspaceMemoryTrace[] = [];

    if (sessionId) {
      // Get traces from specific session
      const traces = await this.workspaceService.getMemoryTraces(workspaceId, sessionId);
      allTraces = traces.map(trace => ({
        ...trace,
        workspaceId,
        sessionId
      }));
    } else {
      // Get all traces from all sessions in workspace
      const workspace = await this.workspaceService.getWorkspace(workspaceId);

      if (workspace) {
        for (const [sid, session] of Object.entries(workspace.sessions)) {
          const sessionTraces = Object.values(session.memoryTraces).map(trace => ({
            ...trace,
            workspaceId,
            sessionId: sid
          }));
          allTraces.push(...sessionTraces);
        }
      }
    }

    // Wrap in PaginatedResult for consistent return type
    return this.wrapInPaginatedResult(allTraces, options);
  }

  /**
   * Helper to wrap an array in a PaginatedResult
   */
  private wrapInPaginatedResult<T>(items: T[], options?: PaginationParams): PaginatedResult<T> {
    const page = options?.page ?? 0;
    const pageSize = options?.pageSize ?? (items.length || 1); // Default to all items
    const totalItems = items.length;

    // Apply pagination if options provided
    const start = page * pageSize;
    const end = start + pageSize;
    const paginatedItems = options ? items.slice(start, end) : items;

    return {
      items: paginatedItems,
      ...calculatePaginationMetadata(page, pageSize, totalItems)
    };
  }

  /**
   * Helper to convert MemoryTraceData to WorkspaceMemoryTrace format
   */
  private convertToLegacyTrace(trace: MemoryTraceData): WorkspaceMemoryTrace {
    return {
      id: trace.id,
      workspaceId: trace.workspaceId,
      sessionId: trace.sessionId,
      timestamp: trace.timestamp,
      type: trace.type || 'generic',
      content: trace.content,
      metadata: trace.metadata
    };
  }

  /**
   * Helper to convert WorkspaceMemoryTrace to MemoryTraceData format
   */
  private convertFromLegacyTrace(trace: WorkspaceMemoryTrace): MemoryTraceData {
    return {
      id: trace.id,
      workspaceId: trace.workspaceId,
      sessionId: trace.sessionId || '',
      timestamp: trace.timestamp,
      type: trace.type,
      content: trace.content,
      metadata: trace.metadata
    };
  }

  /**
   * Record activity trace in a session
   */
  async recordActivityTrace(trace: Omit<WorkspaceMemoryTrace, 'id'>): Promise<string> {
    const workspaceId = trace.workspaceId;
    let sessionId = trace.sessionId || 'default-session';

    // Use new storage adapter if available
    if (this.storageAdapter) {
      try {
        const traceId = await this.storageAdapter.addTrace(workspaceId, sessionId, {
          timestamp: trace.timestamp || Date.now(),
          type: trace.type || 'generic',
          content: trace.content || '',
          metadata: normalizeLegacyTraceMetadata({
            workspaceId,
            sessionId,
            traceType: trace.type,
            metadata: trace.metadata
          })
        });
        return traceId;
      } catch (error) {
        // If session doesn't exist, try to create it first
        if ((error as Error).message?.includes('session')) {
          await this.storageAdapter.createSession(workspaceId, {
            name: 'Default Session',
            description: 'Auto-created session',
            startTime: Date.now(),
            isActive: true
          });
          // Retry adding trace
          return await this.storageAdapter.addTrace(workspaceId, sessionId, {
            timestamp: trace.timestamp || Date.now(),
            type: trace.type || 'generic',
            content: trace.content || '',
            metadata: normalizeLegacyTraceMetadata({
              workspaceId,
              sessionId,
              traceType: trace.type,
              metadata: trace.metadata
            })
          });
        }
        throw error;
      }
    }

    // Legacy path: use WorkspaceService
    // Ensure workspace exists
    const workspace = await this.workspaceService.getWorkspace(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    // Create session if it doesn't exist
    if (!workspace.sessions[sessionId]) {
      await this.workspaceService.addSession(workspaceId, {
        id: sessionId,
        name: 'Default Session',
        startTime: Date.now(),
        isActive: true,
        memoryTraces: {},
        states: {}
      });
    }

    // Add trace to session
    const createdTrace = await this.workspaceService.addMemoryTrace(workspaceId, sessionId, {
      timestamp: trace.timestamp || Date.now(),
      type: trace.type || 'generic',
      content: trace.content || '',
      metadata: normalizeLegacyTraceMetadata({
        workspaceId,
        sessionId,
        traceType: trace.type,
        metadata: trace.metadata
      })
    });

    return createdTrace.id;
  }

  /**
   * Create memory trace
   */
  async createMemoryTrace(trace: Omit<WorkspaceMemoryTrace, 'id'>): Promise<WorkspaceMemoryTrace> {
    const traceId = await this.recordActivityTrace(trace);
    const workspaceId = trace.workspaceId;
    const sessionId = trace.sessionId || 'default-session';

    // Retrieve the created trace
    const traces = await this.workspaceService.getMemoryTraces(workspaceId, sessionId);
    const createdTrace = traces.find(t => t.id === traceId);

    if (!createdTrace) {
      throw new Error('Failed to retrieve created memory trace');
    }

    return {
      ...createdTrace,
      workspaceId,
      sessionId
    };
  }

  /**
   * Get sessions for a workspace
   * @param workspaceId - Workspace ID
   * @param options - Optional pagination parameters
   * @returns Always returns PaginatedResult for consistent API
   */
  async getSessions(
    workspaceId: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<WorkspaceSession>> {
    // Use new storage adapter if available
    if (this.storageAdapter) {
      const result = await this.storageAdapter.getSessions(workspaceId, options);

      // Convert SessionMetadata to WorkspaceSession format
      const convertedItems = result.items.map(session => this.convertSessionMetadataToWorkspaceSession(session));

      return {
        ...result,
        items: convertedItems
      };
    }

    // Legacy path: use WorkspaceService
    const workspace = await this.workspaceService.getWorkspace(workspaceId);

    if (!workspace) {
      return this.wrapInPaginatedResult([], options);
    }

    const sessions = Object.values(workspace.sessions).map(session => ({
      ...session,
      workspaceId
    }));

    // Wrap in PaginatedResult for consistent return type
    return this.wrapInPaginatedResult(sessions, options);
  }

  /**
   * Helper to convert SessionMetadata to WorkspaceSession format
   */
  private convertSessionMetadataToWorkspaceSession(metadata: SessionMetadata): WorkspaceSession {
    return {
      id: metadata.id,
      workspaceId: metadata.workspaceId,
      name: metadata.name,
      description: metadata.description
    };
  }

  /**
   * Create session in workspace
   */
  async createSession(session: Omit<WorkspaceSession, 'id'> & {
    id?: string;
    workspaceId: string;
    startTime?: number;
    endTime?: number;
    isActive?: boolean;
  }): Promise<WorkspaceSession> {
    const workspaceId = session.workspaceId;
    const sessionId = session.id; // Extract ID if provided

    const createdSession = await this.workspaceService.addSession(workspaceId, {
      id: sessionId, // Pass the ID through!
      name: session.name,
      description: session.description,
      startTime: session.startTime || Date.now(),
      endTime: session.endTime,
      isActive: session.isActive ?? true,
      memoryTraces: {},
      states: {}
    });

    return {
      ...createdSession,
      workspaceId
    };
  }

  /**
   * Update session
   */
  async updateSession(workspaceId: string, sessionId: string, updates: Partial<WorkspaceSession>): Promise<void> {
    await this.workspaceService.updateSession(workspaceId, sessionId, updates);
  }

  /**
   * Get session by ID
   */
  async getSession(workspaceId: string, sessionId: string): Promise<WorkspaceSession | null> {
    const session = await this.workspaceService.getSession(workspaceId, sessionId);

    if (!session) {
      return null;
    }

    return {
      ...session,
      workspaceId
    };
  }

  /**
   * Get session by name or ID (unified lookup)
   * Tries ID lookup first, then falls back to name lookup
   */
  async getSessionByNameOrId(workspaceId: string, identifier: string): Promise<WorkspaceSession | null> {
    const session = await this.workspaceService.getSessionByNameOrId(workspaceId, identifier);

    if (!session) {
      return null;
    }

    return {
      ...session,
      workspaceId
    };
  }

  /**
   * Delete session
   */
  async deleteSession(workspaceId: string, sessionId: string): Promise<void> {
    await this.workspaceService.deleteSession(workspaceId, sessionId);
  }

  /**
   * Save state to session
   */
  async saveState(
    workspaceId: string,
    sessionId: string,
    stateData: WorkspaceState,
    name?: string
  ): Promise<string> {
    const state = await this.workspaceService.addState(workspaceId, sessionId, {
      id: stateData.id,  // Pass the ID to preserve it
      name: name || stateData.name || 'Unnamed State',
      created: stateData.created || Date.now(),
      state: stateData
    });

    return state.id;
  }

  /**
   * Get state from session by ID
   */
  async getState(
    workspaceId: string,
    sessionId: string,
    stateId: string
  ): Promise<WorkspaceState | null> {
    const stateData = await this.workspaceService.getState(workspaceId, sessionId, stateId);

    if (!stateData) {
      return null;
    }

    return stateData.state;
  }

  /**
   * Get state by name or ID (unified lookup)
   * Tries ID lookup first, then falls back to name lookup
   */
  async getStateByNameOrId(
    workspaceId: string,
    sessionId: string,
    identifier: string
  ): Promise<WorkspaceState | null> {
    const stateData = await this.workspaceService.getStateByNameOrId(workspaceId, sessionId, identifier);

    if (!stateData) {
      return null;
    }

    return stateData.state;
  }

  /**
   * State item type for getStates return
   */
  private static readonly StateItem = {} as {
    id: string;
    name: string;
    created: number;
    state: WorkspaceState;
  };

  /**
   * Get all states for a session (or all sessions in workspace if sessionId not provided)
   * @param workspaceId - Workspace ID
   * @param sessionId - Optional session ID to filter by
   * @param options - Optional pagination parameters
   * @returns Always returns PaginatedResult for consistent API
   */
  async getStates(
    workspaceId: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<{
    id: string;
    name: string;
    created: number;
    state: WorkspaceState;
  }>> {
    type StateItem = { id: string; name: string; created: number; state: WorkspaceState };

    // Use new storage adapter if available
    if (this.storageAdapter) {
      const result = await this.storageAdapter.getStates(workspaceId, sessionId, options);

      // Convert StateMetadata to legacy format
      const convertedItems: StateItem[] = result.items.map(stateMeta => ({
        id: stateMeta.id,
        name: stateMeta.name,
        created: stateMeta.created,
        state: {} as WorkspaceState // Metadata doesn't include full content
      }));

      return {
        ...result,
        items: convertedItems
      };
    }

    // Legacy path: use WorkspaceService
    const workspace = await this.workspaceService.getWorkspace(workspaceId);
    let allStates: StateItem[] = [];

    if (workspace) {
      // If sessionId provided, get states for that session only
      if (sessionId) {
        if (workspace.sessions[sessionId]) {
          allStates = Object.values(workspace.sessions[sessionId].states);
        }
      } else {
        // Get all states from all sessions in workspace
        for (const session of Object.values(workspace.sessions)) {
          allStates.push(...Object.values(session.states));
        }
      }
    }

    // Wrap in PaginatedResult for consistent return type
    return this.wrapInPaginatedResult(allStates, options);
  }

  /**
   * Update state
   */
  async updateState(
    workspaceId: string,
    sessionId: string,
    stateId: string,
    updates: Partial<{
      name: string;
      state: WorkspaceState;
    }>
  ): Promise<void> {
    const workspace = await this.workspaceService.getWorkspace(workspaceId);

    if (!workspace || !workspace.sessions[sessionId] || !workspace.sessions[sessionId].states[stateId]) {
      throw new Error('State not found');
    }

    // Update the state
    const state = workspace.sessions[sessionId].states[stateId];
    workspace.sessions[sessionId].states[stateId] = {
      ...state,
      ...updates
    };

    // Save workspace
    await this.workspaceService.updateWorkspace(workspaceId, workspace);
  }

  /**
   * Delete state
   */
  async deleteState(
    workspaceId: string,
    sessionId: string,
    stateId: string
  ): Promise<void> {
    const workspace = await this.workspaceService.getWorkspace(workspaceId);

    if (!workspace || !workspace.sessions[sessionId]) {
      throw new Error('Session not found');
    }

    // Delete the state
    delete workspace.sessions[sessionId].states[stateId];

    // Save workspace
    await this.workspaceService.updateWorkspace(workspaceId, workspace);
  }

}
