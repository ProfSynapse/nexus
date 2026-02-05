/**
 * LLMService Mock
 *
 * Provides a controllable mock of the LLMService for testing
 * InlineEditService without making actual LLM API calls.
 */

import type { LLMService } from '../../src/services/llm/core/LLMService';

export interface MockChunk {
  chunk?: string;
  complete?: boolean;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface MockStreamConfig {
  /** Chunks to yield during streaming */
  chunks: MockChunk[];
  /** Delay between chunks in ms (default: 0) */
  chunkDelay?: number;
  /** Error to throw during streaming (if any) */
  error?: Error;
  /** Whether to throw error immediately or after some chunks */
  errorAfterChunks?: number;
}

/**
 * Creates a mock LLMService for testing
 *
 * @param config - Configuration for the mock behavior
 * @returns A mock LLMService instance
 */
export function createMockLLMService(config?: Partial<MockStreamConfig>): jest.Mocked<LLMService> {
  const defaultConfig: MockStreamConfig = {
    chunks: [
      { chunk: 'Modified text' },
      { complete: true, usage: { promptTokens: 100, completionTokens: 50 } }
    ],
    chunkDelay: 0,
    ...config
  };

  const mockService = {
    generateResponseStream: jest.fn(async function* (
      messages: Array<{ role: string; content: string }>,
      options?: { abortSignal?: AbortSignal }
    ): AsyncGenerator<MockChunk, void, unknown> {
      const { chunks, chunkDelay, error, errorAfterChunks } = defaultConfig;

      for (let i = 0; i < chunks.length; i++) {
        // Check for abort signal before each chunk
        if (options?.abortSignal?.aborted) {
          throw new DOMException('Generation aborted by user', 'AbortError');
        }

        // Throw error after specified number of chunks
        if (error && errorAfterChunks !== undefined && i >= errorAfterChunks) {
          throw error;
        }

        // Simulate delay between chunks
        if (chunkDelay && chunkDelay > 0) {
          await new Promise(resolve => setTimeout(resolve, chunkDelay));
        }

        yield chunks[i];
      }

      // Throw error at the end if no chunk count specified
      if (error && errorAfterChunks === undefined) {
        throw error;
      }
    }),

    getAvailableModels: jest.fn(async () => [
      { id: 'gpt-4', name: 'GPT-4', provider: 'openai' },
      { id: 'claude-3-opus', name: 'Claude 3 Opus', provider: 'anthropic' }
    ]),

    getDefaultModel: jest.fn(() => ({
      provider: 'openai',
      model: 'gpt-4'
    })),

    getAgentModel: jest.fn(() => ({
      provider: 'openai',
      model: 'gpt-4'
    })),

    executePrompt: jest.fn(async () => ({
      success: true,
      response: 'Mock response'
    })),

    testProvider: jest.fn(async () => ({ success: true })),

    getProviderConfig: jest.fn(() => undefined),

    getAllProviderConfigs: jest.fn(() => ({})),

    getAdapter: jest.fn(() => undefined),

    isProviderAvailable: jest.fn(() => true),

    getAvailableProviders: jest.fn(() => ['openai', 'anthropic']),

    waitForInit: jest.fn(async () => {}),

    dispose: jest.fn(),

    updateSettings: jest.fn(),

    setToolExecutor: jest.fn(),

    setVaultOperations: jest.fn()
  };

  return mockService as unknown as jest.Mocked<LLMService>;
}

/**
 * Creates a mock that simulates a successful text transformation
 */
export function createSuccessMock(editedText: string, tokenUsage?: { input: number; output: number }): jest.Mocked<LLMService> {
  return createMockLLMService({
    chunks: [
      { chunk: editedText },
      {
        complete: true,
        usage: {
          promptTokens: tokenUsage?.input ?? 100,
          completionTokens: tokenUsage?.output ?? 50
        }
      }
    ]
  });
}

/**
 * Creates a mock that simulates a streaming response with multiple chunks
 */
export function createStreamingMock(textChunks: string[], delayMs = 10): jest.Mocked<LLMService> {
  const chunks: MockChunk[] = textChunks.map(chunk => ({ chunk }));
  chunks.push({ complete: true, usage: { promptTokens: 100, completionTokens: textChunks.length * 10 } });

  return createMockLLMService({
    chunks,
    chunkDelay: delayMs
  });
}

/**
 * Creates a mock that simulates an error during generation
 */
export function createErrorMock(errorMessage: string, afterChunks?: number): jest.Mocked<LLMService> {
  return createMockLLMService({
    chunks: afterChunks ? [{ chunk: 'Partial text' }] : [],
    error: new Error(errorMessage),
    errorAfterChunks: afterChunks
  });
}

/**
 * Creates a mock that simulates a network timeout
 */
export function createTimeoutMock(timeoutMs: number): jest.Mocked<LLMService> {
  const mockService = createMockLLMService();
  mockService.generateResponseStream = jest.fn(async function* () {
    await new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
    );
  }) as unknown as jest.Mock;
  return mockService;
}

/**
 * Creates a mock that supports abort signal testing
 * The generator will check the abort signal and throw if aborted
 */
export function createAbortableMock(chunks: string[], chunkDelayMs = 50): jest.Mocked<LLMService> {
  const mockChunks: MockChunk[] = chunks.map(chunk => ({ chunk }));
  mockChunks.push({ complete: true, usage: { promptTokens: 100, completionTokens: chunks.length * 10 } });

  return createMockLLMService({
    chunks: mockChunks,
    chunkDelay: chunkDelayMs
  });
}

/**
 * Creates a mock that returns an empty response
 */
export function createEmptyResponseMock(): jest.Mocked<LLMService> {
  return createMockLLMService({
    chunks: [
      { chunk: '' },
      { complete: true, usage: { promptTokens: 100, completionTokens: 0 } }
    ]
  });
}
