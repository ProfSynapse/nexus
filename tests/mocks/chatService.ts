/**
 * ChatService Mock
 *
 * Provides a controllable mock of the ChatService for testing
 * chat system components in isolation.
 */

import type { ConversationData } from '../../src/types/chat/ChatTypes';

const noopAsync = async (): Promise<void> => undefined;

type ToolCallLike = {
  id?: string;
  content?: string;
  toolCalls?: unknown;
  reasoning?: string;
};

interface MockChatService {
  getConversation: jest.Mock<Promise<ConversationData | null>, [string]>;
  updateConversation: jest.Mock<Promise<void>, [ConversationData]>;
  addMessage: jest.Mock<Promise<{ success: true; messageId: string }>, [{ id?: string }]>;
  createConversation: jest.Mock<Promise<ConversationData>, []>;
  deleteConversation: jest.Mock<Promise<void>, []>;
  generateResponseStreaming: jest.Mock;
}

interface MockBranchManager {
  createHumanBranch: jest.Mock<Promise<string>, [ConversationData, string, unknown]>;
  addMessagesToBranch: jest.Mock<Promise<boolean>, [string, unknown[]]>;
  switchToBranch: jest.Mock<Promise<boolean>, [string]>;
  switchToOriginal: jest.Mock<Promise<boolean>, []>;
  switchToBranchByIndex: jest.Mock<Promise<boolean>, [number]>;
  getActiveBranch: jest.Mock<null, []>;
  getActiveMessageContent: jest.Mock<string | undefined, [ToolCallLike]>;
  getActiveMessageToolCalls: jest.Mock<unknown, [ToolCallLike]>;
  getActiveMessageReasoning: jest.Mock<string | undefined, [ToolCallLike]>;
  getBranchInfo: jest.Mock<{ current: number; total: number; hasBranches: boolean }, [ToolCallLike]>;
  hasBranches: jest.Mock<boolean, []>;
  getBranches: jest.Mock<[], []>;
  getBranchById: jest.Mock<null, [string]>;
  hasSubagentBranches: jest.Mock<boolean, []>;
  getSubagentBranches: jest.Mock<[], []>;
  getHumanBranches: jest.Mock<[], []>;
  getPreviousIndex: jest.Mock<null, []>;
  getNextIndex: jest.Mock<null, []>;
}

interface MockStreamHandler {
  streamResponse: jest.Mock<Promise<{ streamedContent: string; toolCalls?: unknown }>, [unknown, string, unknown, unknown]>;
}

interface MockAbortHandler {
  handleAbort: jest.Mock<Promise<void>, []>;
  isAbortError: jest.Mock<boolean, [unknown]>;
  handleIfAbortError: jest.Mock<Promise<boolean>, [unknown]>;
}

interface MockConversationRepo {
  updateConversation: jest.Mock<Promise<void>, [unknown]>;
  getConversation: jest.Mock<Promise<null>, []>;
  createConversation: jest.Mock<Promise<string>, []>;
  deleteConversation: jest.Mock<Promise<void>, []>;
}

export interface MockChatServiceConfig {
  /** Conversation to return from getConversation */
  conversation?: ConversationData;
  /** Whether updateConversation should succeed */
  updateSuccess?: boolean;
}

/**
 * Creates a mock ChatService for testing
 */
export function createMockChatService(config: MockChatServiceConfig = {}): MockChatService {
  return {
    getConversation: jest.fn(async (_id: string) => {
      return config.conversation || null;
    }),

    updateConversation: jest.fn(async (_conversation: ConversationData) => {
      if (config.updateSuccess === false) {
        throw new Error('Update failed');
      }
    }),

    addMessage: jest.fn(async (params: { id?: string }) => ({
      success: true,
      messageId: params.id || `msg_${Date.now()}`
    })),

    createConversation: jest.fn(async () => ({
      id: 'conv_new',
      title: 'New Conversation',
      messages: [],
      created: Date.now(),
      updated: Date.now()
    })),

    deleteConversation: jest.fn(noopAsync),

    generateResponseStreaming: jest.fn()
  };
}

/**
 * Creates a mock BranchManager for testing
 */
export function createMockBranchManager(): MockBranchManager {
  return {
    createHumanBranch: jest.fn(async () => 'branch_new'),
    addMessagesToBranch: jest.fn(async () => true),
    switchToBranch: jest.fn(async () => true),
    switchToOriginal: jest.fn(async () => true),
    switchToBranchByIndex: jest.fn(async () => true),
    getActiveBranch: jest.fn(() => null),
    getActiveMessageContent: jest.fn((message: ToolCallLike) => message.content),
    getActiveMessageToolCalls: jest.fn((message: ToolCallLike) => message.toolCalls),
    getActiveMessageReasoning: jest.fn((message: ToolCallLike) => message.reasoning),
    getBranchInfo: jest.fn((_message: ToolCallLike) => ({
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
export function createMockStreamHandler(): MockStreamHandler {
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
export function createMockAbortHandler(): MockAbortHandler {
  return {
    handleAbort: jest.fn(noopAsync),
    isAbortError: jest.fn((error: unknown) =>
      error instanceof Error && error.name === 'AbortError'
    ),
    handleIfAbortError: jest.fn(async () => false)
  };
}

/**
 * Creates a mock ConversationRepository for testing
 */
export function createMockConversationRepo(): MockConversationRepo {
  return {
    updateConversation: jest.fn(noopAsync),
    getConversation: jest.fn(async () => null),
    createConversation: jest.fn(async () => 'conv_new'),
    deleteConversation: jest.fn(noopAsync)
  };
}
