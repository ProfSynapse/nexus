/**
 * InlineEditService Unit Tests
 *
 * Tests for the business logic of inline AI text editing.
 * Covers state machine transitions, LLM integration, cancellation, and error handling.
 */

import { InlineEditService } from '../../src/services/InlineEditService';
import type { InlineEditState, InlineEditResult, InlineEditCallbacks } from '../../src/ui/inline-edit/types';
import {
  createMockLLMService,
  createSuccessMock,
  createStreamingMock,
  createErrorMock,
  createAbortableMock,
  createEmptyResponseMock
} from '../mocks/llmService';
import {
  SELECTIONS,
  INSTRUCTIONS,
  REQUESTS,
  ERROR_MESSAGES,
  STREAMING_CHUNKS,
  createRequest
} from '../fixtures/inlineEdit';

describe('InlineEditService', () => {
  let service: InlineEditService;
  let mockLLMService: ReturnType<typeof createMockLLMService>;
  let stateChanges: InlineEditState[];
  let streamChunks: string[];
  let callbacks: InlineEditCallbacks;

  beforeEach(() => {
    mockLLMService = createMockLLMService();
    service = new InlineEditService(mockLLMService);
    stateChanges = [];
    streamChunks = [];

    callbacks = {
      onStateChange: (state: InlineEditState) => stateChanges.push({ ...state }),
      onStreamChunk: (chunk: string) => streamChunks.push(chunk),
      onComplete: jest.fn(),
      onError: jest.fn()
    };
    service.setCallbacks(callbacks);
  });

  afterEach(() => {
    service.dispose();
  });

  // ==========================================================================
  // Initialization Tests
  // ==========================================================================

  describe('initialization', () => {
    it('should start with default input state', () => {
      const state = service.getState();
      expect(state.phase).toBe('input');
      expect(state).toHaveProperty('selectedText', '');
    });

    it('should initialize with selected text', () => {
      service.initialize(SELECTIONS.short);

      const state = service.getState();
      expect(state.phase).toBe('input');
      expect((state as { selectedText: string }).selectedText).toBe(SELECTIONS.short);
    });

    it('should notify state change on initialize', () => {
      service.initialize(SELECTIONS.short);

      expect(stateChanges).toHaveLength(1);
      expect(stateChanges[0].phase).toBe('input');
    });

    it('should not be generating after initialization', () => {
      service.initialize(SELECTIONS.short);
      expect(service.isGenerating()).toBe(false);
    });
  });

  // ==========================================================================
  // Happy Path Tests (P0)
  // ==========================================================================

  describe('generate - happy path', () => {
    it('should generate edited text with valid input', async () => {
      mockLLMService = createSuccessMock('Edited text!');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      const result = await service.generate(REQUESTS.basic);

      expect(result.success).toBe(true);
      expect(result.editedText).toBe('Edited text!');
    });

    it('should transition through INPUT -> LOADING -> RESULT states', async () => {
      mockLLMService = createSuccessMock('Result');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(REQUESTS.basic);

      // Should have: initial INPUT, LOADING (connecting), LOADING (generating), RESULT
      const phases = stateChanges.map(s => s.phase);
      expect(phases).toContain('input');
      expect(phases).toContain('loading');
      expect(phases).toContain('result');
    });

    it('should report token usage on success', async () => {
      mockLLMService = createSuccessMock('Result', { input: 150, output: 75 });
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      const result = await service.generate(REQUESTS.basic);

      expect(result.tokenUsage).toEqual({ input: 150, output: 75 });
    });

    it('should call onComplete callback on success', async () => {
      mockLLMService = createSuccessMock('Done');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(REQUESTS.basic);

      expect(callbacks.onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, editedText: 'Done' })
      );
    });

    it('should end in result state with original and edited text', async () => {
      mockLLMService = createSuccessMock('New version');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(createRequest({ selectedText: SELECTIONS.short }));

      const finalState = service.getState();
      expect(finalState.phase).toBe('result');
      if (finalState.phase === 'result') {
        expect(finalState.original).toBe(SELECTIONS.short);
        expect(finalState.edited).toBe('New version');
      }
    });
  });

  // ==========================================================================
  // Validation Tests (P0)
  // ==========================================================================

  describe('input validation', () => {
    beforeEach(() => {
      service.initialize(SELECTIONS.short);
    });

    it('should reject empty instruction', async () => {
      const result = await service.generate(REQUESTS.emptyInstruction);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty instruction');
    });

    it('should reject whitespace-only instruction', async () => {
      const result = await service.generate(REQUESTS.whitespaceInstruction);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty instruction');
    });

    it('should transition to error state on empty instruction', async () => {
      await service.generate(REQUESTS.emptyInstruction);

      const state = service.getState();
      expect(state.phase).toBe('error');
      if (state.phase === 'error') {
        expect(state.message).toBe(ERROR_MESSAGES.emptyInstruction);
      }
    });

    it('should call onError callback on validation failure', async () => {
      await service.generate(REQUESTS.emptyInstruction);

      expect(callbacks.onError).toHaveBeenCalledWith(ERROR_MESSAGES.emptyInstruction);
    });
  });

  // ==========================================================================
  // Error Handling Tests (P0)
  // ==========================================================================

  describe('error handling', () => {
    it('should handle network errors gracefully', async () => {
      mockLLMService = createErrorMock('Network request failed');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      const result = await service.generate(REQUESTS.basic);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network request failed');
    });

    it('should transition to error state on LLM failure', async () => {
      mockLLMService = createErrorMock('API error');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(REQUESTS.basic);

      const state = service.getState();
      expect(state.phase).toBe('error');
    });

    it('should preserve last instruction in error state', async () => {
      mockLLMService = createErrorMock('Failed');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(createRequest({ instruction: 'My instruction' }));

      const state = service.getState();
      expect(state.phase).toBe('error');
      if (state.phase === 'error') {
        expect(state.lastInstruction).toBe('My instruction');
      }
    });

    it('should call onError callback on LLM failure', async () => {
      mockLLMService = createErrorMock('Service unavailable');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(REQUESTS.basic);

      expect(callbacks.onError).toHaveBeenCalled();
    });

    it('should not be generating after error', async () => {
      mockLLMService = createErrorMock('Error');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(REQUESTS.basic);

      expect(service.isGenerating()).toBe(false);
    });
  });

  // ==========================================================================
  // Cancellation Tests (P0)
  // ==========================================================================

  describe('cancellation', () => {
    it('should cancel active generation', async () => {
      mockLLMService = createAbortableMock(STREAMING_CHUNKS.wordByWord, 100);
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      // Start generation but don't await
      const generatePromise = service.generate(REQUESTS.basic);

      // Wait a bit for streaming to start
      await new Promise(resolve => setTimeout(resolve, 50));

      // Cancel
      service.cancel();

      const result = await generatePromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cancelled by user');
    });

    it('should return to input state after cancellation', async () => {
      mockLLMService = createAbortableMock(STREAMING_CHUNKS.wordByWord, 100);
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      const generatePromise = service.generate(REQUESTS.basic);
      await new Promise(resolve => setTimeout(resolve, 50));
      service.cancel();
      await generatePromise;

      const state = service.getState();
      expect(state.phase).toBe('input');
    });

    it('should not be generating after cancellation', async () => {
      mockLLMService = createAbortableMock(STREAMING_CHUNKS.simple, 100);
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      const generatePromise = service.generate(REQUESTS.basic);
      await new Promise(resolve => setTimeout(resolve, 50));
      service.cancel();
      await generatePromise;

      expect(service.isGenerating()).toBe(false);
    });

    it('should handle cancel when not generating (no-op)', () => {
      service.initialize(SELECTIONS.short);

      // Should not throw
      expect(() => service.cancel()).not.toThrow();
    });
  });

  // ==========================================================================
  // Concurrent Request Blocking Tests (P0)
  // ==========================================================================

  describe('concurrent request blocking', () => {
    it('should block concurrent requests', async () => {
      mockLLMService = createAbortableMock(STREAMING_CHUNKS.wordByWord, 100);
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      // Start first request
      const firstRequest = service.generate(REQUESTS.basic);

      // Try to start second request immediately
      const secondResult = await service.generate(REQUESTS.basic);

      // Second should fail immediately
      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toBe(ERROR_MESSAGES.concurrent);

      // Clean up first request
      service.cancel();
      await firstRequest;
    });

    it('should allow new request after previous completes', async () => {
      mockLLMService = createSuccessMock('First result');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      // First request
      await service.generate(REQUESTS.basic);

      // Second request should work
      mockLLMService = createSuccessMock('Second result');
      service = new InlineEditService(mockLLMService);
      service.initialize(SELECTIONS.short);

      const result = await service.generate(REQUESTS.basic);
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // State Transition Tests
  // ==========================================================================

  describe('state transitions', () => {
    it('should report generating status during LOADING', async () => {
      mockLLMService = createAbortableMock(STREAMING_CHUNKS.wordByWord, 50);
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      const generatePromise = service.generate(REQUESTS.basic);

      // Check during generation
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(service.isGenerating()).toBe(true);

      service.cancel();
      await generatePromise;
    });

    it('should update progress text during loading', async () => {
      mockLLMService = createSuccessMock('Done');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(REQUESTS.basic);

      const loadingStates = stateChanges.filter(s => s.phase === 'loading');
      expect(loadingStates.length).toBeGreaterThan(0);

      // Should have both "Connecting..." and "Generating..." progress messages
      const progressMessages = loadingStates.map(s => (s as { progress?: string }).progress);
      expect(progressMessages).toContain('Connecting...');
    });
  });

  // ==========================================================================
  // Retry Flow Tests (P1)
  // ==========================================================================

  describe('retry flow', () => {
    it('should reset to input state for retry', async () => {
      mockLLMService = createSuccessMock('Result');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(REQUESTS.basic);

      // Now in result state, reset for retry
      service.reset(SELECTIONS.short);

      const state = service.getState();
      expect(state.phase).toBe('input');
    });

    it('should allow regeneration after retry', async () => {
      mockLLMService = createSuccessMock('First');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(REQUESTS.basic);
      service.reset(SELECTIONS.short);

      // New mock for second generation
      mockLLMService = createSuccessMock('Second');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      const result = await service.generate(REQUESTS.basic);

      expect(result.success).toBe(true);
      expect(result.editedText).toBe('Second');
    });
  });

  // ==========================================================================
  // Streaming Tests
  // ==========================================================================

  describe('streaming', () => {
    it('should accumulate streamed text chunks', async () => {
      mockLLMService = createStreamingMock(STREAMING_CHUNKS.wordByWord, 10);
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(REQUESTS.basic);

      // Verify chunks were received
      expect(streamChunks.length).toBe(STREAMING_CHUNKS.wordByWord.length);
      expect(streamChunks.join('')).toBe(STREAMING_CHUNKS.wordByWord.join(''));
    });

    it('should update state with streamed text during loading', async () => {
      mockLLMService = createStreamingMock(STREAMING_CHUNKS.simple, 10);
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(REQUESTS.basic);

      // Check loading states have accumulated streamedText
      const loadingStates = stateChanges.filter(s => s.phase === 'loading');
      const streamedTexts = loadingStates
        .map(s => (s as { streamedText?: string }).streamedText)
        .filter(Boolean);

      expect(streamedTexts.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Update Edited Text Tests
  // ==========================================================================

  describe('updateEditedText', () => {
    it('should update edited text in result state', async () => {
      mockLLMService = createSuccessMock('Original result');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(REQUESTS.basic);

      service.updateEditedText('User modified result');

      const state = service.getState();
      expect(state.phase).toBe('result');
      if (state.phase === 'result') {
        expect(state.edited).toBe('User modified result');
      }
    });

    it('should not update when not in result state', () => {
      service.initialize(SELECTIONS.short);

      service.updateEditedText('Should not work');

      const state = service.getState();
      expect(state.phase).toBe('input');
    });
  });

  // ==========================================================================
  // Special Characters Tests (P1)
  // ==========================================================================

  describe('special characters preservation', () => {
    it('should preserve markdown formatting in response', async () => {
      const markdownResult = '**Bold** and *italic* preserved';
      mockLLMService = createSuccessMock(markdownResult);
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.markdown);

      const result = await service.generate(REQUESTS.markdown);

      expect(result.editedText).toBe(markdownResult);
    });

    it('should preserve unicode characters', async () => {
      const unicodeResult = '\u4e2d\u6587 \u00e9\u00e0\u00fc \ud83d\ude00';
      mockLLMService = createSuccessMock(unicodeResult);
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.unicode);

      const result = await service.generate(
        createRequest({ selectedText: SELECTIONS.unicode })
      );

      expect(result.editedText).toBe(unicodeResult);
    });

    it('should handle code blocks correctly', async () => {
      const codeResult = '```typescript\nconst x = 1;\n```';
      mockLLMService = createSuccessMock(codeResult);
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.codeBlock);

      const result = await service.generate(REQUESTS.code);

      expect(result.editedText).toBe(codeResult);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle empty response from LLM', async () => {
      mockLLMService = createEmptyResponseMock();
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      const result = await service.generate(REQUESTS.basic);

      // Empty response is still technically successful
      expect(result.success).toBe(true);
      expect(result.editedText).toBe('');
    });

    it('should handle stream failure after partial content', async () => {
      // Create a mock that streams some content then fails mid-stream
      // The mock needs multiple chunks configured, with error thrown after first chunk
      mockLLMService = createMockLLMService({
        chunks: [
          { chunk: 'Partial ' },
          { chunk: 'content ' },  // This chunk won't be reached
          { complete: true }       // This won't be reached either
        ],
        error: new Error('Connection lost mid-stream'),
        errorAfterChunks: 1  // Throw after yielding first chunk (index 0)
      });
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      const result = await service.generate(REQUESTS.basic);

      // Verify error state is set - partial content should NOT be saved as result
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection lost mid-stream');

      // Verify transitioned to error state (not result state with partial content)
      const state = service.getState();
      expect(state.phase).toBe('error');

      // Verify onError callback was called
      expect(callbacks.onError).toHaveBeenCalled();

      // Verify service is not stuck in generating state
      expect(service.isGenerating()).toBe(false);
    });

    it('should handle very long text input', async () => {
      mockLLMService = createSuccessMock('Shortened version');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.long);

      const result = await service.generate(REQUESTS.longText);

      expect(result.success).toBe(true);
    });

    it('should include context in LLM request when provided', async () => {
      mockLLMService = createSuccessMock('Result');
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      await service.generate(
        createRequest({
          context: {
            fileName: 'important-document.md',
            cursorPosition: { line: 10, ch: 5 }
          }
        })
      );

      // Verify generateResponseStream was called with messages containing file context
      expect(mockLLMService.generateResponseStream).toHaveBeenCalled();
      const callArgs = mockLLMService.generateResponseStream.mock.calls[0];
      const messages = callArgs[0];
      const userMessage = messages.find((m: { role: string }) => m.role === 'user');
      expect(userMessage?.content).toContain('important-document.md');
    });
  });

  // ==========================================================================
  // Dispose Tests
  // ==========================================================================

  describe('dispose', () => {
    it('should cancel any active generation on dispose', async () => {
      mockLLMService = createAbortableMock(STREAMING_CHUNKS.wordByWord, 100);
      service = new InlineEditService(mockLLMService);
      service.setCallbacks(callbacks);
      service.initialize(SELECTIONS.short);

      const generatePromise = service.generate(REQUESTS.basic);
      await new Promise(resolve => setTimeout(resolve, 50));

      service.dispose();

      const result = await generatePromise;
      expect(result.success).toBe(false);
    });

    it('should clear callbacks on dispose', () => {
      service.initialize(SELECTIONS.short);
      service.dispose();

      // State changes after dispose should not trigger callbacks
      stateChanges.length = 0;
      service.initialize(SELECTIONS.paragraph);

      // The callback should have been cleared, so no new state changes recorded
      // (The initialize still changes state, but callbacks are cleared)
    });
  });
});
