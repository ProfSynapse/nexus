/**
 * Location: src/database/interfaces/StorageEvents.ts
 *
 * Storage Event Type Definitions
 *
 * This file defines the event types for the hybrid storage system's append-only JSONL files.
 * Each event represents an immutable operation with deviceId and timestamp for sync safety.
 *
 * Design Principles:
 * - All events extend BaseStorageEvent with id, type, deviceId, timestamp
 * - Events are append-only and never modified after creation
 * - DeviceId tracks which device created the event (for conflict-free sync)
 * - Conversations use OpenAI fine-tuning format for compatibility
 *
 * Related Files:
 * - src/database/storage/JSONLWriter.ts - JSONL file operations
 * - src/database/types/workspace/WorkspaceTypes.ts - Workspace data structures
 * - src/database/types/session/SessionTypes.ts - Session data structures
 * - src/types/chat/ChatTypes.ts - Conversation message structures
 */

// ============================================================================
// Base Event Interface
// ============================================================================

/**
 * Base storage event with common fields for all event types
 */
export interface BaseStorageEvent {
  /**
   * Unique event identifier (UUID v4)
   */
  id: string;

  /**
   * Event type discriminator
   */
  type: string;

  /**
   * Device ID that created this event (for sync conflict resolution)
   */
  deviceId: string;

  /**
   * Unix timestamp (milliseconds) when event was created
   */
  timestamp: number;
}

// ============================================================================
// Workspace Events
// ============================================================================

/**
 * Event: Workspace created
 *
 * Records the creation of a new workspace with initial metadata.
 */
export interface WorkspaceCreatedEvent extends BaseStorageEvent {
  type: 'workspace_created';
  data: {
    /** Unique workspace identifier */
    id: string;
    /** Display name */
    name: string;
    /** Optional description */
    description?: string;
    /** Root folder path in vault */
    rootFolder: string;
    /** Creation timestamp */
    created: number;
    /** Whether this workspace is active (defaults to true) */
    isActive?: boolean;
    /** Optional dedicated agent ID */
    dedicatedAgentId?: string;
    /** JSON-serialized workspace context */
    contextJson?: string;
  };
}

/**
 * Event: Workspace updated
 *
 * Records updates to workspace metadata. Only changed fields are included.
 */
export interface WorkspaceUpdatedEvent extends BaseStorageEvent {
  type: 'workspace_updated';
  /** Target workspace ID */
  workspaceId: string;
  /** Partial update data (only changed fields) */
  data: Partial<{
    name: string;
    description: string;
    rootFolder: string;
    lastAccessed: number;
    isActive: boolean;
    dedicatedAgentId: string;
    contextJson: string;
  }>;
}

/**
 * Event: Workspace deleted
 *
 * Marks a workspace as deleted (soft delete).
 */
export interface WorkspaceDeletedEvent extends BaseStorageEvent {
  type: 'workspace_deleted';
  /** Target workspace ID */
  workspaceId: string;
}

// ============================================================================
// Session Events
// ============================================================================

/**
 * Event: Session created
 *
 * Records the creation of a new session within a workspace.
 */
export interface SessionCreatedEvent extends BaseStorageEvent {
  type: 'session_created';
  /** Parent workspace ID */
  workspaceId: string;
  data: {
    /** Unique session identifier */
    id: string;
    /** Session name */
    name: string;
    /** Optional description */
    description?: string;
    /** Session start timestamp */
    startTime: number;
  };
}

/**
 * Event: Session updated
 *
 * Records updates to session metadata.
 */
export interface SessionUpdatedEvent extends BaseStorageEvent {
  type: 'session_updated';
  /** Parent workspace ID */
  workspaceId: string;
  /** Target session ID */
  sessionId: string;
  /** Partial update data (only changed fields) */
  data: Partial<{
    name: string;
    description: string;
    endTime: number;
    isActive: boolean;
  }>;
}

// ============================================================================
// State Events
// ============================================================================

/**
 * Event: State saved
 *
 * Records a saved state snapshot for workspace/session restoration.
 */
export interface StateSavedEvent extends BaseStorageEvent {
  type: 'state_saved';
  /** Parent workspace ID */
  workspaceId: string;
  /** Parent session ID */
  sessionId: string;
  data: {
    /** Unique state identifier */
    id: string;
    /** State name */
    name: string;
    /** Optional description */
    description?: string;
    /** Creation timestamp */
    created: number;
    /** JSON-serialized state context */
    stateJson: string;
    /** Optional tags for categorization */
    tags?: string[];
  };
}

/**
 * Event: State deleted
 *
 * Marks a state as deleted (soft delete).
 */
export interface StateDeletedEvent extends BaseStorageEvent {
  type: 'state_deleted';
  /** Parent workspace ID */
  workspaceId: string;
  /** Parent session ID */
  sessionId: string;
  /** Target state ID */
  stateId: string;
}

// ============================================================================
// Trace Events
// ============================================================================

/**
 * Event: Trace added
 *
 * Records a memory trace for workspace activity tracking.
 */
export interface TraceAddedEvent extends BaseStorageEvent {
  type: 'trace_added';
  /** Parent workspace ID */
  workspaceId: string;
  /** Parent session ID */
  sessionId: string;
  data: {
    /** Unique trace identifier */
    id: string;
    /** Trace content */
    content: string;
    /** Optional trace type categorization */
    traceType?: string;
    /** JSON-serialized metadata */
    metadataJson?: string;
  };
}

// ============================================================================
// Conversation Events (OpenAI Format)
// ============================================================================

/**
 * Event: Conversation metadata
 *
 * Special event type that records conversation metadata.
 * Stored as first line in conversation JSONL file.
 */
export interface ConversationCreatedEvent extends BaseStorageEvent {
  type: 'metadata';
  data: {
    /** Unique conversation identifier */
    id: string;
    /** Conversation title */
    title: string;
    /** Creation timestamp */
    created: number;
    /** Vault name */
    vault: string;
    /** Optional conversation settings */
    settings?: any;
  };
}

/**
 * Event: Conversation updated
 *
 * Records updates to conversation metadata.
 */
export interface ConversationUpdatedEvent extends BaseStorageEvent {
  type: 'conversation_updated';
  /** Target conversation ID */
  conversationId: string;
  /** Partial update data (only changed fields) */
  data: Partial<{
    title: string;
    updated: number;
    settings: any;
  }>;
}

/**
 * Alternative message data for branching support
 */
export interface AlternativeMessageEvent {
  /** Unique identifier for this alternative */
  id: string;
  /** Alternative content */
  content: string | null;
  /** Timestamp when alternative was created */
  timestamp: number;
  /** Tool calls made in this alternative (extended properties for tool bubble reconstruction) */
  tool_calls?: Array<{
    id: string;
    type: 'function' | string;
    function: { name: string; arguments: string };
    // Extended properties for tool bubbles reconstruction after reload
    name?: string;
    parameters?: Record<string, unknown>;
    result?: unknown;
    success?: boolean;
    error?: string;
    executionTime?: number;
  }>;
  /** Reasoning/thinking content for this alternative */
  reasoning?: string;
  /** Message lifecycle state */
  state?: string;
}

/**
 * Event: Message added/updated
 *
 * Records a chat message in OpenAI fine-tuning format.
 * This format is compatible with OpenAI's JSONL training data.
 */
export interface MessageEvent extends BaseStorageEvent {
  type: 'message';
  /** Parent conversation ID */
  conversationId: string;
  data: {
    /** Unique message identifier */
    id: string;
    /** Message role */
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** Message content (null for tool calls) */
    content: string | null;
    /** Tool calls (OpenAI format with extended properties for tool bubble reconstruction) */
    tool_calls?: Array<{
      id: string;
      type: 'function' | string;
      function: { name: string; arguments: string };
      // Extended properties for tool bubbles reconstruction after reload
      name?: string;
      parameters?: Record<string, unknown>;
      result?: unknown;
      success?: boolean;
      error?: string;
      executionTime?: number;
    }>;
    /** Tool call ID (for tool role messages) */
    tool_call_id?: string;
    /** Message lifecycle state */
    state?: string;
    /** Reasoning/thinking content (for extended thinking models) */
    reasoning?: string;
    /** Sequence number for ordering */
    sequenceNumber: number;
    /** Alternative responses for branching */
    alternatives?: AlternativeMessageEvent[];
    /** Which alternative is active: 0 = original, 1+ = alternative index + 1 */
    activeAlternativeIndex?: number;
  };
}

/**
 * Event: Message updated
 *
 * Records updates to existing message (e.g., streaming completion, state changes).
 */
export interface MessageUpdatedEvent extends BaseStorageEvent {
  type: 'message_updated';
  /** Parent conversation ID */
  conversationId: string;
  /** Target message ID */
  messageId: string;
  /** Partial update data (only changed fields) */
  data: Partial<{
    content: string;
    state: string;
    reasoning: string;
    tool_calls: Array<{
      id: string;
      type: 'function' | string;
      function: { name: string; arguments: string };
      // Extended properties for tool bubbles reconstruction
      name?: string;
      parameters?: Record<string, unknown>;
      result?: unknown;
      success?: boolean;
      error?: string;
    }>;
    tool_call_id: string;
    /** Alternative responses for branching */
    alternatives: AlternativeMessageEvent[];
    /** Which alternative is active: 0 = original, 1+ = alternative index + 1 */
    activeAlternativeIndex: number;
  }>;
}

// ============================================================================
// Branch Events (Append-Only for Conflict-Free Sync)
// ============================================================================

/**
 * Event: Branch created on a message
 *
 * Branches are stored separately from messages to enable append-only writes.
 * This eliminates race conditions when multiple devices create branches concurrently.
 */
export interface BranchCreatedEvent extends BaseStorageEvent {
  type: 'branch_created';
  /** Parent conversation ID */
  conversationId: string;
  /** Message ID this branch is attached to */
  parentMessageId: string;
  data: {
    /** Unique branch identifier */
    id: string;
    /** Branch type */
    type: 'human' | 'subagent';
    /** Whether LLM context includes parent conversation */
    inheritContext: boolean;
    /** Type-specific metadata (JSON stringified for subagent) */
    metadataJson?: string;
  };
}

/**
 * Event: Message added to a branch
 *
 * Branch messages are separate from main conversation messages.
 * Append-only: each message is a new event line, no conflicts.
 */
export interface BranchMessageEvent extends BaseStorageEvent {
  type: 'branch_message';
  /** Parent conversation ID */
  conversationId: string;
  /** Branch ID this message belongs to */
  branchId: string;
  data: {
    /** Unique message identifier */
    id: string;
    /** Message role */
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** Message content (null for tool calls) */
    content: string | null;
    /** Tool calls (OpenAI format) */
    tool_calls?: Array<{
      id: string;
      type: 'function' | string;
      function: { name: string; arguments: string };
      // Extended properties for tool bubbles
      name?: string;
      parameters?: Record<string, unknown>;
      result?: unknown;
      success?: boolean;
      error?: string;
    }>;
    /** Tool call ID (for tool role messages) */
    tool_call_id?: string;
    /** Message lifecycle state */
    state?: string;
    /** Reasoning/thinking content */
    reasoning?: string;
    /** Sequence number for ordering within branch */
    sequenceNumber: number;
  };
}

/**
 * Event: Branch message updated (streaming completion, state changes)
 */
export interface BranchMessageUpdatedEvent extends BaseStorageEvent {
  type: 'branch_message_updated';
  /** Parent conversation ID */
  conversationId: string;
  /** Branch ID */
  branchId: string;
  /** Target message ID */
  messageId: string;
  /** Partial update data */
  data: Partial<{
    content: string;
    state: string;
    reasoning: string;
    tool_calls: Array<{
      id: string;
      type: 'function' | string;
      function: { name: string; arguments: string };
      result?: unknown;
      success?: boolean;
      error?: string;
    }>;
    tool_call_id: string;
  }>;
}

/**
 * Event: Branch state/metadata updated
 *
 * Used for subagent state transitions: running → complete, cancelled, etc.
 */
export interface BranchUpdatedEvent extends BaseStorageEvent {
  type: 'branch_updated';
  /** Parent conversation ID */
  conversationId: string;
  /** Target branch ID */
  branchId: string;
  /** Partial update data */
  data: Partial<{
    /** Updated metadata (JSON stringified) */
    metadataJson: string;
    /** Updated timestamp */
    updated: number;
  }>;
}

// ============================================================================
// Union Types and Type Guards
// ============================================================================

/**
 * Union of all workspace-related events
 */
export type WorkspaceEvent =
  | WorkspaceCreatedEvent
  | WorkspaceUpdatedEvent
  | WorkspaceDeletedEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | StateSavedEvent
  | StateDeletedEvent
  | TraceAddedEvent;

/**
 * Union of all conversation-related events
 */
export type ConversationEvent =
  | ConversationCreatedEvent
  | ConversationUpdatedEvent
  | MessageEvent
  | MessageUpdatedEvent
  | BranchCreatedEvent
  | BranchMessageEvent
  | BranchMessageUpdatedEvent
  | BranchUpdatedEvent;

/**
 * Union of all storage events
 */
export type StorageEvent = WorkspaceEvent | ConversationEvent;

/**
 * Type guard: Check if event is workspace-related
 */
export function isWorkspaceEvent(event: StorageEvent): event is WorkspaceEvent {
  return [
    'workspace_created',
    'workspace_updated',
    'workspace_deleted',
    'session_created',
    'session_updated',
    'state_saved',
    'state_deleted',
    'trace_added',
  ].includes(event.type);
}

/**
 * Type guard: Check if event is conversation-related
 */
export function isConversationEvent(event: StorageEvent): event is ConversationEvent {
  return [
    'metadata',
    'conversation_updated',
    'message',
    'message_updated',
    'branch_created',
    'branch_message',
    'branch_message_updated',
    'branch_updated',
  ].includes(event.type);
}

/**
 * Type guard: Check if event is a creation event
 */
export function isCreationEvent(event: StorageEvent): boolean {
  return [
    'workspace_created',
    'session_created',
    'state_saved',
    'trace_added',
    'metadata',
    'message',
    'branch_created',
    'branch_message',
  ].includes(event.type);
}

/**
 * Type guard: Check if event is an update event
 */
export function isUpdateEvent(event: StorageEvent): boolean {
  return [
    'workspace_updated',
    'session_updated',
    'conversation_updated',
    'message_updated',
    'branch_message_updated',
    'branch_updated',
  ].includes(event.type);
}

/**
 * Type guard: Check if event is a deletion event
 */
export function isDeletionEvent(event: StorageEvent): boolean {
  return [
    'workspace_deleted',
    'state_deleted',
  ].includes(event.type);
}
