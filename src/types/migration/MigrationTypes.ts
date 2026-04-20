// Location: src/types/migration/MigrationTypes.ts
// Core type definitions for the simplified JSON-based data architecture
// Used by: DataMigrationService, WorkspaceService, MemoryService, and ConversationService
// Dependencies: Defines the target structure for migration from ChromaDB collections

import { WorkspaceContext } from '../../database/types/workspace/WorkspaceTypes';
import { WorkspaceState } from '../../database/types/session/SessionTypes';

export interface WorkspaceDataStructure {
  workspaces: {
    [workspaceId: string]: {
      // Core workspace info
      id: string;
      name: string;
      description?: string;
      rootFolder: string;
      created: number;
      lastAccessed: number;
      isActive?: boolean;
      context?: WorkspaceContext;

      // Nested sessions
      sessions: {
        [sessionId: string]: {
          id: string;
          name?: string;
          description?: string;
          startTime: number;
          endTime?: number;
          isActive: boolean;

          // Nested memory traces
          memoryTraces: {
            [traceId: string]: {
              id: string;
              timestamp: number;
              type: string;
              content: string;
              metadata?: {
                tool?: string;
                params?: unknown;
                result?: unknown;
                relatedFiles?: string[];
              };
            };
          };

          // Nested states
          states: {
            [stateId: string]: {
              id: string;
              name: string;
              created: number;
              snapshot: WorkspaceState;
            };
          };
        };
      };
    };
  };

  metadata: {
    version: string;
    lastUpdated: number;
    migrationCompleted?: number;
  };
}

export interface ConversationDataStructure {
  conversations: {
    [conversationId: string]: {
      id: string;
      title: string;
      created: number;
      updated: number;
      vault_name: string;
      message_count: number;

      messages: Array<{
        id: string;
        role: 'user' | 'assistant' | 'tool';
        content: string;
        timestamp: number;
        toolName?: string;
        toolParams?: unknown;
        toolResult?: unknown;
      }>;
    };
  };

  metadata: {
    version: string;
    lastUpdated: number;
    totalConversations: number;
  };
}

export interface WorkspaceSearchIndex {
  byName: Record<string, string[]>;
  byDescription: Record<string, string[]>;
  byFolder: Record<string, string>;
  sessionsByWorkspace: Record<string, string[]>;
  sessionsByName: Record<string, string[]>;
  tracesByTool: Record<string, string[]>;
  tracesByType: Record<string, string[]>;
  lastUpdated: number;
}

export interface ConversationSearchIndex {
  byTitle: Record<string, string[]>;
  byContent: Record<string, string[]>;
  byVault: Record<string, string[]>;
  byDateRange: Array<{
    start: number;
    end: number;
    conversationIds: string[];
  }>;
  lastUpdated: number;
}
