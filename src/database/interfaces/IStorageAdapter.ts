/**
 * Storage Adapter Interface
 *
 * Location: src/database/interfaces/IStorageAdapter.ts
 * Purpose: Main storage interface that the application uses for all data operations
 *
 * Interface segregation (May 2026 refactor): the original monolithic
 * `IStorageAdapter` is now a union of per-entity sub-interfaces. The union
 * is still exported as `IStorageAdapter` so existing call sites
 * (`storageAdapter.getWorkspace(id)`, etc.) keep working unchanged. New
 * code that only needs one slice of the surface can depend on the
 * sub-interface directly (e.g. `IConversationStorage`) and accept a
 * narrower test double.
 *
 * The hybrid approach provides:
 * - Sync-friendly: JSONL files work with Obsidian Sync
 * - Fast queries: SQLite cache enables efficient searching and pagination
 * - Conflict resolution: Event sourcing provides clear merge semantics
 * - Portability: JSONL files are human-readable and easy to migrate
 *
 * Relationships:
 * - Implemented by: HybridStorageAdapter
 * - Uses: IStorageBackend for SQLite operations
 * - Uses: JSONLWriter/JSONLReader for event sourcing
 */

import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import {
  WorkspaceMetadata,
  SessionMetadata,
  StateMetadata,
  StateData,
  ConversationMetadata,
  MessageData,
  MemoryTraceData,
  ExportFilter,
  ExportData,
  SyncResult
} from '../../types/storage/HybridStorageTypes';
import type { IMessageRepository } from '../repositories/interfaces/IMessageRepository';

/**
 * Extended query options for flexible data retrieval
 */
export interface QueryOptions extends PaginationParams {
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  filter?: Record<string, unknown>;
  search?: string;
  /** Include branch conversations (default: false - branches are hidden from list) */
  includeBranches?: boolean;
}

// ============================================================================
// Lifecycle
// ============================================================================

export interface IStorageLifecycle {
  /**
   * Check if the adapter is fully initialized and ready for use.
   * Services use this to determine whether to route operations through
   * the adapter (SQLite cache) or fall back to JSONL-only storage.
   */
  isReady(): boolean;

  /**
   * Check if the adapter's query cache is safe to read from. Stricter
   * than `isReady()` — during certain startup transitions SQLite can be
   * open but still rebuilding from JSONL.
   */
  isQueryReady?(): boolean;

  initialize(): Promise<void>;

  /** Wait until the adapter is safe for read queries. */
  waitForQueryReady?(): Promise<boolean>;

  /** Close the storage adapter and release resources. */
  close(): Promise<void>;

  /** Synchronize SQLite cache with JSONL source of truth. */
  sync(): Promise<SyncResult>;
}

// ============================================================================
// Per-entity slices
// ============================================================================

export interface IWorkspaceStorage {
  getWorkspace(id: string): Promise<WorkspaceMetadata | null>;
  getWorkspaces(options?: QueryOptions): Promise<PaginatedResult<WorkspaceMetadata>>;
  createWorkspace(workspace: Omit<WorkspaceMetadata, 'id'> & { id?: string }): Promise<string>;
  updateWorkspace(id: string, updates: Partial<WorkspaceMetadata>): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  searchWorkspaces(query: string): Promise<WorkspaceMetadata[]>;
}

export interface ISessionStorage {
  getSessions(workspaceId: string, options?: PaginationParams): Promise<PaginatedResult<SessionMetadata>>;
  getSession(id: string): Promise<SessionMetadata | null>;
  createSession(
    workspaceId: string,
    session: Omit<SessionMetadata, 'id' | 'workspaceId'> & { id?: string }
  ): Promise<string>;
  updateSession(
    workspaceId: string,
    sessionId: string,
    updates: Partial<SessionMetadata>
  ): Promise<void>;
  /**
   * Move an existing session to another workspace. Implementations should
   * rehome dependent state and trace rows for that session too.
   */
  moveSessionToWorkspace?(sessionId: string, workspaceId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface IStateStorage {
  getStates(
    workspaceId: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<StateMetadata>>;
  getState(id: string): Promise<StateData | null>;
  saveState(
    workspaceId: string,
    sessionId: string,
    state: Omit<StateData, 'id' | 'workspaceId' | 'sessionId'>
  ): Promise<string>;
  deleteState(id: string): Promise<void>;
  countStates(workspaceId: string, sessionId?: string): Promise<number>;
}

export interface ITraceStorage {
  getTraces(
    workspaceId: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MemoryTraceData>>;
  addTrace(
    workspaceId: string,
    sessionId: string,
    trace: Omit<MemoryTraceData, 'id' | 'workspaceId' | 'sessionId'>
  ): Promise<string>;
  searchTraces(
    workspaceId: string,
    query: string,
    sessionId?: string
  ): Promise<MemoryTraceData[]>;
}

export interface IConversationStorage {
  getConversation(id: string): Promise<ConversationMetadata | null>;
  getConversations(options?: QueryOptions): Promise<PaginatedResult<ConversationMetadata>>;
  createConversation(params: Omit<ConversationMetadata, 'id' | 'messageCount'>): Promise<string>;
  updateConversation(id: string, updates: Partial<ConversationMetadata>): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  searchConversations(query: string): Promise<ConversationMetadata[]>;
}

export interface IMessageStorage {
  getMessages(
    conversationId: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MessageData>>;
  addMessage(
    conversationId: string,
    message: Omit<MessageData, 'id' | 'conversationId' | 'sequenceNumber'> & { id?: string }
  ): Promise<string>;
  updateMessage(
    conversationId: string,
    messageId: string,
    updates: Partial<MessageData>
  ): Promise<void>;
  deleteMessage(conversationId: string, messageId: string): Promise<void>;
}

export interface IExportStorage {
  /**
   * Export conversations in OpenAI fine-tuning format.
   * Each line: `{"messages": [{"role": "system", "content": "..."}, ...]}`
   */
  exportConversationsForFineTuning(filter?: ExportFilter): Promise<string>;
  exportAllData(): Promise<ExportData>;
  importData(data: ExportData, options?: ImportOptions): Promise<void>;
}

// ============================================================================
// Composed surface
// ============================================================================

/**
 * Main storage adapter interface — composed from per-entity slices.
 * Existing callers depend on this union and don't need to change. New
 * code that touches only one slice should depend on the sub-interface.
 */
export interface IStorageAdapter
  extends IStorageLifecycle,
    IWorkspaceStorage,
    ISessionStorage,
    IStateStorage,
    ITraceStorage,
    IConversationStorage,
    IMessageStorage,
    IExportStorage {
  /**
   * Optional access to the message repository for advanced operations.
   *
   * Used by MemorySearchProcessor to obtain a ConversationWindowRetriever
   * and by ConversationEmbeddingWatcher for message completion callbacks.
   * Not all implementations expose this — callers must check for undefined.
   */
  readonly messages?: IMessageRepository;
}

/**
 * Import options for data import operations
 */
export interface ImportOptions {
  mode: 'merge' | 'replace';
  conflictResolution: 'skip' | 'overwrite';
  workspaceMapping?: Record<string, string>;
}
