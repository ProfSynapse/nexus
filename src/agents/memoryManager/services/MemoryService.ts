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
import { MemoryTraceData, SessionMetadata, StateMetadata } from '../../../types/storage/HybridStorageTypes';
import { PaginatedResult, PaginationParams, calculatePaginationMetadata } from '../../../types/pagination/PaginationTypes';
import { normalizeLegacyTraceMetadata } from '../../../services/memory/LegacyTraceMetadataNormalizer';
import { StorageAdapterOrGetter, resolveAdapter, withDualBackend, withReadableBackend } from '../../../services/helpers/DualBackendExecutor';

/**
 * MemoryService provides agent-specific logic for memory management
 * Data access is delegated to either:
 * - IStorageAdapter (new hybrid JSONL+SQLite backend with pagination)
 * - WorkspaceService (legacy JSON file backend)
 */
export class MemoryService {
  private storageAdapterOrGetter: StorageAdapterOrGetter;

  constructor(
    private plugin: Plugin,
    private workspaceService: WorkspaceService,
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
    return withReadableBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getTraces(workspaceId, sessionId, options);
        const convertedItems = result.items.map(trace => this.convertToLegacyTrace(trace));
        return {
          ...result,
          items: convertedItems
        };
      },
      async () => {
        let allTraces: WorkspaceMemoryTrace[] = [];

        if (sessionId) {
          const traces = await this.workspaceService.getMemoryTraces(workspaceId, sessionId);
          allTraces = traces.map(trace => ({
            ...trace,
            workspaceId,
            sessionId
          }));
        } else {
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

        return this.wrapInPaginatedResult(allTraces, options);
      }
    );
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
    const sessionId = trace.sessionId || this.createSessionId();

    const tracePayload = {
      timestamp: trace.timestamp || Date.now(),
      type: trace.type || 'generic',
      content: trace.content || '',
      metadata: normalizeLegacyTraceMetadata({
        workspaceId,
        sessionId,
        traceType: trace.type,
        metadata: trace.metadata
      })
    };

    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        try {
          return await adapter.addTrace(workspaceId, sessionId, tracePayload);
        } catch (error) {
          if ((error as Error).message?.includes('session')) {
            await adapter.createSession(workspaceId, {
              id: sessionId,
              name: `Session ${new Date().toLocaleString()}`,
              description: 'Auto-created session',
              startTime: Date.now(),
              isActive: true
            });
            return await adapter.addTrace(workspaceId, sessionId, tracePayload);
          }
          throw error;
        }
      },
      async () => {
        const workspace = await this.workspaceService.getWorkspace(workspaceId);
        if (!workspace) {
          throw new Error(`Workspace ${workspaceId} not found`);
        }

        if (!workspace.sessions[sessionId]) {
          await this.workspaceService.addSession(workspaceId, {
            id: sessionId,
            name: `Session ${new Date().toLocaleString()}`,
            startTime: Date.now(),
            isActive: true,
            memoryTraces: {},
            states: {}
          });
        }

        const createdTrace = await this.workspaceService.addMemoryTrace(workspaceId, sessionId, tracePayload);
        return createdTrace.id;
      }
    );
  }

  /**
   * Create memory trace
   */
  async createMemoryTrace(trace: Omit<WorkspaceMemoryTrace, 'id'>): Promise<WorkspaceMemoryTrace> {
    const workspaceId = trace.workspaceId;
    const sessionId = trace.sessionId || this.createSessionId();
    const traceId = await this.recordActivityTrace({
      ...trace,
      sessionId
    });

    // Retrieve the created trace
    const traces = await this.getMemoryTraces(workspaceId, sessionId);
    const createdTrace = traces.items.find((traceItem) => traceItem.id === traceId);

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
    return withReadableBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getSessions(workspaceId, options);
        const convertedItems = result.items.map(session => this.convertSessionMetadataToWorkspaceSession(session));
        return {
          ...result,
          items: convertedItems
        };
      },
      async () => {
        const workspace = await this.workspaceService.getWorkspace(workspaceId);
        if (!workspace) {
          return this.wrapInPaginatedResult([], options);
        }
        const sessions = Object.values(workspace.sessions).map(session => ({
          ...session,
          workspaceId
        }));
        return this.wrapInPaginatedResult(sessions, options);
      }
    );
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
      description: stateData.description,
      created: stateData.created || Date.now(),
      tags: this.extractStateTags(stateData),
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
    description?: string;
    sessionId?: string;
    workspaceId?: string;
    created: number;
    tags?: string[];
    state: WorkspaceState;
  }>> {
    type StateItem = {
      id: string;
      name: string;
      description?: string;
      sessionId?: string;
      workspaceId?: string;
      created: number;
      tags?: string[];
      state: WorkspaceState;
    };

    return withReadableBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getStates(workspaceId, sessionId, options);
        const convertedItems: StateItem[] = await Promise.all(result.items.map(async stateMeta => {
          const fullState = stateMeta.tags ? null : await adapter.getState(stateMeta.id);
          const tags = stateMeta.tags || this.extractStateTagsFromContent(fullState?.content);
          return {
            id: stateMeta.id,
            name: stateMeta.name,
            description: stateMeta.description,
            sessionId: stateMeta.sessionId,
            workspaceId: stateMeta.workspaceId,
            created: stateMeta.created,
            tags,
            state: this.stateMetadataToWorkspaceState(stateMeta, fullState?.content, tags)
          };
        }));
        return {
          ...result,
          items: convertedItems
        };
      },
      async () => {
        const workspace = await this.workspaceService.getWorkspace(workspaceId);
        let allStates: StateItem[] = [];

        if (workspace) {
          if (sessionId) {
            if (workspace.sessions[sessionId]) {
              allStates = Object.values(workspace.sessions[sessionId].states);
            }
          } else {
            for (const session of Object.values(workspace.sessions)) {
              allStates.push(...Object.values(session.states));
            }
          }
        }

        return this.wrapInPaginatedResult(allStates, options);
      }
    );
  }

  private extractStateTags(state: WorkspaceState): string[] | undefined {
    const tags = state.state?.metadata?.tags;
    return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : undefined;
  }

  private extractStateTagsFromContent(content: unknown): string[] | undefined {
    if (typeof content !== 'object' || content === null || Array.isArray(content)) {
      return undefined;
    }

    const state = content as { state?: { metadata?: { tags?: unknown } } };
    const tags = state.state?.metadata?.tags;
    return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : undefined;
  }

  private stateMetadataToWorkspaceState(state: StateMetadata, content?: unknown, tags: string[] = state.tags || []): WorkspaceState {
    if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
      const workspaceState = content as Partial<WorkspaceState>;
      return {
        ...workspaceState,
        id: workspaceState.id || state.id,
        name: workspaceState.name || state.name,
        workspaceId: workspaceState.workspaceId || state.workspaceId,
        sessionId: workspaceState.sessionId || state.sessionId,
        description: workspaceState.description || state.description,
        created: workspaceState.created || state.created,
        context: workspaceState.context || {
          workspaceContext: {
            purpose: ''
          },
          conversationContext: '',
          activeTask: state.description || '',
          activeFiles: [],
          nextSteps: []
        },
        state: {
          workspace: workspaceState.state?.workspace ?? null,
          recentTraces: workspaceState.state?.recentTraces ?? [],
          contextFiles: workspaceState.state?.contextFiles ?? [],
          metadata: {
            ...workspaceState.state?.metadata,
            tags
          }
        }
      };
    }

    return {
      id: state.id,
      name: state.name,
      workspaceId: state.workspaceId,
      sessionId: state.sessionId,
      description: state.description,
      created: state.created,
      context: {
        workspaceContext: {
          purpose: ''
        },
        conversationContext: '',
        activeTask: state.description || '',
        activeFiles: [],
        nextSteps: []
      },
      state: {
        workspace: null,
        recentTraces: [],
        contextFiles: [],
        metadata: {
          tags
        }
      }
    };
  }

  private createSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
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
