/**
 * Hybrid Storage Types
 *
 * Location: src/types/storage/HybridStorageTypes.ts
 * Purpose: Type definitions for the hybrid JSONL + SQLite storage system
 * Used by: Storage adapters, sync services, database backends
 *
 * This file defines all types for the hybrid storage architecture where:
 * - JSONL files are the source of truth (synced via Obsidian Sync)
 * - SQLite is a local cache for fast queries and true pagination
 * - All storage lives in `.nexus/` folder in the vault
 */

// ============================================================================
// Device and Sync Types
// ============================================================================

/**
 * Device identification for multi-device sync tracking
 *
 * Each device running the plugin gets a unique ID for conflict resolution
 * and sync state management.
 */
export interface DeviceInfo {
  /** Unique identifier for this device */
  deviceId: string;

  /** Optional human-readable device name */
  deviceName?: string;

  /** Timestamp of last activity from this device */
  lastSeen: number;
}

/**
 * Sync state tracking for incremental synchronization
 *
 * Tracks which events have been processed to enable efficient sync
 * between JSONL source of truth and SQLite cache.
 */
export interface SyncState {
  /** Device ID that owns this sync state */
  deviceId: string;

  /** Timestamp of the last processed event */
  lastEventTimestamp: number;

  /** Map of filename to last processed timestamp for each JSONL file */
  lastSyncedFiles: Record<string, number>;
}

// ============================================================================
// Workspace Types
// ============================================================================

/**
 * Workflow definition for workspace automation
 */
export interface WorkspaceWorkflow {
  /** Workflow name (e.g., "New Application", "Follow-up") */
  name: string;

  /** When to use this workflow (e.g., "When applying to new position") */
  when: string;

  /** Steps in the workflow (newline-separated) */
  steps: string;
}

/**
 * Workspace context for LLM understanding and workflow automation
 *
 * Contains purpose, goals, workflows, and preferences that help
 * the LLM understand what the user is trying to accomplish.
 */
export interface WorkspaceContext {
  /** What is this workspace for? */
  purpose?: string;

  /** Workflows for different situations */
  workflows?: WorkspaceWorkflow[];

  /** Key files for quick reference (paths) */
  keyFiles?: string[];

  /** User preferences as actionable guidelines */
  preferences?: string;

  /** Single dedicated agent for this workspace */
  dedicatedAgent?: {
    agentId: string;
    agentName: string;
  };
}

/**
 * Workspace metadata for organizational context
 *
 * Workspaces provide organizational boundaries for sessions, states,
 * and memory traces. They typically map to projects or areas of work.
 */
export interface WorkspaceMetadata {
  /** Unique workspace identifier (UUID) */
  id: string;

  /** Human-readable workspace name */
  name: string;

  /** Optional description of workspace purpose */
  description?: string;

  /** Root folder path in the vault */
  rootFolder: string;

  /** Timestamp when workspace was created */
  created: number;

  /** Timestamp of last access */
  lastAccessed: number;

  /** Whether this workspace is currently active */
  isActive: boolean;

  /** Whether this workspace is archived */
  isArchived?: boolean;

  /** Optional dedicated agent ID for this workspace */
  dedicatedAgentId?: string;

  /** Optional workspace context (purpose, workflows, keyFiles, etc.) */
  context?: WorkspaceContext;
}

// ============================================================================
// Session Types
// ============================================================================

/**
 * Session metadata for temporal context tracking
 *
 * Sessions represent periods of focused work within a workspace.
 * They contain states and memory traces.
 */
export interface SessionMetadata {
  /** Unique session identifier (UUID) */
  id: string;

  /** Parent workspace ID */
  workspaceId: string;

  /** Human-readable session name */
  name: string;

  /** Optional description of session purpose or goals */
  description?: string;

  /** Timestamp when session started */
  startTime: number;

  /** Optional timestamp when session ended */
  endTime?: number;

  /** Whether this session is currently active */
  isActive: boolean;
}

// ============================================================================
// State Types
// ============================================================================

/**
 * State metadata for workspace state snapshots
 *
 * States are named snapshots of workspace context that can be
 * resumed later. They contain the full context needed to continue work.
 */
export interface StateMetadata {
  /** Unique state identifier (UUID) */
  id: string;

  /** Parent session ID */
  sessionId: string;

  /** Parent workspace ID (denormalized for faster queries) */
  workspaceId: string;

  /** Human-readable state name */
  name: string;

  /** Optional description of what this state represents */
  description?: string;

  /** Timestamp when state was created */
  created: number;

  /** Whether this state is archived */
  isArchived?: boolean;

  /** Optional tags for categorization */
  tags?: string[];
}

/**
 * Full state data including metadata and content
 *
 * This is the complete state object stored in JSONL files.
 */
export interface StateData extends StateMetadata {
  /** The actual state content (workspace structure, files, etc.) */
  content: any;
}

// ============================================================================
// Conversation Types (OpenAI Fine-tuning Compatible)
// ============================================================================

/**
 * Conversation metadata for chat conversations
 *
 * Tracks metadata about conversations for listing, searching,
 * and organizing chat history. Compatible with OpenAI fine-tuning format.
 */
export interface ConversationMetadata {
  /** Unique conversation identifier (UUID) */
  id: string;

  /** Conversation title (auto-generated or user-provided) */
  title: string;

  /** Timestamp when conversation was created */
  created: number;

  /** Timestamp of last update */
  updated: number;

  /** Name of the vault this conversation belongs to */
  vaultName: string;

  /** Total number of messages in conversation */
  messageCount: number;

  /** Optional workspace association */
  workspaceId?: string;

  /** Optional session association */
  sessionId?: string;

  /** Optional additional metadata (stored as JSON) */
  metadata?: Record<string, any>;
}

/**
 * Alternative message for branching support
 *
 * When a user retries/regenerates a response, the new response is stored
 * as an alternative rather than replacing the original. This enables
 * navigation between different response versions.
 */
export interface AlternativeMessage {
  /** Unique identifier for this alternative */
  id: string;

  /** Alternative content */
  content: string | null;

  /** Timestamp when alternative was created */
  timestamp: number;

  /** Tool calls made in this alternative */
  toolCalls?: ToolCall[];

  /** Reasoning/thinking content for this alternative */
  reasoning?: string;

  /** Message lifecycle state */
  state: 'draft' | 'streaming' | 'complete' | 'aborted' | 'invalid';
}

/**
 * Message data in OpenAI format
 *
 * Compatible with OpenAI's chat completion and fine-tuning APIs.
 * Stored in JSONL files for easy export and training.
 */
export interface MessageData {
  /** Unique message identifier (UUID) */
  id: string;

  /** Parent conversation ID */
  conversationId: string;

  /** Message role */
  role: 'system' | 'user' | 'assistant' | 'tool';

  /** Message content (null for tool calls) */
  content: string | null;

  /** Timestamp when message was created */
  timestamp: number;

  /** Message lifecycle state */
  state: 'draft' | 'streaming' | 'complete' | 'aborted' | 'invalid';

  /** Sequence number for ordering messages */
  sequenceNumber: number;

  /** Optional tool calls made by assistant */
  toolCalls?: ToolCall[];

  /** Optional tool call ID this message responds to */
  toolCallId?: string;

  /** Optional reasoning/thinking content from LLMs */
  reasoning?: string;

  /** Optional metadata */
  metadata?: Record<string, any>;

  /** Alternative responses for branching (retry/regenerate creates alternatives) */
  alternatives?: AlternativeMessage[];

  /** Which alternative is active: 0 = original, 1+ = alternative index + 1 */
  activeAlternativeIndex?: number;
}

/**
 * Tool call structure (OpenAI format with extended properties)
 */
export interface ToolCall {
  /** Unique tool call identifier */
  id: string;

  /** Tool call type (always 'function' for now) */
  type: 'function';

  /** Function call details */
  function: {
    /** Function/tool name */
    name: string;

    /** JSON-encoded arguments */
    arguments: string;
  };

  /** Direct tool name (alternative to function.name) */
  name?: string;

  /** Tool parameters as object (alternative to function.arguments) */
  parameters?: Record<string, unknown>;

  /** Optional result from tool execution */
  result?: unknown;

  /** Whether tool execution succeeded */
  success?: boolean;

  /** Optional error message */
  error?: string;

  /** Execution time in milliseconds */
  executionTime?: number;
}

// ============================================================================
// Memory Trace Types
// ============================================================================

/**
 * Memory trace data for session activity tracking
 *
 * Traces record significant events, decisions, and context during a session.
 * They provide a searchable history of workspace activity.
 */
export interface MemoryTraceData {
  /** Unique trace identifier (UUID) */
  id: string;

  /** Parent session ID */
  sessionId: string;

  /** Parent workspace ID (denormalized for faster queries) */
  workspaceId: string;

  /** Timestamp when trace was created */
  timestamp: number;

  /** Optional trace type for categorization */
  type?: string;

  /** Trace content (text, JSON, etc.) */
  content: string;

  /** Optional metadata for additional context */
  metadata?: Record<string, any>;
}

// ============================================================================
// Export Types
// ============================================================================

/**
 * Filter options for exporting conversations
 *
 * Used to select which conversations to include in exports
 * (for fine-tuning, backup, analysis, etc.)
 */
export interface ExportFilter {
  /** Optional start date filter (timestamp) */
  startDate?: number;

  /** Optional end date filter (timestamp) */
  endDate?: number;

  /** Optional specific conversation IDs to export */
  conversationIds?: string[];

  /** Whether to include system messages */
  includeSystem?: boolean;

  /** Whether to include tool messages */
  includeTools?: boolean;

  /** Optional workspace filter */
  workspaceId?: string;
}

/**
 * Complete data export structure
 *
 * Used for full vault backup and migration between devices.
 */
export interface ExportData {
  /** Export format version for compatibility */
  version: string;

  /** Timestamp when export was created */
  exportedAt: number;

  /** Device that created the export */
  deviceId: string;

  /** Exported workspaces with full data */
  workspaces: WorkspaceExportData[];

  /** Exported conversations with full message history */
  conversations: ConversationExportData[];
}

/**
 * Workspace export data
 */
export interface WorkspaceExportData {
  /** Workspace metadata */
  metadata: WorkspaceMetadata;

  /** All sessions in this workspace */
  sessions: SessionMetadata[];

  /** All states in this workspace */
  states: StateData[];

  /** All memory traces in this workspace */
  traces: MemoryTraceData[];
}

/**
 * Conversation export data
 */
export interface ConversationExportData {
  /** Conversation metadata */
  metadata: ConversationMetadata;

  /** All messages in this conversation */
  messages: MessageData[];
}

// ============================================================================
// Query Result Types
// ============================================================================

/**
 * Search result for full-text search operations
 */
export interface SearchResult<T> {
  /** The matched item */
  item: T;

  /** Relevance score (0-1) */
  score: number;

  /** Highlighted snippets showing matches */
  highlights?: string[];

  /** Which fields matched */
  matchedFields?: string[];
}

/**
 * Sync operation result
 */
export interface SyncResult {
  /** Whether sync completed successfully */
  success: boolean;

  /** Number of events applied during sync */
  eventsApplied: number;

  /** Number of events skipped (already applied) */
  eventsSkipped: number;

  /** Any errors encountered during sync */
  errors: string[];

  /** Timestamp of last successfully synced event */
  lastSyncTimestamp: number;

  /** Files processed during sync */
  filesProcessed: string[];

  /** Duration of sync operation in milliseconds */
  duration: number;
}

// ============================================================================
// Storage Event Types (for JSONL event sourcing)
// ============================================================================

/**
 * Base event structure for event sourcing
 *
 * All changes to data are recorded as events in JSONL files.
 */
export interface StorageEvent {
  /** Unique event identifier (UUID) */
  id: string;

  /** Event type (e.g., 'workspace.created', 'message.added') */
  type: string;

  /** Timestamp when event occurred */
  timestamp: number;

  /** Device that generated this event */
  deviceId: string;

  /** Event payload (varies by event type) */
  payload: any;

  /** Optional metadata */
  metadata?: Record<string, any>;
}

/**
 * Event types for type-safe event handling
 */
export type StorageEventType =
  | 'workspace.created'
  | 'workspace.updated'
  | 'workspace.deleted'
  | 'session.created'
  | 'session.updated'
  | 'session.ended'
  | 'state.created'
  | 'state.updated'
  | 'state.deleted'
  | 'conversation.created'
  | 'conversation.updated'
  | 'conversation.deleted'
  | 'message.added'
  | 'message.updated'
  | 'trace.added';
