// Location: src/services/migration/DataTransformer.ts
// Transforms ChromaDB collection data into individual conversation and workspace files
// Used by: DataMigrationService to convert legacy data to split-file architecture
// Dependencies: ChromaDataLoader for source data, StorageTypes for target structure

import { IndividualConversation, IndividualWorkspace, MemoryTrace, StateData, ConversationMessage, ToolCall } from '../../types/storage/StorageTypes';
import type { WorkspaceState } from '../../database/types/session/SessionTypes';
import { ChromaCollectionData } from './ChromaDataLoader';
import { normalizeLegacyTraceMetadata } from '../memory/LegacyTraceMetadataNormalizer';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface LegacyMetadata extends Record<string, unknown> {
  conversation?: {
    title?: string;
    created?: number;
    updated?: number;
    vault_name?: string;
    messages?: LegacyMessage[];
  };
  title?: string;
  created?: number;
  updated?: number;
  vault_name?: string;
  workspaceId?: string;
  sessionId?: string;
  name?: string;
  description?: string;
  rootFolder?: string;
  lastAccessed?: number;
  isActive?: boolean;
  startTime?: number;
  endTime?: number;
  context?: string;
  timestamp?: number;
  activityType?: string;
  type?: string;
  params?: string;
  result?: string;
  relatedFiles?: string;
  snapshot?: Record<string, unknown>;
}

interface LegacyDocument extends Record<string, unknown> {
  content?: string;
  timestamp?: number;
}

interface LegacyMessage extends Record<string, unknown> {
  id?: string;
  role?: string;
  content?: string;
  timestamp?: number;
  toolCalls?: unknown;
  toolName?: string;
  toolParams?: unknown;
  toolResult?: unknown;
}

interface LegacyRecord extends Record<string, unknown> {
  id: string;
  metadata?: LegacyMetadata;
  document?: LegacyDocument;
  content?: string;
  snapshot?: Record<string, unknown>;
}

interface LegacyWorkspaceContextMigration extends Record<string, unknown> {
  agents?: Array<{
    id?: string;
    name?: string;
  }>;
  keyFiles?: Array<{
    files?: Record<string, unknown>;
  }> | string[];
  preferences?: unknown[] | string;
  status?: unknown;
  dedicatedAgent?: {
    agentId?: string;
    agentName?: string;
  };
}

export class DataTransformer {

  transformToNewStructure(chromaData: ChromaCollectionData): {
    conversations: IndividualConversation[];
    workspaces: IndividualWorkspace[];
  } {
    const conversations = this.transformConversations(chromaData.conversations as LegacyRecord[]);
    const workspaces = this.transformWorkspaceHierarchy(
      chromaData.workspaces as LegacyRecord[],
      chromaData.sessions as LegacyRecord[],
      chromaData.memoryTraces as LegacyRecord[],
      chromaData.snapshots as LegacyRecord[]
    );
    return { conversations, workspaces };
  }

  private transformConversations(conversations: LegacyRecord[]): IndividualConversation[] {
    const result: IndividualConversation[] = [];

    for (const conv of conversations) {
      try {
        const conversationData = conv.metadata?.conversation || {};
        const messages = conversationData.messages || [];

        const transformed: IndividualConversation = {
          id: conv.id,
          title: conv.metadata?.title || conversationData.title || 'Untitled Conversation',
          created: conv.metadata?.created || conversationData.created || Date.now(),
          updated: conv.metadata?.updated || conversationData.updated || Date.now(),
          vault_name: conv.metadata?.vault_name || conversationData.vault_name || 'Unknown',
          message_count: messages.length,
          messages: this.transformMessages(messages)
        };

        result.push(transformed);
      } catch (error) {
        console.error(`[DataTransformer] Error transforming conversation ${conv.id}:`, error);
      }
    }

    return result;
  }

  private transformMessages(messages: LegacyMessage[]): ConversationMessage[] {
    if (!Array.isArray(messages)) return [];

    return messages.map(msg => ({
      id: msg.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      role: this.normalizeConversationRole(msg.role),
      content: msg.content || '',
      timestamp: msg.timestamp || Date.now(),
      toolCalls: Array.isArray(msg.toolCalls) ? (msg.toolCalls as ToolCall[]) : undefined,
      toolName: msg.toolName,
      toolParams: this.toRecord(msg.toolParams),
      toolResult: msg.toolResult
    }));
  }

  private transformWorkspaceHierarchy(
    workspaces: LegacyRecord[],
    sessions: LegacyRecord[],
    memoryTraces: LegacyRecord[],
    snapshots: LegacyRecord[]
  ): IndividualWorkspace[] {
    // Group data by relationships
    const sessionsByWorkspace = this.groupBy(sessions, s => s.metadata?.workspaceId || 'unknown');
    const tracesBySession = this.groupBy(memoryTraces, t => t.metadata?.sessionId || 'orphan');
    const statesBySession = this.groupBy(snapshots, s => s.metadata?.sessionId || 'orphan');

    const result: IndividualWorkspace[] = [];

    // Build workspace metadata lookup
    const workspaceMetadata = this.keyBy(workspaces, 'id');

    // Process each workspace
    for (const [workspaceId, workspaceSessions] of Object.entries(sessionsByWorkspace)) {
      const wsMetadata = workspaceMetadata[workspaceId];

      try {
        // Parse context if it's a string
        let context;
        if (wsMetadata?.metadata?.context) {
          context = this.parseJSONString(wsMetadata.metadata.context);
          // Apply workspace context migration to new structure
          context = this.migrateWorkspaceContext(context);
        }

        const workspace: IndividualWorkspace = {
          id: workspaceId,
          name: wsMetadata?.metadata?.name || `Workspace ${workspaceId}`,
          description: wsMetadata?.metadata?.description || '',
          rootFolder: wsMetadata?.metadata?.rootFolder || '/',
          created: wsMetadata?.metadata?.created || Date.now(),
          lastAccessed: wsMetadata?.metadata?.lastAccessed || Date.now(),
          isActive: wsMetadata?.metadata?.isActive ?? true,
          context: context as IndividualWorkspace['context'],
          sessions: {}
        };

        // Process sessions within workspace
        for (const session of workspaceSessions) {
          const sessionTraces = tracesBySession[session.id] || [];
          const sessionStates = statesBySession[session.id] || [];

          workspace.sessions[session.id] = {
            id: session.id,
            name: session.metadata?.name,
            description: session.metadata?.description,
            startTime: session.metadata?.startTime || session.metadata?.created || Date.now(),
            endTime: session.metadata?.endTime,
            isActive: session.metadata?.isActive ?? true,
            memoryTraces: this.transformTraces(sessionTraces, workspaceId, session.id),
            states: this.transformStates(sessionStates)
          };
        }

        result.push(workspace);
      } catch (error) {
        console.error(`[DataTransformer] Error processing workspace ${workspaceId}:`, error);
      }
    }

    return result;
  }

  private transformTraces(traces: LegacyRecord[], workspaceId: string, sessionId: string): Record<string, MemoryTrace> {
    const result: Record<string, MemoryTrace> = {};

    for (const trace of traces) {
      try {
        // Extract content from either document.content or direct content
        const content = this.getStringValue(trace.document?.content) ||
          this.getStringValue(trace.content) ||
          this.getStringValue((trace.metadata as Record<string, unknown> | undefined)?.content) ||
          '';
        const legacyParams = this.parseJSONString(trace.metadata?.params);
        const legacyResult = this.parseJSONString(trace.metadata?.result);
        const legacyFiles = this.parseJSONString(trace.metadata?.relatedFiles) || [];
        const mergedMetadata = {
          ...(trace.metadata || {}),
          params: legacyParams,
          result: legacyResult,
          relatedFiles: legacyFiles
        };

        const metadata = normalizeLegacyTraceMetadata({
          workspaceId,
          sessionId,
          traceType: trace.metadata?.activityType || trace.metadata?.type,
          metadata: mergedMetadata
        });

        result[trace.id] = {
          id: trace.id,
          timestamp: trace.metadata?.timestamp || trace.document?.timestamp || Date.now(),
          type: trace.metadata?.activityType || trace.metadata?.type || 'unknown',
          content: content,
          metadata
        };
      } catch (error) {
        console.error(`[DataTransformer] Error transforming trace ${trace.id}:`, error);
      }
    }

    return result;
  }

  private transformStates(states: LegacyRecord[]): Record<string, StateData> {
    const result: Record<string, StateData> = {};

    for (const state of states) {
      try {
        result[state.id] = {
          id: state.id,
          name: state.metadata?.name || 'Unnamed State',
          created: state.metadata?.created || Date.now(),
          state: (state.metadata?.snapshot || state.snapshot || {}) as unknown as WorkspaceState
        };
      } catch (error) {
        console.error(`[DataTransformer] Error transforming state ${state.id}:`, error);
      }
    }

    return result;
  }

  // Utility methods
  private groupBy<T>(array: T[], keyFn: (item: T) => string): Record<string, T[]> {
    return array.reduce((groups, item) => {
      const key = keyFn(item);
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
      return groups;
    }, {} as Record<string, T[]>);
  }

  private keyBy<T extends Record<string, unknown>>(array: T[], key: keyof T): Record<string, T> {
    return array.reduce((result, item) => {
      const keyValue = item[key];
      if (keyValue && typeof keyValue === 'string') result[keyValue] = item;
      return result;
    }, {} as Record<string, T>);
  }

  private parseJSONString(str: string | undefined): JsonValue | string | undefined {
    if (!str) return undefined;
    if (typeof str !== 'string') return str;

    try {
      return JSON.parse(str) as JsonValue;
    } catch {
      return str;
    }
  }

  /**
   * Migrate workspace context from old structure to new structure
   */
  private migrateWorkspaceContext(context: unknown): unknown {
    if (!context || typeof context !== 'object') {
      return context;
    }

    const legacyContext = context as LegacyWorkspaceContextMigration;
    const migratedContext: LegacyWorkspaceContextMigration = { ...legacyContext };

    // Migrate agents array to dedicatedAgent
    if (legacyContext.agents && Array.isArray(legacyContext.agents) && legacyContext.agents.length > 0) {
      const firstAgent = legacyContext.agents[0];
      if (firstAgent && firstAgent.name) {
        migratedContext.dedicatedAgent = {
          agentId: firstAgent.id || firstAgent.name,
          agentName: firstAgent.name
        };
      }
      delete migratedContext.agents;
    }

    // Migrate keyFiles from complex categorized structure to simple array
    if (legacyContext.keyFiles && Array.isArray(legacyContext.keyFiles)) {
      const simpleKeyFiles: string[] = [];
      legacyContext.keyFiles.forEach((category) => {
        if (typeof category === 'string') {
          simpleKeyFiles.push(category);
          return;
        }

        if (category && typeof category === 'object' && 'files' in category) {
          const categoryRecord = category as { files?: Record<string, unknown> };
          if (categoryRecord.files && typeof categoryRecord.files === 'object') {
            Object.values(categoryRecord.files).forEach((filePath: unknown) => {
              if (typeof filePath === 'string') {
                simpleKeyFiles.push(filePath);
              }
            });
          }
        }
      });
      migratedContext.keyFiles = simpleKeyFiles;
    }

    // Migrate preferences from array to string
    if (legacyContext.preferences && Array.isArray(legacyContext.preferences)) {
      const preferencesString = legacyContext.preferences
        .filter((pref: unknown): pref is string => typeof pref === 'string' && pref.trim().length > 0)
        .join('. ') + (legacyContext.preferences.length > 0 ? '.' : '');
      migratedContext.preferences = preferencesString;
    }

    // Remove status field
    if (legacyContext.status) {
      delete migratedContext.status;
    }

    return migratedContext;
  }

  private getStringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private normalizeConversationRole(role: string | undefined): 'user' | 'assistant' | 'tool' {
    return role === 'assistant' || role === 'tool' ? role : 'user';
  }

  private toRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }
}
