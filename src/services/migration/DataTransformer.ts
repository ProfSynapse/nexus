// Location: src/services/migration/DataTransformer.ts
// Transforms ChromaDB collection data into individual conversation and workspace files
// Used by: DataMigrationService to convert legacy data to split-file architecture
// Dependencies: ChromaDataLoader for source data, StorageTypes for target structure

import { IndividualConversation, IndividualWorkspace, MemoryTrace, StateData } from '../../types/storage/StorageTypes';
import { ChromaCollectionData } from './ChromaDataLoader';
import { normalizeLegacyTraceMetadata } from '../memory/LegacyTraceMetadataNormalizer';

type LegacyRecord = Record<string, unknown>;

interface LegacyConversationRecord {
  id?: string;
  metadata?: LegacyConversationMetadata;
}

interface LegacyMessageRecord {
  id?: string;
  role?: string;
  content?: string;
  timestamp?: number;
  toolCalls?: unknown;
  toolName?: unknown;
  toolParams?: unknown;
  toolResult?: unknown;
}

interface LegacyConversationMetadata extends LegacyRecord {
  title?: string;
  created?: number;
  updated?: number;
  vault_name?: string;
  conversation?: {
    title?: string;
    created?: number;
    updated?: number;
    vault_name?: string;
    messages?: unknown[];
    [key: string]: unknown;
  };
}

interface LegacySessionMetadata extends LegacyRecord {
  workspaceId?: string;
  name?: string;
  description?: string;
  startTime?: number;
  created?: number;
  endTime?: number;
  isActive?: boolean;
}

interface LegacySessionRecord {
  id?: string;
  metadata?: LegacySessionMetadata;
}

interface LegacyTraceMetadata extends LegacyRecord {
  sessionId?: string;
  content?: string;
  params?: unknown;
  result?: unknown;
  relatedFiles?: unknown;
  activityType?: string;
  type?: string;
  timestamp?: number;
}

interface LegacyTraceRecord {
  id?: string;
  document?: {
    content?: string;
    timestamp?: number;
    [key: string]: unknown;
  };
  content?: string;
  metadata?: LegacyTraceMetadata;
}

interface LegacyStateMetadata extends LegacyRecord {
  name?: string;
  created?: number;
  snapshot?: unknown;
}

interface LegacyStateRecord {
  id?: string;
  metadata?: LegacyStateMetadata;
  snapshot?: unknown;
}

interface LegacyWorkspaceContext extends LegacyRecord {
  agents?: Array<{
    id?: string;
    name?: string;
    [key: string]: unknown;
  }>;
  keyFiles?: Array<{
    files?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  preferences?: unknown[];
  status?: unknown;
  dedicatedAgent?: {
    agentId?: string;
    agentName?: string;
  };
}

function isRecord(value: unknown): value is LegacyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isLegacyConversationRecord(value: unknown): value is LegacyConversationRecord {
  return isRecord(value);
}

function isLegacySessionRecord(value: unknown): value is LegacySessionRecord {
  return isRecord(value);
}

function isLegacyTraceRecord(value: unknown): value is LegacyTraceRecord {
  return isRecord(value);
}

function isLegacyStateRecord(value: unknown): value is LegacyStateRecord {
  return isRecord(value);
}

function isLegacyWorkspaceContext(value: unknown): value is LegacyWorkspaceContext {
  return isRecord(value);
}

function getString(value: unknown, fallback: string): string {
  return isString(value) && value.length > 0 ? value : fallback;
}

function getNumber(value: unknown, fallback: number): number {
  return isNumber(value) ? value : fallback;
}

function getBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export class DataTransformer {

  transformToNewStructure(chromaData: ChromaCollectionData): {
    conversations: IndividualConversation[];
    workspaces: IndividualWorkspace[];
  } {
    const conversations = this.transformConversations(chromaData.conversations);
    const workspaces = this.transformWorkspaceHierarchy(
      chromaData.workspaces,
      chromaData.sessions,
      chromaData.memoryTraces,
      chromaData.snapshots
    );
    return { conversations, workspaces };
  }

  private transformConversations(conversations: unknown[]): IndividualConversation[] {
    const result: IndividualConversation[] = [];

    for (const conv of conversations) {
      try {
        if (!isLegacyConversationRecord(conv)) {
          continue;
        }

        const metadata = isRecord(conv.metadata) ? conv.metadata : undefined;
        const conversationData = isRecord(metadata?.conversation) ? metadata.conversation : undefined;
        const messages = isUnknownArray(conversationData?.messages) ? conversationData.messages : [];

        const transformed: IndividualConversation = {
          id: getString(conv.id, 'unknown'),
          title: getString(metadata?.title ?? conversationData?.title, 'Untitled Conversation'),
          created: getNumber(metadata?.created ?? conversationData?.created, Date.now()),
          updated: getNumber(metadata?.updated ?? conversationData?.updated, Date.now()),
          vault_name: getString(metadata?.vault_name ?? conversationData?.vault_name, 'Unknown'),
          message_count: messages.length,
          messages: this.transformMessages(messages)
        };

        result.push(transformed);
      } catch (error) {
        console.error(`[DataTransformer] Error transforming conversation ${isLegacyConversationRecord(conv) && isString(conv.id) ? conv.id : 'unknown'}:`, error);
      }
    }

    return result;
  }

  private transformMessages(messages: unknown[]): Array<Record<string, unknown>> {
    if (!Array.isArray(messages)) return [];

    return messages.map(msg => {
      const message = isRecord(msg) ? (msg as LegacyMessageRecord) : {};
      return {
        id: getString(message.id, `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`),
        role: getString(message.role, 'user'),
        content: getString(message.content, ''),
        timestamp: getNumber(message.timestamp, Date.now()),
        toolCalls: message.toolCalls,
        toolName: message.toolName,
        toolParams: message.toolParams,
        toolResult: message.toolResult
      };
    });
  }

  private transformWorkspaceHierarchy(
    workspaces: unknown[],
    sessions: unknown[],
    memoryTraces: unknown[],
    snapshots: unknown[]
  ): IndividualWorkspace[] {
    // Group data by relationships
    const sessionsByWorkspace = this.groupBy(sessions, session => {
      const metadata = this.getSessionMetadata(session);
      return getString(metadata?.workspaceId, 'unknown');
    });
    const tracesBySession = this.groupBy(memoryTraces, trace => {
      const metadata = this.getTraceMetadata(trace);
      return getString(metadata?.sessionId, 'orphan');
    });
    const statesBySession = this.groupBy(snapshots, state => {
      const metadata = this.getStateMetadata(state);
      return getString(metadata?.sessionId, 'orphan');
    });

    const result: IndividualWorkspace[] = [];

    // Build workspace metadata lookup
    const workspaceMetadata = this.keyBy(workspaces, 'id');

    // Process each workspace
    for (const [workspaceId, workspaceSessions] of Object.entries(sessionsByWorkspace)) {
      const wsMetadata = workspaceMetadata[workspaceId];

      try {
        // Parse context if it's a string
        let context: unknown;
        if (wsMetadata?.metadata?.context) {
          context = this.parseJSONString(wsMetadata.metadata.context);
          // Apply workspace context migration to new structure
          context = this.migrateWorkspaceContext(context);
        }

        const workspace: IndividualWorkspace = {
          id: workspaceId,
          name: getString(wsMetadata?.metadata?.name, `Workspace ${workspaceId}`),
          description: getString(wsMetadata?.metadata?.description, ''),
          rootFolder: getString(wsMetadata?.metadata?.rootFolder, '/'),
          created: getNumber(wsMetadata?.metadata?.created, Date.now()),
          lastAccessed: getNumber(wsMetadata?.metadata?.lastAccessed, Date.now()),
          isActive: getBoolean(wsMetadata?.metadata?.isActive, true),
          context,
          sessions: {}
        };

        // Process sessions within workspace
        for (const session of workspaceSessions) {
          if (!isRecord(session)) {
            continue;
          }

          const sessionId = getString(session.id, 'unknown');
          const sessionTraces = tracesBySession[sessionId] || [];
          const sessionStates = statesBySession[sessionId] || [];
          const sessionMetadata = this.getSessionMetadata(session);

          workspace.sessions[sessionId] = {
            id: sessionId,
            name: sessionMetadata?.name,
            description: sessionMetadata?.description,
            startTime: getNumber(sessionMetadata?.startTime ?? sessionMetadata?.created, Date.now()),
            endTime: sessionMetadata?.endTime,
            isActive: sessionMetadata?.isActive ?? true,
            memoryTraces: this.transformTraces(sessionTraces, workspaceId, sessionId),
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

  private transformTraces(traces: unknown[], workspaceId: string, sessionId: string): Record<string, MemoryTrace> {
    const result: Record<string, MemoryTrace> = {};

    for (const trace of traces) {
      try {
        if (!isLegacyTraceRecord(trace)) {
          continue;
        }

        const metadata = this.getTraceMetadata(trace);
        const traceDocument = isRecord(trace.document) ? trace.document : undefined;
        // Extract content from either document.content or direct content
        const content = getString(traceDocument?.content ?? trace.content ?? metadata?.content, '');
        const legacyParams = this.parseJSONString(metadata?.params);
        const legacyResult = this.parseJSONString(metadata?.result);
        const legacyFiles = this.parseJSONString(metadata?.relatedFiles) || [];
        const mergedMetadata = {
          ...(metadata || {}),
          params: legacyParams,
          result: legacyResult,
          relatedFiles: legacyFiles
        };

        const normalizedMetadata = normalizeLegacyTraceMetadata({
          workspaceId,
          sessionId,
          traceType: metadata?.activityType || metadata?.type,
          metadata: mergedMetadata
        });

        const traceId = getString(trace.id, `trace_${Date.now()}`);
        result[traceId] = {
          id: traceId,
          timestamp: getNumber(normalizedMetadata?.timestamp ?? traceDocument?.timestamp, Date.now()),
          type: getString(normalizedMetadata?.activityType ?? normalizedMetadata?.type, 'unknown'),
          content: content,
          metadata: normalizedMetadata
        };
      } catch (error) {
        console.error(`[DataTransformer] Error transforming trace ${isLegacyTraceRecord(trace) && isString(trace.id) ? trace.id : 'unknown'}:`, error);
      }
    }

    return result;
  }

  private transformStates(states: unknown[]): Record<string, StateData> {
    const result: Record<string, StateData> = {};

    for (const state of states) {
      try {
        if (!isLegacyStateRecord(state)) {
          continue;
        }

        const metadata = this.getStateMetadata(state);
        const stateId = getString(state.id, `state_${Date.now()}`);
        result[stateId] = {
          id: stateId,
          name: getString(metadata?.name, 'Unnamed State'),
          created: getNumber(metadata?.created, Date.now()),
          state: metadata?.snapshot || state.snapshot || {}
        };
      } catch (error) {
        console.error(`[DataTransformer] Error transforming state ${isLegacyStateRecord(state) && isString(state.id) ? state.id : 'unknown'}:`, error);
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

  private parseJSONString(str: unknown): unknown {
    if (!str) return undefined;
    if (typeof str !== 'string') return str;

    try {
      return JSON.parse(str);
    } catch {
      return str;
    }
  }

  /**
   * Migrate workspace context from old structure to new structure
   */
  private migrateWorkspaceContext(context: unknown): unknown {
    if (!isLegacyWorkspaceContext(context)) {
      return context;
    }

    const migratedContext = { ...context } as LegacyWorkspaceContext;

    // Migrate agents array to dedicatedAgent
    if (Array.isArray(context.agents) && context.agents.length > 0) {
      const firstAgent = context.agents[0];
      if (isRecord(firstAgent) && isString(firstAgent.name)) {
        migratedContext.dedicatedAgent = {
          agentId: getString(firstAgent.id, firstAgent.name),
          agentName: firstAgent.name
        };
      }
      delete migratedContext.agents;
    }

    // Migrate keyFiles from complex categorized structure to simple array
    if (Array.isArray(context.keyFiles)) {
      const simpleKeyFiles: string[] = [];
      context.keyFiles.forEach(category => {
        if (isRecord(category.files)) {
          Object.values(category.files).forEach(filePath => {
            if (typeof filePath === 'string') {
              simpleKeyFiles.push(filePath);
            }
          });
        }
      });
      migratedContext.keyFiles = simpleKeyFiles;
    }

    // Migrate preferences from array to string
    if (Array.isArray(context.preferences)) {
      const preferencesString = context.preferences
        .filter((pref): pref is string => typeof pref === 'string' && pref.trim().length > 0)
        .join('. ') + (context.preferences.length > 0 ? '.' : '');
      migratedContext.preferences = preferencesString;
    }

    // Remove status field
    if (context.status) {
      delete migratedContext.status;
    }

    return migratedContext;
  }

  private getSessionMetadata(session: unknown): LegacySessionMetadata | undefined {
    if (!isLegacySessionRecord(session) || !isRecord(session.metadata)) {
      return undefined;
    }

    return session.metadata;
  }

  private getTraceMetadata(trace: unknown): LegacyTraceMetadata | undefined {
    if (!isLegacyTraceRecord(trace) || !isRecord(trace.metadata)) {
      return undefined;
    }

    return trace.metadata;
  }

  private getStateMetadata(state: unknown): LegacyStateMetadata | undefined {
    if (!isLegacyStateRecord(state) || !isRecord(state.metadata)) {
      return undefined;
    }

    return state.metadata;
  }
}
