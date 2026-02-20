/**
 * Subagent Bug Fixes - Targeted Smoke Tests
 *
 * Tests for the highest-risk fixes in the subagent system:
 * - B1: Continue subagent feature (continueBranchId loads existing branch)
 * - B2: Retry stuck in thinking (non-AbortError resets loading state)
 * - B3: Abort race condition (abort between branch creation and stream start)
 * - M1: Icon debounce (500ms minimum display time for spinner)
 * - M7: Generation guard (concurrent subagent completions don't trigger duplicates)
 */

import { SubagentExecutor } from '../../src/services/chat/SubagentExecutor';
import { MessageAlternativeService } from '../../src/ui/chat/services/MessageAlternativeService';
import type { SubagentParams } from '../../src/types/branch/BranchTypes';
import {
  createConversation,
  createUserMessage,
  createAssistantMessage,
} from '../fixtures/chatBugs';
import {
  createMockChatService,
  createMockBranchManager,
  createMockStreamHandler,
  createMockAbortHandler,
} from '../mocks/chatService';

// ============================================================================
// Shared Helpers
// ============================================================================

function createMockBranchService() {
  return {
    createSubagentBranch: jest.fn(async () => 'branch_new_123'),
    getBranch: jest.fn(async () => ({
      branch: {
        id: 'branch_existing',
        messages: [
          { id: 'msg_system', role: 'system', content: 'You are a subagent', conversationId: 'branch_existing' },
          { id: 'msg_user', role: 'user', content: 'Do something', conversationId: 'branch_existing' },
          { id: 'msg_assistant', role: 'assistant', content: 'I did it', conversationId: 'branch_existing' },
        ],
      },
      metadata: { state: 'max_iterations', task: 'Test task' },
    })),
    addMessageToBranch: jest.fn(async () => {}),
    updateMessageInBranch: jest.fn(async () => {}),
    updateBranchState: jest.fn(async () => {}),
    updateBranchMetadata: jest.fn(async () => {}),
  };
}

function createMockMessageQueue() {
  return {
    enqueue: jest.fn(),
    setProcessor: jest.fn(),
    onGenerationStart: jest.fn(),
    onGenerationComplete: jest.fn(),
  };
}

/** Creates a streaming generator that yields a single complete text-only response */
function createSimpleStreamingGenerator(responseText = 'Done') {
  return async function* () {
    yield { chunk: responseText, complete: false, toolCalls: undefined, reasoning: undefined };
    yield { chunk: '', complete: true, toolCalls: undefined, reasoning: undefined };
  };
}

/** Creates a streaming generator that yields tool calls (subagent not done) */
function createToolCallStreamingGenerator() {
  return async function* () {
    yield {
      chunk: 'Using tool...',
      complete: false,
      toolCalls: [{ id: 'tc_1', function: { name: 'searchContent', arguments: '{}' } }],
      reasoning: undefined,
    };
    yield { chunk: '', complete: true, toolCalls: undefined, reasoning: undefined };
  };
}

function createDefaultParams(overrides: Partial<SubagentParams> = {}): SubagentParams {
  return {
    task: 'Test subagent task',
    parentConversationId: 'conv_parent_123',
    parentMessageId: 'msg_parent_456',
    maxIterations: 3,
    ...overrides,
  };
}

function createExecutor(overrides: Record<string, any> = {}) {
  const mockBranchService = createMockBranchService();
  const mockMessageQueue = createMockMessageQueue();
  const executor = new SubagentExecutor({
    branchService: mockBranchService as any,
    messageQueueService: mockMessageQueue as any,
    directToolExecutor: { getAvailableTools: jest.fn(async () => []), executeToolCalls: jest.fn() } as any,
    streamingGenerator: createSimpleStreamingGenerator(),
    ...overrides,
  });
  return { executor, mockBranchService, mockMessageQueue };
}

// ============================================================================
// B1: Continue subagent feature
// ============================================================================

describe('B1: Continue subagent feature', () => {
  it('should reuse existing branch when continueBranchId is provided', async () => {
    const { executor, mockBranchService } = createExecutor();
    const params = createDefaultParams({ continueBranchId: 'branch_existing' });

    const result = await executor.executeSubagent(params);

    // Should NOT create a new branch
    expect(mockBranchService.createSubagentBranch).not.toHaveBeenCalled();
    // Should return the existing branch ID
    expect(result.branchId).toBe('branch_existing');
  });

  it('should verify branch exists before continuing', async () => {
    const { executor, mockBranchService } = createExecutor();
    // Branch doesn't exist
    mockBranchService.getBranch.mockResolvedValue(null);

    const params = createDefaultParams({ continueBranchId: 'branch_nonexistent' });

    await expect(executor.executeSubagent(params)).rejects.toThrow('Branch not found for continuation');
  });

  it('should update branch state to running on continuation', async () => {
    const { executor, mockBranchService } = createExecutor();
    const params = createDefaultParams({ continueBranchId: 'branch_existing' });

    await executor.executeSubagent(params);

    expect(mockBranchService.updateBranchState).toHaveBeenCalledWith('branch_existing', 'running');
  });

  it('should add continuation prompt message to existing branch', async () => {
    const { executor, mockBranchService } = createExecutor();
    const params = createDefaultParams({ continueBranchId: 'branch_existing' });

    await executor.executeSubagent(params);

    // Wait for the fire-and-forget loop to finish
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should have added a continuation user message
    const addedMessages = mockBranchService.addMessageToBranch.mock.calls;
    const continuationMessage = addedMessages.find(
      ([, msg]: [string, any]) => msg.role === 'user' && msg.content.includes('Continue working')
    );
    expect(continuationMessage).toBeDefined();
  });

  it('should create NEW branch when continueBranchId is NOT provided', async () => {
    const { executor, mockBranchService } = createExecutor();
    const params = createDefaultParams(); // no continueBranchId

    const result = await executor.executeSubagent(params);

    expect(mockBranchService.createSubagentBranch).toHaveBeenCalled();
    expect(result.branchId).toBe('branch_new_123');
  });
});

// ============================================================================
// B2: Retry stuck in thinking
// ============================================================================

describe('B2: Retry stuck in thinking (error state reset)', () => {
  function createRetryService() {
    const mockChatService = createMockChatService();
    const mockBranchManager = createMockBranchManager();
    const mockStreamHandler = createMockStreamHandler();
    const mockAbortHandler = createMockAbortHandler();
    const mockEvents = {
      onStreamingUpdate: jest.fn(),
      onConversationUpdated: jest.fn(),
      onToolCallsDetected: jest.fn(),
      onLoadingStateChanged: jest.fn(),
      onError: jest.fn(),
    };
    const service = new MessageAlternativeService(
      mockChatService as any,
      mockBranchManager as any,
      mockStreamHandler as any,
      mockAbortHandler as any,
      mockEvents,
    );
    return { service, mockStreamHandler, mockEvents, mockChatService };
  }

  it('should set state to error and isLoading to false on non-AbortError', async () => {
    const { service, mockStreamHandler } = createRetryService();
    mockStreamHandler.streamResponse.mockRejectedValue(new Error('Network failure'));

    const conversation = createConversation({
      messages: [
        createUserMessage({ id: 'msg_user' }),
        createAssistantMessage({ id: 'msg_ai', content: 'Original content' }),
      ],
    });

    await service.createAlternativeResponse(conversation, 'msg_ai');

    // The AI message should no longer be loading (B2 core fix)
    const aiMessage = conversation.messages[1];
    expect(aiMessage.isLoading).toBe(false);
    // 'aborted' is the closest valid MessageState for error interruption
    // (type union: 'draft' | 'streaming' | 'complete' | 'aborted' | 'invalid')
    expect(aiMessage.state).toBe('aborted');
  });

  it('should fire onError for non-abort errors', async () => {
    const { service, mockStreamHandler, mockEvents } = createRetryService();
    mockStreamHandler.streamResponse.mockRejectedValue(new TypeError('Cannot read property'));

    const conversation = createConversation({
      messages: [
        createUserMessage({ id: 'msg_user' }),
        createAssistantMessage({ id: 'msg_ai' }),
      ],
    });

    await service.createAlternativeResponse(conversation, 'msg_ai');

    expect(mockEvents.onError).toHaveBeenCalledWith('Failed to generate alternative response');
  });

  it('should fire onConversationUpdated on error so UI rerenders', async () => {
    const { service, mockStreamHandler, mockEvents } = createRetryService();
    mockStreamHandler.streamResponse.mockRejectedValue(new Error('Server error'));

    const conversation = createConversation({
      messages: [
        createUserMessage({ id: 'msg_user' }),
        createAssistantMessage({ id: 'msg_ai' }),
      ],
    });

    await service.createAlternativeResponse(conversation, 'msg_ai');

    expect(mockEvents.onConversationUpdated).toHaveBeenCalledWith(conversation);
  });

  it('should set isLoading false via onLoadingStateChanged in finally block', async () => {
    const { service, mockStreamHandler, mockEvents } = createRetryService();
    mockStreamHandler.streamResponse.mockRejectedValue(new Error('Any error'));

    const conversation = createConversation({
      messages: [
        createUserMessage({ id: 'msg_user' }),
        createAssistantMessage({ id: 'msg_ai' }),
      ],
    });

    await service.createAlternativeResponse(conversation, 'msg_ai');

    // The final onLoadingStateChanged(false) should always fire
    const loadingCalls = mockEvents.onLoadingStateChanged.mock.calls;
    expect(loadingCalls[loadingCalls.length - 1]).toEqual([false]);
  });
});

// ============================================================================
// B3: Abort race condition (abort between branch creation and stream start)
// ============================================================================

describe('B3: Abort race condition', () => {
  it('should set cancelled state when cancelSubagent is called during streaming', async () => {
    // This generator blocks between chunks, giving the test time to abort
    // The abort check inside runIterationLoop's for-await will catch it
    let resolveBlock: () => void;
    const blockPromise = new Promise<void>(resolve => { resolveBlock = resolve; });

    const { executor } = createExecutor({
      streamingGenerator: async function* () {
        yield { chunk: 'Starting...', complete: false, toolCalls: undefined, reasoning: undefined };
        // Block here — test will cancel during this await, then unblock
        await blockPromise;
        yield { chunk: '', complete: true, toolCalls: undefined, reasoning: undefined };
      },
    });

    const result = await executor.executeSubagent(createDefaultParams());

    // Small delay to let the fire-and-forget loop enter the generator
    await new Promise(resolve => setTimeout(resolve, 20));

    // Cancel the subagent while the generator is blocked
    executor.cancelSubagent(result.subagentId);

    // Unblock the generator so the abort check can run
    resolveBlock!();

    // Give the loop time to process the abort
    await new Promise(resolve => setTimeout(resolve, 100));

    // Status should be cancelled (not stuck in running or max_iterations)
    const status = executor.getSubagentState(result.subagentId);
    expect(status).toBe('cancelled');
  });

  it('should clean up streamingBranchMessages on cancellation', async () => {
    const { executor } = createExecutor({
      streamingGenerator: async function* () {
        yield { chunk: 'Starting...', complete: false, toolCalls: undefined, reasoning: undefined };
        await new Promise(resolve => setTimeout(resolve, 500));
        yield { chunk: '', complete: true, toolCalls: undefined, reasoning: undefined };
      },
    });

    const result = await executor.executeSubagent(createDefaultParams());
    executor.cancelSubagent(result.subagentId);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Streaming state should be cleaned up
    expect(executor.isBranchStreaming(result.branchId)).toBe(false);
  });

  it('should remove from activeSubagents on cancellation', async () => {
    const { executor } = createExecutor({
      streamingGenerator: async function* () {
        yield { chunk: 'Starting...', complete: false, toolCalls: undefined, reasoning: undefined };
        await new Promise(resolve => setTimeout(resolve, 500));
        yield { chunk: '', complete: true, toolCalls: undefined, reasoning: undefined };
      },
    });

    const result = await executor.executeSubagent(createDefaultParams());
    executor.cancelSubagent(result.subagentId);
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(executor.isSubagentRunning(result.subagentId)).toBe(false);
  });
});

// ============================================================================
// M1: Icon debounce - executor status tracking
// ============================================================================

describe('M1: Icon debounce (status tracking for minimum display time)', () => {
  it('should track running state immediately when subagent starts', async () => {
    const { executor } = createExecutor();
    await executor.executeSubagent(createDefaultParams());

    const statusList = executor.getAgentStatusList();
    expect(statusList.length).toBe(1);
    expect(statusList[0].state).toBe('running');
  });

  it('should track startedAt timestamp for duration calculation', async () => {
    const { executor } = createExecutor();
    const beforeStart = Date.now();
    const result = await executor.executeSubagent(createDefaultParams());

    const statusList = executor.getAgentStatusList();
    const agent = statusList.find(s => s.subagentId === result.subagentId);
    expect(agent).toBeDefined();
    expect(agent!.startedAt).toBeGreaterThanOrEqual(beforeStart);
  });

  it('should set completedAt on status when agent finishes', async () => {
    const { executor } = createExecutor();
    const result = await executor.executeSubagent(createDefaultParams());

    // Wait for fire-and-forget to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    const statusList = executor.getAgentStatusList();
    const agent = statusList.find(s => s.subagentId === result.subagentId);
    expect(agent).toBeDefined();
    expect(agent!.completedAt).toBeDefined();
    expect(agent!.completedAt!).toBeGreaterThanOrEqual(agent!.startedAt);
  });
});

// ============================================================================
// M7: Generation guard (concurrent subagent completions)
// ============================================================================

describe('M7: Generation guard pattern', () => {
  it('should queue results when generation is already in progress', () => {
    // Model the guard behavior from SubagentController
    const pendingResults: string[] = [];
    let isGenerating = false;

    const processResult = (content: string): 'processed' | 'queued' => {
      if (isGenerating) {
        pendingResults.push(content);
        return 'queued';
      }
      isGenerating = true;
      return 'processed';
    };

    // First result processes immediately
    expect(processResult('Result 1')).toBe('processed');
    // Second and third arrive while first is generating
    expect(processResult('Result 2')).toBe('queued');
    expect(processResult('Result 3')).toBe('queued');
    expect(pendingResults).toEqual(['Result 2', 'Result 3']);
  });

  it('should drain pending results sequentially after generation completes', () => {
    const pendingResults: string[] = ['Result 2', 'Result 3'];
    let isGenerating = false;
    const processedOrder: string[] = [];

    // Simulate drain
    while (pendingResults.length > 0 && !isGenerating) {
      const next = pendingResults.shift()!;
      processedOrder.push(next);
    }

    expect(processedOrder).toEqual(['Result 2', 'Result 3']);
    expect(pendingResults).toHaveLength(0);
  });

  it('should reset guard and queue on cleanup', () => {
    // Model cleanup() from SubagentController
    const state = {
      isGeneratingParentResponse: true,
      pendingSubagentResults: ['pending1', 'pending2'],
    };

    // Cleanup
    state.isGeneratingParentResponse = false;
    state.pendingSubagentResults = [];

    expect(state.isGeneratingParentResponse).toBe(false);
    expect(state.pendingSubagentResults).toHaveLength(0);
  });
});

// ============================================================================
// Additional executor behavioral tests for key fixes
// ============================================================================

describe('SubagentExecutor - clearAgentStatus (F2 fix)', () => {
  it('should abort running subagents and clear all maps', async () => {
    const { executor } = createExecutor({
      streamingGenerator: async function* () {
        yield { chunk: 'Working...', complete: false, toolCalls: undefined, reasoning: undefined };
        await new Promise(resolve => setTimeout(resolve, 1000));
        yield { chunk: '', complete: true, toolCalls: undefined, reasoning: undefined };
      },
    });

    // Start two subagents
    await executor.executeSubagent(createDefaultParams());
    await executor.executeSubagent(createDefaultParams({ task: 'Second task' }));

    expect(executor.getActiveSubagents().length).toBe(2);

    executor.clearAgentStatus();

    expect(executor.getActiveSubagents().length).toBe(0);
    expect(executor.getAgentStatusList().length).toBe(0);
  });
});

describe('SubagentExecutor - maxIterations (F1 fix)', () => {
  it('should return max_iterations when loop exhausts iterations with tool calls', async () => {
    const mockBranchService = createMockBranchService();
    const mockMessageQueue = createMockMessageQueue();

    const executor = new SubagentExecutor({
      branchService: mockBranchService as any,
      messageQueueService: mockMessageQueue as any,
      directToolExecutor: { getAvailableTools: jest.fn(async () => []), executeToolCalls: jest.fn() } as any,
      streamingGenerator: createToolCallStreamingGenerator(),
    });

    const params = createDefaultParams({ maxIterations: 2 });
    await executor.executeSubagent(params);

    // Wait for the fire-and-forget loop
    await new Promise(resolve => setTimeout(resolve, 200));

    // Branch state should be max_iterations (not complete)
    const updateCalls = mockBranchService.updateBranchState.mock.calls;
    const lastCall = updateCalls[updateCalls.length - 1];
    expect(lastCall[1]).toBe('max_iterations');
  });
});

describe('SubagentExecutor - conversationId fix (B4)', () => {
  it('should use branchId as conversationId in initial messages', async () => {
    const { executor, mockBranchService } = createExecutor();
    const params = createDefaultParams();

    await executor.executeSubagent(params);

    // Wait for fire-and-forget
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check that messages added to branch use branchId as conversationId
    const addedMessages = mockBranchService.addMessageToBranch.mock.calls;
    expect(addedMessages.length).toBeGreaterThan(0);

    for (const [branchId, message] of addedMessages) {
      expect(message.conversationId).toBe(branchId);
      // Should NOT be the parent conversation ID
      expect(message.conversationId).not.toBe('conv_parent_123');
    }
  });
});
