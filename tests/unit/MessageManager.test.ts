import { MessageManager } from '../../src/ui/chat/services/MessageManager';
import { createConversation } from '../fixtures/chatBugs';
import { createMockBranchManager, createMockChatService } from '../mocks/chatService';
import { LLMProviderError } from '../../src/services/llm/adapters/types';
import { ChatService } from '../../src/services/chat/ChatService';
import { BranchManager } from '../../src/ui/chat/services/BranchManager';

jest.mock('../../src/services/llm/adapters/webllm/WebLLMLifecycleManager', () => ({
  getWebLLMLifecycleManager: () => ({
    recordActivity: jest.fn()
  })
}));

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve: (value: T | PromiseLike<T>) => resolve?.(value),
    reject: (reason?: unknown) => reject?.(reason)
  };
}

describe('MessageManager interrupt flow', () => {
  it('waits for abort cleanup before appending a steering message', async () => {
    const conversation = createConversation({ messages: [] });
    const mockChatService = createMockChatService({ conversation });
    const firstChunkSeen = createDeferred<void>();

    mockChatService.getConversation.mockImplementation(async () => conversation);
    mockChatService.generateResponseStreaming.mockImplementation(
      (_conversationId: string, userMessage: string, options?: { messageId?: string; abortSignal?: AbortSignal }) => {
        async function* stream() {
          if (userMessage === 'First question') {
            yield {
              chunk: 'Partial answer',
              complete: false,
              messageId: options?.messageId || 'msg_first_ai'
            };

            while (!options?.abortSignal?.aborted) {
              await new Promise(resolve => setTimeout(resolve, 0));
            }

            throw Object.assign(new Error('Generation aborted by user'), { name: 'AbortError' });
          }

          yield {
            chunk: 'Steered answer',
            complete: false,
            messageId: options?.messageId || 'msg_second_ai'
          };
          yield {
            chunk: '',
            complete: true,
            messageId: options?.messageId || 'msg_second_ai'
          };
        }

        return stream();
      }
    );

    const events = {
      onMessageAdded: jest.fn(),
      onAIMessageStarted: jest.fn(),
      onStreamingUpdate: jest.fn((messageId: string, content: string, _isComplete: boolean, isIncremental?: boolean) => {
        if (content === 'Partial answer' && isIncremental) {
          firstChunkSeen.resolve();
        }
      }),
      onConversationUpdated: jest.fn(),
      onLoadingStateChanged: jest.fn(),
      onError: jest.fn(),
      onToolCallsDetected: jest.fn(),
      onToolExecutionStarted: jest.fn(),
      onToolExecutionCompleted: jest.fn(),
      onMessageIdUpdated: jest.fn(),
      onGenerationAborted: jest.fn(),
      onUsageAvailable: jest.fn()
    };

    const manager = new MessageManager(
      mockChatService as unknown as ChatService,
      createMockBranchManager() as unknown as BranchManager,
      events
    );

    const firstSend = manager.sendMessage(conversation, 'First question');
    await firstChunkSeen.promise;

    await manager.interruptCurrentGeneration();
    await firstSend;

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'First question',
      state: 'complete'
    });
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Partial answer',
      state: 'aborted',
      isLoading: false
    });

    await manager.sendMessage(conversation, 'Please focus on the bug fix');

    expect(conversation.messages).toHaveLength(4);
    expect(conversation.messages[2]).toMatchObject({
      role: 'user',
      content: 'Please focus on the bug fix',
      state: 'complete'
    });
    expect(conversation.messages[3]).toMatchObject({
      role: 'assistant',
      content: 'Steered answer',
      state: 'complete'
    });
    expect(events.onError).not.toHaveBeenCalled();
  });

  it('cancelCurrentGeneration is a safe no-op when no generation is active', async () => {
    const conversation = createConversation({ messages: [] });
    const mockChatService = createMockChatService({ conversation });

    const events = {
      onMessageAdded: jest.fn(),
      onAIMessageStarted: jest.fn(),
      onStreamingUpdate: jest.fn(),
      onConversationUpdated: jest.fn(),
      onLoadingStateChanged: jest.fn(),
      onError: jest.fn(),
      onToolCallsDetected: jest.fn(),
      onToolExecutionStarted: jest.fn(),
      onToolExecutionCompleted: jest.fn(),
      onMessageIdUpdated: jest.fn(),
      onGenerationAborted: jest.fn(),
      onUsageAvailable: jest.fn()
    };

    const manager = new MessageManager(
      mockChatService as unknown as ChatService,
      createMockBranchManager() as unknown as BranchManager,
      events
    );

    // Should not throw
    await manager.cancelCurrentGeneration();

    // Loading state should be set to false (reset)
    expect(events.onLoadingStateChanged).toHaveBeenCalledWith(false);
    // No abort event since no streaming message was active
    expect(events.onGenerationAborted).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
  });

  it('currentStreamingMessageId is cleared after generation completes', async () => {
    const conversation = createConversation({ messages: [] });
    const mockChatService = createMockChatService({ conversation });

    mockChatService.getConversation.mockImplementation(async () => conversation);
    mockChatService.generateResponseStreaming.mockImplementation(
      (_conversationId: string, _userMessage: string, options?: { messageId?: string; abortSignal?: AbortSignal }) => {
        async function* stream() {
          yield { chunk: 'Response', complete: false, messageId: options?.messageId || 'msg_ai' };
          yield { chunk: '', complete: true, messageId: options?.messageId || 'msg_ai' };
        }
        return stream();
      }
    );

    const events = {
      onMessageAdded: jest.fn(),
      onAIMessageStarted: jest.fn(),
      onStreamingUpdate: jest.fn(),
      onConversationUpdated: jest.fn(),
      onLoadingStateChanged: jest.fn(),
      onError: jest.fn(),
      onToolCallsDetected: jest.fn(),
      onToolExecutionStarted: jest.fn(),
      onToolExecutionCompleted: jest.fn(),
      onMessageIdUpdated: jest.fn(),
      onGenerationAborted: jest.fn(),
      onUsageAvailable: jest.fn()
    };

    const manager = new MessageManager(
      mockChatService as unknown as ChatService,
      createMockBranchManager() as unknown as BranchManager,
      events
    );

    await manager.sendMessage(conversation, 'Hello');

    // After completion, cancel should not fire onGenerationAborted
    // because currentStreamingMessageId is already null
    await manager.cancelCurrentGeneration();
    expect(events.onGenerationAborted).not.toHaveBeenCalled();
  });

  it('loading state transitions through true then false during generation', async () => {
    const conversation = createConversation({ messages: [] });
    const mockChatService = createMockChatService({ conversation });

    mockChatService.getConversation.mockImplementation(async () => conversation);
    mockChatService.generateResponseStreaming.mockImplementation(
      (_conversationId: string, _userMessage: string, options?: { messageId?: string; abortSignal?: AbortSignal }) => {
        async function* stream() {
          yield { chunk: 'Answer', complete: false, messageId: options?.messageId || 'msg_ai' };
          yield { chunk: '', complete: true, messageId: options?.messageId || 'msg_ai' };
        }
        return stream();
      }
    );

    const loadingStates: boolean[] = [];
    const events = {
      onMessageAdded: jest.fn(),
      onAIMessageStarted: jest.fn(),
      onStreamingUpdate: jest.fn(),
      onConversationUpdated: jest.fn(),
      onLoadingStateChanged: jest.fn((isLoading: boolean) => {
        loadingStates.push(isLoading);
      }),
      onError: jest.fn(),
      onToolCallsDetected: jest.fn(),
      onToolExecutionStarted: jest.fn(),
      onToolExecutionCompleted: jest.fn(),
      onMessageIdUpdated: jest.fn(),
      onGenerationAborted: jest.fn(),
      onUsageAvailable: jest.fn()
    };

    const manager = new MessageManager(
      mockChatService as unknown as ChatService,
      createMockBranchManager() as unknown as BranchManager,
      events
    );

    await manager.sendMessage(conversation, 'Hello');

    // Loading should have been set true then false
    expect(loadingStates[0]).toBe(true);
    expect(loadingStates[loadingStates.length - 1]).toBe(false);
    expect(manager.getIsLoading()).toBe(false);
  });

  it('surfaces provider-specific send errors instead of a generic fallback', async () => {
    const conversation = createConversation({ messages: [] });
    const mockChatService = createMockChatService({ conversation });

      mockChatService.generateResponseStreaming.mockImplementation(() => {
      async function* stream() {
        throw new LLMProviderError(
          'Claude Code could not start because the local CLI command was too long for this platform.',
          'anthropic-claude-code',
          'REQUEST_TOO_LARGE'
        );
        yield undefined;
      }

      return stream();
    });

    const events = {
      onMessageAdded: jest.fn(),
      onAIMessageStarted: jest.fn(),
      onStreamingUpdate: jest.fn(),
      onConversationUpdated: jest.fn(),
      onLoadingStateChanged: jest.fn(),
      onError: jest.fn(),
      onToolCallsDetected: jest.fn(),
      onToolExecutionStarted: jest.fn(),
      onToolExecutionCompleted: jest.fn(),
      onMessageIdUpdated: jest.fn(),
      onGenerationAborted: jest.fn(),
      onUsageAvailable: jest.fn()
    };

    const manager = new MessageManager(
      mockChatService as unknown as ChatService,
      createMockBranchManager() as unknown as BranchManager,
      events
    );

    await manager.sendMessage(conversation, 'Explain the bug');

    expect(events.onError).toHaveBeenCalledWith(
      'Claude Code could not start because the local CLI command was too long for this platform.'
    );
  });

  // ==========================================================================
  // Non-abort error wiring (issue #271, claim b)
  // Verifies the REAL catch-branch seam in MessageManager fires
  // finalizeErroredPlaceholder, so a non-abort error before the first token
  // leaves the placeholder cleared (isLoading:false, state:'invalid') rather
  // than spinning forever. finalizeErroredPlaceholder is unit-tested in
  // isolation in AbortHandler.test.ts; these tests cover the WIRING.
  // ==========================================================================

  function createGenerationEvents() {
    return {
      onMessageAdded: jest.fn(),
      onAIMessageStarted: jest.fn(),
      onStreamingUpdate: jest.fn(),
      onConversationUpdated: jest.fn(),
      onLoadingStateChanged: jest.fn(),
      onError: jest.fn(),
      onToolCallsDetected: jest.fn(),
      onToolExecutionStarted: jest.fn(),
      onToolExecutionCompleted: jest.fn(),
      onMessageIdUpdated: jest.fn(),
      onGenerationAborted: jest.fn(),
      onUsageAvailable: jest.fn()
    };
  }

  it('clears the placeholder spinner on a non-abort send error before the first token', async () => {
    const conversation = createConversation({ messages: [] });
    const mockChatService = createMockChatService({ conversation });

    mockChatService.getConversation.mockImplementation(async () => conversation);
    mockChatService.generateResponseStreaming.mockImplementation(() => {
      async function* stream() {
        // Non-abort error before any chunk is yielded.
        throw new LLMProviderError('Gemini CLI stopped responding.', 'google-gemini-cli', 'PROVIDER_TIMEOUT');
        yield undefined;
      }
      return stream();
    });

    const events = createGenerationEvents();
    const manager = new MessageManager(
      mockChatService as unknown as ChatService,
      createMockBranchManager() as unknown as BranchManager,
      events
    );

    await manager.sendMessage(conversation, 'Explain the bug');

    // index 0 = user message, index 1 = assistant placeholder
    const placeholder = conversation.messages.find(m => m.role === 'assistant');
    expect(placeholder).toBeDefined();
    expect(placeholder?.isLoading).toBe(false);
    expect(placeholder?.state).toBe('invalid');
    expect(events.onError).toHaveBeenCalledWith('Gemini CLI stopped responding.');
    expect(manager.getIsLoading()).toBe(false);
  });

  it('preserves partial content when a non-abort send error happens mid-stream', async () => {
    const conversation = createConversation({ messages: [] });
    const mockChatService = createMockChatService({ conversation });

    mockChatService.getConversation.mockImplementation(async () => conversation);
    mockChatService.generateResponseStreaming.mockImplementation(
      (_conversationId: string, _userMessage: string, options?: { messageId?: string }) => {
        async function* stream() {
          yield { chunk: 'Partial answer', complete: false, messageId: options?.messageId || 'msg_ai' };
          // Error after a token streamed: the first-token path already cleared
          // isLoading; finalizeErroredPlaceholder is then a no-op, so partial
          // content must survive.
          throw new LLMProviderError('Network dropped.', 'google-gemini-cli', 'PROVIDER_ERROR');
        }
        return stream();
      }
    );

    const events = createGenerationEvents();
    const manager = new MessageManager(
      mockChatService as unknown as ChatService,
      createMockBranchManager() as unknown as BranchManager,
      events
    );

    await manager.sendMessage(conversation, 'Explain the bug');

    const placeholder = conversation.messages.find(m => m.role === 'assistant');
    expect(placeholder?.content).toBe('Partial answer');
    expect(placeholder?.isLoading).toBe(false);
    expect(events.onError).toHaveBeenCalledWith('Network dropped.');
    expect(manager.getIsLoading()).toBe(false);
  });

  it('clears the placeholder spinner on a non-abort error in the regenerate path', async () => {
    // A lone user message with no following assistant message routes
    // handleRetryMessage -> regenerateAIResponse -> generateFreshAIResponse,
    // exercising the SECOND new call site (the regenerate-internal catch).
    const conversation = createConversation({
      messages: [
        {
          id: 'msg_user',
          role: 'user',
          content: 'Retry me',
          timestamp: Date.now(),
          conversationId: 'conv_1',
          state: 'complete'
        }
      ]
    });
    const mockChatService = createMockChatService({ conversation });

    mockChatService.getConversation.mockImplementation(async () => conversation);
    mockChatService.generateResponseStreaming.mockImplementation(() => {
      async function* stream() {
        throw new LLMProviderError('Regen failed.', 'google-gemini-cli', 'PROVIDER_TIMEOUT');
        yield undefined;
      }
      return stream();
    });

    const events = createGenerationEvents();
    const manager = new MessageManager(
      mockChatService as unknown as ChatService,
      createMockBranchManager() as unknown as BranchManager,
      events
    );

    await manager.handleRetryMessage(conversation, 'msg_user');

    const placeholder = conversation.messages.find(m => m.role === 'assistant');
    expect(placeholder).toBeDefined();
    expect(placeholder?.isLoading).toBe(false);
    expect(placeholder?.state).toBe('invalid');
    expect(manager.getIsLoading()).toBe(false);
  });

  it('second sendMessage waits for first to complete when interrupted', async () => {
    const conversation = createConversation({ messages: [] });
    const mockChatService = createMockChatService({ conversation });
    const callOrder: string[] = [];
    const firstChunkSeen = createDeferred<void>();

    mockChatService.getConversation.mockImplementation(async () => conversation);
    mockChatService.generateResponseStreaming.mockImplementation(
      (_conversationId: string, userMessage: string, options?: { messageId?: string; abortSignal?: AbortSignal }) => {
        async function* stream() {
          if (userMessage === 'first') {
            callOrder.push('first-start');
            yield { chunk: 'Partial', complete: false, messageId: options?.messageId || 'msg_1' };
            firstChunkSeen.resolve();

            while (!options?.abortSignal?.aborted) {
              await new Promise(resolve => setTimeout(resolve, 0));
            }
            callOrder.push('first-aborted');
            throw Object.assign(new Error('Generation aborted by user'), { name: 'AbortError' });
          }

          callOrder.push('second-start');
          yield { chunk: 'Complete', complete: false, messageId: options?.messageId || 'msg_2' };
          yield { chunk: '', complete: true, messageId: options?.messageId || 'msg_2' };
          callOrder.push('second-done');
        }
        return stream();
      }
    );

    const events = {
      onMessageAdded: jest.fn(),
      onAIMessageStarted: jest.fn(),
      onStreamingUpdate: jest.fn(),
      onConversationUpdated: jest.fn(),
      onLoadingStateChanged: jest.fn(),
      onError: jest.fn(),
      onToolCallsDetected: jest.fn(),
      onToolExecutionStarted: jest.fn(),
      onToolExecutionCompleted: jest.fn(),
      onMessageIdUpdated: jest.fn(),
      onGenerationAborted: jest.fn(),
      onUsageAvailable: jest.fn()
    };

    const manager = new MessageManager(
      mockChatService as unknown as ChatService,
      createMockBranchManager() as unknown as BranchManager,
      events
    );

    const firstSend = manager.sendMessage(conversation, 'first');
    await firstChunkSeen.promise;

    // Interrupt first, then send second
    await manager.interruptCurrentGeneration();
    await firstSend;
    await manager.sendMessage(conversation, 'second');

    // First generation should have started and been aborted before second started
    expect(callOrder.indexOf('first-start')).toBeLessThan(callOrder.indexOf('first-aborted'));
    expect(callOrder.indexOf('first-aborted')).toBeLessThan(callOrder.indexOf('second-start'));
  });
});
