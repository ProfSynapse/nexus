/**
 * Storage Adapter Interface
 *
 * Location: src/database/interfaces/IStorageAdapter.ts
 * Purpose: Main storage interface that the application uses for all data operations
 * Used by: Services throughout the application for data persistence and retrieval
 *
 * This is the primary interface for data access in the hybrid storage system.
 * It abstracts away the complexity of:
 * - JSONL event sourcing (source of truth)
 * - SQLite caching (fast queries and pagination)
 * - Multi-device synchronization
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
/**
 * Extended query options for flexible data retrieval
 */
export interface QueryOptions extends PaginationParams {
  /** Field to sort by */
  sortBy?: string;

  /** Sort direction */
  sortOrder?: 'asc' | 'desc';

  /** Filters to apply (key-value pairs) */
  filter?: Record<string, any>;

  /** Full-text search query */
  search?: string;
}

/**
 * Main storage adapter interface
 *
 * This is the primary interface that all application code should use
 * for data persistence and retrieval. It provides a clean, high-level
 * API that hides the complexity of the hybrid storage architecture.
 */
export interface IStorageAdapter {
  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  /**
   * Initialize the storage adapter
   *
   * This should:
   * 1. Initialize the SQLite backend
   * 2. Load sync state from disk
   * 3. Perform initial sync if needed
   * 4. Set up file watchers for JSONL files
   *
   * @throws {Error} If initialization fails
   */
  initialize(): Promise<void>;

  /**
   * Close the storage adapter and release resources
   *
   * This should:
   * 1. Save sync state
   * 2. Close the SQLite backend
   * 3. Stop file watchers
   */
  close(): Promise<void>;

  /**
   * Synchronize SQLite cache with JSONL source of truth
   *
   * This should:
   * 1. Read new events from JSONL files
   * 2. Apply events to SQLite cache
   * 3. Update sync state
   * 4. Handle any conflicts or errors
   *
   * @returns Sync result with statistics and errors
   */
  sync(): Promise<SyncResult>;

  // ============================================================================
  // Workspace Operations
  // ============================================================================

  /**
   * Get a single workspace by ID
   *
   * @param id - Workspace ID
   * @returns Workspace metadata, or null if not found
   */
  getWorkspace(id: string): Promise<WorkspaceMetadata | null>;

  /**
   * Get all workspaces with pagination and filtering
   *
   * @param options - Query options (pagination, sorting, filtering)
   * @returns Paginated list of workspaces
   */
  getWorkspaces(options?: QueryOptions): Promise<PaginatedResult<WorkspaceMetadata>>;

  /**
   * Create a new workspace
   *
   * This should:
   * 1. Use provided ID or generate a new workspace ID
   * 2. Write create event to JSONL
   * 3. Update SQLite cache
   *
   * @param workspace - Workspace metadata (id optional - will be generated if not provided)
   * @returns ID of the created workspace
   */
  createWorkspace(workspace: Omit<WorkspaceMetadata, 'id'> & { id?: string }): Promise<string>;

  /**
   * Update an existing workspace
   *
   * This should:
   * 1. Write update event to JSONL
   * 2. Update SQLite cache
   *
   * @param id - Workspace ID
   * @param updates - Partial workspace metadata to update
   */
  updateWorkspace(id: string, updates: Partial<WorkspaceMetadata>): Promise<void>;

  /**
   * Delete a workspace
   *
   * This should:
   * 1. Write delete event to JSONL
   * 2. Remove from SQLite cache
   * 3. Cascade delete sessions, states, and traces
   *
   * @param id - Workspace ID
   */
  deleteWorkspace(id: string): Promise<void>;

  /**
   * Search workspaces by name or description
   *
   * @param query - Search query
   * @returns Array of matching workspaces
   */
  searchWorkspaces(query: string): Promise<WorkspaceMetadata[]>;

  // ============================================================================
  // Session Operations
  // ============================================================================

  /**
   * Get sessions for a workspace
   *
   * @param workspaceId - Workspace ID
   * @param options - Pagination options
   * @returns Paginated list of sessions
   */
  getSessions(
    workspaceId: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<SessionMetadata>>;

  /**
   * Get a single session by ID
   *
   * @param id - Session ID
   * @returns Session metadata, or null if not found
   */
  getSession(id: string): Promise<SessionMetadata | null>;

  /**
   * Create a new session
   *
   * @param workspaceId - Parent workspace ID
   * @param session - Session metadata (without id)
   * @returns ID of the created session
   */
  createSession(
    workspaceId: string,
    session: Omit<SessionMetadata, 'id' | 'workspaceId'>
  ): Promise<string>;

  /**
   * Update an existing session
   *
   * @param workspaceId - Parent workspace ID
   * @param sessionId - Session ID
   * @param updates - Partial session metadata to update
   */
  updateSession(
    workspaceId: string,
    sessionId: string,
    updates: Partial<SessionMetadata>
  ): Promise<void>;

  /**
   * Delete a session
   *
   * @param sessionId - Session ID
   */
  deleteSession(sessionId: string): Promise<void>;

  // ============================================================================
  // State Operations
  // ============================================================================

  /**
   * Get states for a workspace or session
   *
   * @param workspaceId - Workspace ID
   * @param sessionId - Optional session ID to filter by
   * @param options - Pagination options
   * @returns Paginated list of state metadata
   */
  getStates(
    workspaceId: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<StateMetadata>>;

  /**
   * Get a single state by ID (includes full content)
   *
   * @param id - State ID
   * @returns Full state data, or null if not found
   */
  getState(id: string): Promise<StateData | null>;

  /**
   * Save a new state or update existing
   *
   * @param workspaceId - Parent workspace ID
   * @param sessionId - Parent session ID
   * @param state - State data (with or without id)
   */
  saveState(
    workspaceId: string,
    sessionId: string,
    state: Omit<StateData, 'id' | 'workspaceId' | 'sessionId'>
  ): Promise<string>;

  /**
   * Delete a state
   *
   * @param id - State ID
   */
  deleteState(id: string): Promise<void>;

  /**
   * Count states for a workspace or session
   *
   * @param workspaceId - Workspace ID
   * @param sessionId - Optional session ID to filter by
   * @returns Number of states
   */
  countStates(workspaceId: string, sessionId?: string): Promise<number>;

  // ============================================================================
  // Memory Trace Operations
  // ============================================================================

  /**
   * Get memory traces for a workspace or session
   *
   * @param workspaceId - Workspace ID
   * @param sessionId - Optional session ID to filter by
   * @param options - Pagination options
   * @returns Paginated list of memory traces
   */
  getTraces(
    workspaceId: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MemoryTraceData>>;

  /**
   * Add a new memory trace
   *
   * @param workspaceId - Parent workspace ID
   * @param sessionId - Parent session ID
   * @param trace - Trace data (without id)
   */
  addTrace(
    workspaceId: string,
    sessionId: string,
    trace: Omit<MemoryTraceData, 'id' | 'workspaceId' | 'sessionId'>
  ): Promise<string>;

  /**
   * Search memory traces by content
   *
   * @param workspaceId - Workspace ID to search within
   * @param query - Search query
   * @param sessionId - Optional session ID to filter by
   * @returns Array of matching traces
   */
  searchTraces(
    workspaceId: string,
    query: string,
    sessionId?: string
  ): Promise<MemoryTraceData[]>;

  // ============================================================================
  // Conversation Operations
  // ============================================================================

  /**
   * Get a single conversation by ID
   *
   * @param id - Conversation ID
   * @returns Conversation metadata, or null if not found
   */
  getConversation(id: string): Promise<ConversationMetadata | null>;

  /**
   * Get all conversations with pagination and filtering
   *
   * @param options - Query options (pagination, sorting, filtering)
   * @returns Paginated list of conversations
   */
  getConversations(options?: QueryOptions): Promise<PaginatedResult<ConversationMetadata>>;

  /**
   * Create a new conversation
   *
   * @param params - Conversation metadata (without id)
   * @returns ID of the created conversation
   */
  createConversation(params: Omit<ConversationMetadata, 'id' | 'messageCount'>): Promise<string>;

  /**
   * Update an existing conversation
   *
   * @param id - Conversation ID
   * @param updates - Partial conversation metadata to update
   */
  updateConversation(id: string, updates: Partial<ConversationMetadata>): Promise<void>;

  /**
   * Delete a conversation and all its messages
   *
   * @param id - Conversation ID
   */
  deleteConversation(id: string): Promise<void>;

  /**
   * Search conversations by title or content
   *
   * @param query - Search query
   * @returns Array of matching conversations
   */
  searchConversations(query: string): Promise<ConversationMetadata[]>;

  // ============================================================================
  // Message Operations
  // ============================================================================

  /**
   * Get messages for a conversation
   *
   * @param conversationId - Conversation ID
   * @param options - Pagination options
   * @returns Paginated list of messages (ordered by sequence number)
   */
  getMessages(
    conversationId: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MessageData>>;

  /**
   * Add a new message to a conversation
   *
   * @param conversationId - Parent conversation ID
   * @param message - Message data (without id, conversationId, sequenceNumber)
   */
  addMessage(
    conversationId: string,
    message: Omit<MessageData, 'id' | 'conversationId' | 'sequenceNumber'> & { id?: string }
  ): Promise<string>;

  /**
   * Update an existing message
   *
   * @param conversationId - Parent conversation ID
   * @param messageId - Message ID
   * @param updates - Partial message data to update
   */
  updateMessage(
    conversationId: string,
    messageId: string,
    updates: Partial<MessageData>
  ): Promise<void>;

  /**
   * Delete a message
   *
   * @param conversationId - Parent conversation ID
   * @param messageId - Message ID
   */
  deleteMessage(conversationId: string, messageId: string): Promise<void>;

  // ============================================================================
  // Export Operations
  // ============================================================================

  /**
   * Export conversations in OpenAI fine-tuning format
   *
   * This creates a JSONL file where each line is a complete conversation
   * in the format expected by OpenAI's fine-tuning API:
   * {"messages": [{"role": "system", "content": "..."}, ...]}
   *
   * @param filter - Optional filter for which conversations to export
   * @returns Path to the exported JSONL file
   */
  exportConversationsForFineTuning(filter?: ExportFilter): Promise<string>;

  /**
   * Export all data for backup or migration
   *
   * @returns Complete export data structure
   */
  exportAllData(): Promise<ExportData>;

  /**
   * Import data from an export
   *
   * @param data - Export data to import
   * @param options - Import options (merge vs replace)
   */
  importData(data: ExportData, options?: ImportOptions): Promise<void>;

  // ============================================================================
  // Repository Access (for advanced operations)
  // ============================================================================

}

/**
 * Import options for data import operations
 */
export interface ImportOptions {
  /** Whether to merge with existing data or replace */
  mode: 'merge' | 'replace';

  /** Whether to skip conflicts (keep existing) or overwrite */
  conflictResolution: 'skip' | 'overwrite';

  /** Optional workspace mapping for imported data */
  workspaceMapping?: Record<string, string>;
}
