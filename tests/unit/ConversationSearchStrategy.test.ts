/**
 * ConversationSearchStrategy Unit Tests
 *
 * Tests the strategy class that delegates semantic vector search to
 * EmbeddingService and optionally enriches results with windowed messages.
 *
 * Two modes:
 * - Discovery mode (no sessionId): Returns raw search results
 * - Scoped mode (with sessionId): Adds N-turn message windows around each match
 */

import { ConversationSearchStrategy, ConversationSearchDeps } from '../../src/agents/searchManager/services/ConversationSearchStrategy';
import type { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';
import type { ConversationSearchResult } from '../../src/services/embeddings/ConversationEmbeddingService';
import type { IMessageRepository } from '../../src/database/repositories/interfaces/IMessageRepository';
import type { MemorySearchExecutionOptions, MemoryProcessorConfiguration } from '../../src/types/memory/MemorySearchTypes';
import { SearchMethod } from '../../src/types/memory/MemorySearchTypes';

// ============================================================================
// Mock Factory
// ============================================================================

function createMockDeps() {
  const mockEmbeddingService = {
    semanticConversationSearch: jest.fn().mockResolvedValue([]),
  };

  const mockMessageRepository = {
    getMessagesBySequenceRange: jest.fn().mockResolvedValue([]),
  };

  const deps: ConversationSearchDeps = {
    getEmbeddingService: jest.fn().mockReturnValue(mockEmbeddingService as unknown as EmbeddingService),
    getMessageRepository: jest.fn().mockReturnValue(mockMessageRepository as unknown as IMessageRepository),
  };

  return { deps, mockEmbeddingService, mockMessageRepository };
}

function createDefaultConfiguration(): MemoryProcessorConfiguration {
  return {
    defaultLimit: 20,
    maxLimit: 100,
    defaultSearchMethod: SearchMethod.MIXED,
    enableSemanticSearch: true,
    enableExactSearch: true,
    timeoutMs: 30000,
  };
}

function createSearchResult(overrides: Partial<ConversationSearchResult> = {}): ConversationSearchResult {
  return {
    conversationId: 'conv-1',
    conversationTitle: 'Test Conversation',
    pairId: 'conv-1:0',
    matchedSequenceRange: [0, 1] as [number, number],
    question: 'What is the API?',
    answer: 'The API provides methods for vault operations.',
    matchedSide: 'question',
    distance: 0.3,
    score: 0.25,
    pairType: 'conversation_turn',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ConversationSearchStrategy', () => {
  let strategy: ConversationSearchStrategy;
  let mocks: ReturnType<typeof createMockDeps>;
  let configuration: MemoryProcessorConfiguration;

  beforeEach(() => {
    mocks = createMockDeps();
    strategy = new ConversationSearchStrategy(mocks.deps);
    configuration = createDefaultConfiguration();
  });

  // ==========================================================================
  // Returns empty when EmbeddingService is unavailable
  // ==========================================================================

  describe('when EmbeddingService is unavailable', () => {
    it('should return empty array when getEmbeddingService returns undefined', async () => {
      (mocks.deps.getEmbeddingService as jest.Mock).mockReturnValue(undefined);

      const results = await strategy.search('vault API', {}, configuration);

      expect(results).toEqual([]);
      expect(mocks.mockEmbeddingService.semanticConversationSearch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Discovery Mode (no sessionId)
  // ==========================================================================

  describe('discovery mode (no sessionId)', () => {
    it('should delegate search to EmbeddingService.semanticConversationSearch', async () => {
      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([
        createSearchResult(),
      ]);

      const options: MemorySearchExecutionOptions = { workspaceId: 'ws-1' };
      const results = await strategy.search('vault API', options, configuration);

      expect(mocks.mockEmbeddingService.semanticConversationSearch).toHaveBeenCalledWith(
        'vault API', 'ws-1', undefined, 20
      );
      expect(results).toHaveLength(1);
    });

    it('should use GLOBAL_WORKSPACE_ID when workspaceId is not provided', async () => {
      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([]);

      await strategy.search('query', {}, configuration);

      expect(mocks.mockEmbeddingService.semanticConversationSearch).toHaveBeenCalledWith(
        'query', 'default', undefined, 20
      );
    });

    it('should respect the limit from options', async () => {
      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([]);

      await strategy.search('query', { limit: 5 }, configuration);

      expect(mocks.mockEmbeddingService.semanticConversationSearch).toHaveBeenCalledWith(
        'query', 'default', undefined, 5
      );
    });

    it('should fall back to configuration.defaultLimit when no limit in options', async () => {
      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([]);
      configuration.defaultLimit = 15;

      await strategy.search('query', {}, configuration);

      expect(mocks.mockEmbeddingService.semanticConversationSearch).toHaveBeenCalledWith(
        'query', 'default', undefined, 15
      );
    });

    it('should convert ConversationSearchResult to RawMemoryResult format', async () => {
      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([
        createSearchResult({
          conversationId: 'conv-1',
          pairId: 'conv-1:0',
          question: 'Q1',
          answer: 'A1',
          matchedSide: 'question',
          score: 0.3,
          pairType: 'conversation_turn',
        }),
      ]);

      const results = await strategy.search('query', { workspaceId: 'ws-1' }, configuration);

      expect(results[0]).toEqual({
        trace: expect.objectContaining({
          id: 'conv-1:0',
          type: 'conversation',
          conversationId: 'conv-1',
          question: 'Q1',
          answer: 'A1',
          matchedSide: 'question',
          pairType: 'conversation_turn',
          content: 'Q1', // matchedSide=question so content=question text
        }),
        similarity: expect.closeTo(0.7, 2), // 1 - 0.3
      });
    });

    it('should use answer text as content when matchedSide is answer', async () => {
      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([
        createSearchResult({ matchedSide: 'answer', question: 'Q', answer: 'A-text' }),
      ]);

      const results = await strategy.search('query', {}, configuration);

      expect(results[0].trace.content).toBe('A-text');
    });

    it('should not attach windowMessages in discovery mode', async () => {
      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([
        createSearchResult(),
      ]);

      const results = await strategy.search('query', { workspaceId: 'ws-1' }, configuration);

      expect(results[0].trace.windowMessages).toBeUndefined();
    });
  });

  // ==========================================================================
  // Scoped Mode (with sessionId)
  // ==========================================================================

  describe('scoped mode (with sessionId)', () => {
    it('should populate windowMessages when sessionId is provided', async () => {
      const windowMessages = [
        { id: 'msg-1', role: 'user', content: 'Previous Q' },
        { id: 'msg-2', role: 'assistant', content: 'Previous A' },
        { id: 'msg-3', role: 'user', content: 'Matched Q' },
        { id: 'msg-4', role: 'assistant', content: 'Matched A' },
      ];

      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([
        createSearchResult({ conversationId: 'conv-1', matchedSequenceRange: [2, 3] }),
      ]);

      // ConversationWindowRetriever.getWindow is called internally
      mocks.mockMessageRepository.getMessagesBySequenceRange.mockResolvedValue(windowMessages);

      const options: MemorySearchExecutionOptions = {
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
      };

      const results = await strategy.search('query', options, configuration);

      // windowMessages should be populated on the result
      expect(results[0].trace.windowMessages).toBeDefined();
    });

    it('should pass sessionId to semanticConversationSearch', async () => {
      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([]);

      await strategy.search('query', {
        workspaceId: 'ws-1',
        sessionId: 'sess-target',
      }, configuration);

      expect(mocks.mockEmbeddingService.semanticConversationSearch).toHaveBeenCalledWith(
        'query', 'ws-1', 'sess-target', 20
      );
    });

    it('should use default windowSize of 3 when not specified', async () => {
      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([
        createSearchResult({ matchedSequenceRange: [4, 5] }),
      ]);
      mocks.mockMessageRepository.getMessagesBySequenceRange.mockResolvedValue([]);

      await strategy.search('query', {
        sessionId: 'sess-1',
      }, configuration);

      // ConversationWindowRetriever calls getMessagesBySequenceRange
      // with expanded sequence range based on windowSize
      expect(mocks.mockMessageRepository.getMessagesBySequenceRange).toHaveBeenCalled();
    });

    it('should handle window retrieval errors gracefully (leave windowMessages undefined)', async () => {
      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([
        createSearchResult(),
      ]);
      mocks.mockMessageRepository.getMessagesBySequenceRange.mockRejectedValue(
        new Error('DB error')
      );

      const results = await strategy.search('query', {
        sessionId: 'sess-1',
      }, configuration);

      // Should still return results, just without windowMessages
      expect(results).toHaveLength(1);
      expect(results[0].trace.windowMessages).toBeUndefined();
    });

    it('should skip window retrieval when getMessageRepository returns undefined', async () => {
      (mocks.deps.getMessageRepository as jest.Mock).mockReturnValue(undefined);

      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([
        createSearchResult(),
      ]);

      const results = await strategy.search('query', {
        sessionId: 'sess-1',
      }, configuration);

      expect(results).toHaveLength(1);
      expect(results[0].trace.windowMessages).toBeUndefined();
    });
  });

  // ==========================================================================
  // Empty Results
  // ==========================================================================

  describe('empty results', () => {
    it('should return empty array when semanticConversationSearch returns empty', async () => {
      mocks.mockEmbeddingService.semanticConversationSearch.mockResolvedValue([]);

      const results = await strategy.search('query', {}, configuration);

      expect(results).toEqual([]);
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  describe('error handling', () => {
    it('should return empty array when semanticConversationSearch throws', async () => {
      mocks.mockEmbeddingService.semanticConversationSearch.mockRejectedValue(
        new Error('Search failed')
      );

      const results = await strategy.search('query', {}, configuration);

      expect(results).toEqual([]);
      expect(console.error).toHaveBeenCalled();
    });
  });
});
