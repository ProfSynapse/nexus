/**
 * Branch Types - Unified branching model for human and subagent branches
 *
 * Both human and subagent branches use the same data structure.
 * The key difference is the `inheritContext` flag:
 * - Human branch: inheritContext=true -> LLM sees parent context + branch messages
 * - Subagent branch: inheritContext=false -> LLM sees only branch messages (fresh start)
 */

import type { ChatMessage } from '../chat/ChatTypes';

/**
 * Branch state for tracking lifecycle
 */
export type BranchState =
  | 'running'        // Subagent actively executing
  | 'complete'       // Finished successfully (no tool calls in final response)
  | 'cancelled'      // User or parent cancelled
  | 'abandoned'      // Parent conversation closed while running
  | 'max_iterations'; // Hit iteration limit, can be continued

/**
 * Branch type discriminator
 */
export type BranchType = 'human' | 'subagent';

/**
 * Metadata specific to subagent branches
 */
export interface SubagentBranchMetadata {
  task: string;
  subagentId: string;
  state: BranchState;
  iterations: number;
  maxIterations: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
  // Tool schemas that were pre-fetched for this subagent
  prefetchedTools?: Record<string, string[]>;
  /** Index signature for Record<string, unknown> compatibility */
  [key: string]: unknown;
}

/**
 * Metadata for human branches (minimal)
 */
export interface HumanBranchMetadata {
  // Human branches are simple - just an alternative conversation path
  description?: string;
}

/**
 * Unified branch structure
 * Lives in message.branches[] array
 */
export interface ConversationBranch {
  id: string;
  type: BranchType;

  /**
   * Context inheritance flag:
   * - true: LLM context includes parent messages 0-N + branch messages
   * - false: LLM context includes only branch messages (fresh start)
   */
  inheritContext: boolean;

  /**
   * The branch's own conversation history
   */
  messages: ChatMessage[];

  created: number;
  updated: number;

  /**
   * Type-specific metadata
   */
  metadata?: SubagentBranchMetadata | HumanBranchMetadata;
}

/**
 * Parameters for spawning a subagent
 * Includes ALL inherited settings from parent conversation
 */
export interface SubagentParams {
  task: string;
  parentConversationId: string;
  parentMessageId: string;
  agent?: string;
  // Pre-fetched tools: { agentName: [toolSlug1, toolSlug2] }
  tools?: Record<string, string[]>;
  contextFiles?: string[];
  context?: string;
  workspaceId?: string;
  sessionId?: string;
  maxIterations?: number;
  continueBranchId?: string;
  // Inherited from parent conversation - Model settings
  provider?: string;  // LLM provider (inherits parent's model)
  model?: string;     // LLM model (inherits parent's model)
  // Inherited from parent conversation - Agent settings
  agentPrompt?: string;  // Custom agent's full system prompt (merged into subagent prompt)
  agentName?: string;    // Custom agent name for reference
  // Inherited from parent conversation - Workspace data
  workspaceData?: any;   // Full comprehensive workspace data (sessions, states, files, etc.)
  // Inherited from parent conversation - Context notes (file paths)
  inheritedContextNotes?: string[];  // Note paths from parent's context notes
  // Inherited from parent conversation - Thinking settings
  thinkingEnabled?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
}

/**
 * Result from subagent execution
 */
export interface SubagentResult {
  success: boolean;
  content: string;
  branchId: string;
  conversationId: string;
  iterations: number;
  error?: string;
}

/**
 * Queued message for async processing
 */
export interface QueuedMessage {
  id: string;
  type: 'user' | 'subagent_result' | 'system';
  content: string;
  metadata?: {
    subagentId?: string;
    subagentTask?: string;
    branchId?: string;
    conversationId?: string;
    parentMessageId?: string;
    error?: boolean;
  };
  queuedAt: number;
}

/**
 * Agent status item for UI display
 */
export interface AgentStatusItem {
  subagentId: string;
  branchId: string;
  conversationId: string;
  parentMessageId: string;
  task: string;
  state: BranchState;
  iterations: number;
  maxIterations: number;
  startedAt: number;
  completedAt?: number;
  lastToolUsed?: string;
}

/**
 * Context for viewing a branch in the UI
 */
export interface BranchViewContext {
  conversationId: string;
  branchId: string;
  parentMessageId: string;
  branchType: BranchType;
  metadata?: SubagentBranchMetadata | HumanBranchMetadata;
}

/**
 * Events emitted by SubagentExecutor
 */
export interface SubagentExecutorEvents {
  onSubagentStarted: (subagentId: string, task: string, branchId: string) => void;
  onSubagentProgress: (subagentId: string, message: string, iteration: number) => void;
  onSubagentComplete: (subagentId: string, result: SubagentResult) => void;
  onSubagentError: (subagentId: string, error: string) => void;
  /**
   * Streaming update with incremental chunks (like parent chat)
   * Uses same StreamingController infrastructure for smooth updates
   * @param branchId - The branch being streamed
   * @param messageId - The assistant message ID being streamed
   * @param chunk - The NEW content chunk (incremental, not full content)
   * @param isComplete - Whether streaming is complete
   * @param fullContent - Full content so far (for finalization)
   */
  onStreamingUpdate: (branchId: string, messageId: string, chunk: string, isComplete: boolean, fullContent: string) => void;
  /**
   * Tool calls detected - SAME event as parent chat uses
   * Routes to ToolEventCoordinator.handleToolCallsDetected() for dynamic tool bubble creation
   */
  onToolCallsDetected: (branchId: string, messageId: string, toolCalls: any[]) => void;
}

/**
 * Events emitted by MessageQueueService
 */
export interface MessageQueueEvents {
  'message:queued': (data: { count: number; message: QueuedMessage }) => void;
  'message:processing': (data: { message: QueuedMessage }) => void;
  'queue:empty': () => void;
}

/**
 * Tool call structure from LLM responses
 */
export interface SubagentToolCall {
  id: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Tool schema for pre-fetched tools
 */
export interface ToolSchemaInfo {
  agent: string;
  slug?: string;
  name?: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/**
 * Tool execution result
 */
export interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Type guard for subagent metadata
 */
export function isSubagentMetadata(
  metadata: SubagentBranchMetadata | HumanBranchMetadata | undefined
): metadata is SubagentBranchMetadata {
  return metadata !== undefined && 'subagentId' in metadata;
}

/**
 * Type guard for checking if branch is a subagent branch
 */
export function isSubagentBranch(branch: ConversationBranch): boolean {
  return branch.type === 'subagent';
}

/**
 * Create a human branch with default values
 */
export function createHumanBranch(id: string): ConversationBranch {
  const now = Date.now();
  return {
    id,
    type: 'human',
    inheritContext: true,
    messages: [],
    created: now,
    updated: now,
  };
}

/**
 * Create a subagent branch with default values
 */
export function createSubagentBranch(
  id: string,
  subagentId: string,
  task: string,
  maxIterations: number = 10
): ConversationBranch {
  const now = Date.now();
  return {
    id,
    type: 'subagent',
    inheritContext: false,
    messages: [],
    created: now,
    updated: now,
    metadata: {
      task,
      subagentId,
      state: 'running',
      iterations: 0,
      maxIterations,
      startedAt: now,
    } satisfies SubagentBranchMetadata,
  };
}
