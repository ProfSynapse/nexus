/**
 * ChatService Mock
 *
 * Provides a controllable mock of the ChatService for testing
 * chat system components in isolation.
 */

import type { ConversationData } from '../../src/types/chat/ChatTypes';

export interface MockChatServiceConfig {
  /** Conversation to return from getConversation */
  conversation?: ConversationData;
  /** Whether updateConversation should succeed */
  updateSuccess?: boolean;
}

/**
 * Creates a mock ChatService for testing
 */
export function createMockChatService(config: MockChatServiceConfig = {}) {
  return {
    getConversation: jest.fn(async (id: string) => {
      return config.conversation || null;
    }),

    updateConversation: jest.fn(async (conversation: ConversationData) => {
      if (config.updateSuccess === false) {
        throw new Error('Update failed');
      }
    }),

    createConversation: jest.fn(async () => ({
      id: 'conv_new',
      title: 'New Conversation',
      messages: [],
      created: Date.now(),
      updated: Date.now()
    })),

    deleteConversation: jest.fn(async () => {}),

    generateResponseStreaming: jest.fn()
  };
}

/**
 * Creates a mock BranchManager for testing
 */
export function createMockBranchManager() {
  return {
    createHumanBranch: jest.fn(async () => 'branch_new'),
    switchToBranch: jest.fn(async () => true),
    switchToOriginal: jest.fn(async () => true),
    switchToBranchByIndex: jest.fn(async () => true),
    getActiveBranch: jest.fn(() => null),
    getActiveMessageContent: jest.fn((message: any) => message.content),
    getActiveMessageToolCalls: jest.fn((message: any) => message.toolCalls),
    getActiveMessageReasoning: jest.fn((message: any) => message.reasoning),
    getBranchInfo: jest.fn((message: any) => ({
      current: 1,
      total: 1,
      hasBranches: false
    })),
    hasBranches: jest.fn(() => false),
    getBranches: jest.fn(() => []),
    getBranchById: jest.fn(() => null),
    hasSubagentBranches: jest.fn(() => false),
    getSubagentBranches: jest.fn(() => []),
    getHumanBranches: jest.fn(() => []),
    getPreviousIndex: jest.fn(() => null),
    getNextIndex: jest.fn(() => null)
  };
}

/**
 * Creates a mock MessageStreamHandler for testing
 */
export function createMockStreamHandler() {
  return {
    streamResponse: jest.fn(async () => ({
      streamedContent: 'Streamed response content',
      toolCalls: undefined
    }))
  };
}

/**
 * Creates a mock AbortHandler for testing
 */
export function createMockAbortHandler() {
  return {
    handleAbort: jest.fn(async () => {}),
    isAbortError: jest.fn((error: unknown) =>
      error instanceof Error && error.name === 'AbortError'
    ),
    handleIfAbortError: jest.fn(async () => false)
  };
}

/**
 * Creates a mock ConversationRepository for testing
 */
export function createMockConversationRepo() {
  return {
    updateConversation: jest.fn(async () => {}),
    getConversation: jest.fn(async () => null),
    createConversation: jest.fn(async () => 'conv_new'),
    deleteConversation: jest.fn(async () => {})
  };
}
