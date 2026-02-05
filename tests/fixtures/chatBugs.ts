/**
 * Chat Bug Fixes Test Fixtures
 *
 * Provides test data for testing the 12 chat system bug fixes
 * covering stop, retry, tool call display, and branch navigation.
 */

import type { ConversationData, ConversationMessage, ToolCall } from '../../src/types/chat/ChatTypes';
import type { ConversationBranch } from '../../src/types/branch/BranchTypes';
import type { AlternativeMessage } from '../../src/types/storage/HybridStorageTypes';

// ============================================================================
// Tool Call Fixtures
// ============================================================================

/** A completed tool call with result and success set */
export function createCompletedToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc_completed_1',
    type: 'function',
    name: 'searchContent',
    displayName: 'Search Content',
    technicalName: 'searchManager_searchContent',
    function: {
      name: 'searchManager_searchContent',
      arguments: JSON.stringify({ query: 'test query' })
    },
    parameters: { query: 'test query' },
    result: { matches: ['file1.md', 'file2.md'] },
    success: true,
    executionTime: 150,
    ...overrides
  };
}

/** An incomplete tool call (still streaming, no result) */
export function createIncompleteToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc_incomplete_1',
    type: 'function',
    name: 'readContent',
    displayName: 'Read Content',
    technicalName: 'contentManager_readContent',
    function: {
      name: 'contentManager_readContent',
      arguments: JSON.stringify({ path: 'notes/test.md' })
    },
    parameters: { path: 'notes/test.md' },
    // No result, no success — still in progress
    ...overrides
  };
}

/** A tool call that failed */
export function createFailedToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc_failed_1',
    type: 'function',
    name: 'createContent',
    function: {
      name: 'contentManager_createContent',
      arguments: JSON.stringify({ path: 'notes/new.md', content: 'hello' })
    },
    result: undefined,
    success: false,
    error: 'File already exists',
    executionTime: 30,
    ...overrides
  };
}

// Pre-built tool call arrays for convenience
export const TOOL_CALLS = {
  /** All completed (have result or success set) */
  allCompleted: [
    createCompletedToolCall({ id: 'tc_c1' }),
    createCompletedToolCall({ id: 'tc_c2', name: 'list', result: ['a.md', 'b.md'] }),
    createFailedToolCall({ id: 'tc_f1' })
  ],

  /** All incomplete (no result, no success) */
  allIncomplete: [
    createIncompleteToolCall({ id: 'tc_i1' }),
    createIncompleteToolCall({ id: 'tc_i2', name: 'move' })
  ],

  /** Mix of completed and incomplete */
  mixed: [
    createCompletedToolCall({ id: 'tc_mix_c1' }),
    createIncompleteToolCall({ id: 'tc_mix_i1' }),
    createCompletedToolCall({ id: 'tc_mix_c2', success: true, result: 'done' }),
    createIncompleteToolCall({ id: 'tc_mix_i2' })
  ],

  /** Single completed */
  singleCompleted: [createCompletedToolCall()],

  /** Single incomplete */
  singleIncomplete: [createIncompleteToolCall()],

  /** Empty array */
  empty: [] as ToolCall[]
};

// ============================================================================
// Message Fixtures
// ============================================================================

export function createUserMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg_user_1',
    role: 'user',
    content: 'Search my vault for notes about testing',
    timestamp: Date.now() - 5000,
    conversationId: 'conv_1',
    state: 'complete',
    ...overrides
  };
}

export function createAssistantMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg_ai_1',
    role: 'assistant',
    content: 'I found several notes about testing in your vault.',
    timestamp: Date.now() - 4000,
    conversationId: 'conv_1',
    state: 'complete',
    toolCalls: TOOL_CALLS.allCompleted,
    ...overrides
  };
}

export function createStreamingMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg_streaming_1',
    role: 'assistant',
    content: 'I am searching for',
    timestamp: Date.now(),
    conversationId: 'conv_1',
    state: 'streaming',
    isLoading: true,
    toolCalls: TOOL_CALLS.mixed,
    ...overrides
  };
}

export function createAbortedMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg_aborted_1',
    role: 'assistant',
    content: 'Partial response before abort',
    timestamp: Date.now(),
    conversationId: 'conv_1',
    state: 'aborted',
    isLoading: false,
    toolCalls: TOOL_CALLS.allCompleted,
    ...overrides
  };
}

// ============================================================================
// Branch Fixtures
// ============================================================================

export function createBranch(overrides: Partial<ConversationBranch> = {}): ConversationBranch {
  const now = Date.now();
  return {
    id: 'branch_1',
    type: 'human',
    inheritContext: true,
    messages: [
      createAssistantMessage({
        id: 'msg_branch_ai_1',
        content: 'Alternative response from branch',
        toolCalls: [createCompletedToolCall({ id: 'tc_branch_1' })]
      })
    ],
    created: now,
    updated: now,
    metadata: { description: 'Alternative response 1' },
    ...overrides
  };
}

export function createEmptyBranch(overrides: Partial<ConversationBranch> = {}): ConversationBranch {
  const now = Date.now();
  return {
    id: 'branch_empty',
    type: 'human',
    inheritContext: true,
    messages: [],
    created: now,
    updated: now,
    metadata: { description: 'Empty branch (still loading)' },
    ...overrides
  };
}

// ============================================================================
// Conversation Fixtures
// ============================================================================

export function createConversation(overrides: Partial<ConversationData> = {}): ConversationData {
  return {
    id: 'conv_1',
    title: 'Test Conversation',
    messages: [
      createUserMessage(),
      createAssistantMessage()
    ],
    created: Date.now() - 10000,
    updated: Date.now(),
    ...overrides
  };
}

/** Conversation with a message that has branches */
export function createConversationWithBranches(): ConversationData {
  const msg = createAssistantMessage({
    branches: [createBranch()],
    activeAlternativeIndex: 0
  });

  return createConversation({
    messages: [createUserMessage(), msg]
  });
}

/** Conversation with a streaming message */
export function createStreamingConversation(): ConversationData {
  return createConversation({
    messages: [
      createUserMessage(),
      createStreamingMessage()
    ]
  });
}

// ============================================================================
// AlternativeMessage Fixtures (for MessageRepository tests)
// ============================================================================

export function createAlternativeMessage(overrides: Partial<AlternativeMessage> = {}): AlternativeMessage {
  return {
    id: 'alt_1',
    content: 'Alternative response content',
    timestamp: Date.now(),
    toolCalls: [createCompletedToolCall({ id: 'tc_alt_1' })],
    reasoning: 'Thought about this carefully',
    state: 'complete',
    ...overrides
  };
}

// ============================================================================
// MessageRepository row fixtures
// ============================================================================

export function createMessageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_1',
    conversationId: 'conv_1',
    role: 'assistant',
    content: 'Test message content',
    timestamp: Date.now(),
    state: 'complete',
    sequenceNumber: 1,
    toolCallsJson: null,
    toolCallId: null,
    reasoningContent: null,
    metadataJson: null,
    alternativesJson: null,
    activeAlternativeIndex: 0,
    ...overrides
  };
}
