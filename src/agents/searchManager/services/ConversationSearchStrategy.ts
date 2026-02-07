/**
 * Conversation Search Strategy
 *
 * Location: src/agents/searchManager/services/ConversationSearchStrategy.ts
 * Purpose: Semantic vector search over conversation QA pair embeddings.
 *          Extracted from MemorySearchProcessor to isolate the conversation
 *          search domain, which depends on EmbeddingService and
 *          ConversationWindowRetriever.
 * Used by: MemorySearchProcessor.executeSearch delegates conversation-type
 *          searches here.
 */

import type { EmbeddingService } from '../../../services/embeddings/EmbeddingService';
import { ConversationWindowRetriever } from '../../../services/embeddings/ConversationWindowRetriever';
import type { IMessageRepository } from '../../../database/repositories/interfaces/IMessageRepository';
import type { RawMemoryResult, MemorySearchExecutionOptions, MemoryProcessorConfiguration } from '../../../types/memory/MemorySearchTypes';
import { GLOBAL_WORKSPACE_ID } from '../../../services/WorkspaceService';

/**
 * Dependency providers that must be supplied by the owning processor.
 * Using a callback pattern avoids tightly coupling to the service accessors.
 */
export interface ConversationSearchDeps {
  getEmbeddingService: () => EmbeddingService | undefined;
  getMessageRepository: () => IMessageRepository | undefined;
}

/**
 * Encapsulates semantic search over conversation QA pair embeddings.
 *
 * Discovery mode (no sessionId): Returns conversation QA pair matches ranked
 * by score.
 *
 * Scoped mode (with sessionId): Additionally retrieves N-turn message windows
 * around each match via ConversationWindowRetriever.
 *
 * Gracefully returns empty results when EmbeddingService is unavailable (e.g.,
 * embeddings disabled or mobile platform).
 */
export class ConversationSearchStrategy {
  private deps: ConversationSearchDeps;

  constructor(deps: ConversationSearchDeps) {
    this.deps = deps;
  }

  /**
   * Execute a semantic search over conversation embeddings.
   *
   * @param query - Natural language query string
   * @param options - Execution options including workspace/session scope and limit
   * @param configuration - Processor configuration for defaults
   * @returns Raw results with similarity scores, ready for enrichment
   */
  async search(
    query: string,
    options: MemorySearchExecutionOptions,
    configuration: MemoryProcessorConfiguration
  ): Promise<RawMemoryResult[]> {
    const embeddingService = this.deps.getEmbeddingService();
    if (!embeddingService) {
      return [];
    }

    const workspaceId = options.workspaceId || GLOBAL_WORKSPACE_ID;
    const limit = options.limit || configuration.defaultLimit;

    try {
      // Semantic search via EmbeddingService (handles reranking internally)
      const conversationResults = await embeddingService.semanticConversationSearch(
        query,
        workspaceId,
        options.sessionId,
        limit
      );

      if (conversationResults.length === 0) {
        return [];
      }

      // Scoped mode: populate windowMessages when sessionId is provided
      if (options.sessionId) {
        const messageRepository = this.deps.getMessageRepository();
        if (messageRepository) {
          const retriever = new ConversationWindowRetriever(messageRepository);
          const windowSize = options.windowSize ?? 3;

          await Promise.all(
            conversationResults.map(async (result) => {
              try {
                const window = await retriever.getWindow(
                  result.conversationId,
                  result.matchedSequenceRange[0],
                  result.matchedSequenceRange[1],
                  { windowSize }
                );
                result.windowMessages = window.messages;
              } catch {
                // Non-fatal: leave windowMessages undefined for this result
              }
            })
          );
        }
      }

      // Convert ConversationSearchResult[] to RawMemoryResult[] for unified processing
      return conversationResults.map((result) => ({
        trace: {
          id: result.pairId,
          type: 'conversation',
          conversationId: result.conversationId,
          conversationTitle: result.conversationTitle,
          sessionId: result.sessionId,
          workspaceId: result.workspaceId,
          question: result.question,
          answer: result.answer,
          matchedSide: result.matchedSide,
          pairType: result.pairType,
          matchedSequenceRange: result.matchedSequenceRange,
          windowMessages: result.windowMessages,
          content: result.matchedSide === 'question' ? result.question : result.answer
        },
        similarity: 1 - result.score // Convert distance-based score (lower=better) to similarity (higher=better)
      }));
    } catch (error) {
      console.error('[ConversationSearchStrategy] Error searching conversation embeddings:', error);
      return [];
    }
  }
}
