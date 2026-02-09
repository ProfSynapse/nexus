/**
 * Conversation Indexer
 *
 * Location: src/services/embeddings/ConversationIndexer.ts
 * Purpose: Backfill embeddings for existing conversations. Processes conversations
 *          newest-first for immediate value from recent chats. Supports
 *          resume-on-interrupt via the embedding_backfill_state table.
 * Used by: IndexingQueue delegates conversation backfill here.
 *
 * Relationships:
 *   - Uses EmbeddingService for embedding conversation QA pairs
 *   - Uses QAPairBuilder for converting messages into QA pairs
 *   - Uses SQLiteCacheManager for database queries and progress persistence
 */

import { EmbeddingService } from './EmbeddingService';
import { buildQAPairs } from './QAPairBuilder';
import type { MessageData } from '../../types/storage/HybridStorageTypes';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';

/**
 * Row shape for the embedding_backfill_state table.
 * Tracks progress of conversation backfill for resume-on-interrupt support.
 */
interface BackfillStateRow {
  id: string;
  lastProcessedConversationId: string | null;
  totalConversations: number;
  processedConversations: number;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  errorMessage: string | null;
}

/** Primary key used in the embedding_backfill_state table */
const CONVERSATION_BACKFILL_ID = 'conversation_backfill';

/**
 * Progress callback signature emitted by the indexer to the owning queue.
 */
export interface ConversationIndexerProgress {
  totalConversations: number;
  processedConversations: number;
}

/**
 * Handles backfill indexing for existing conversations.
 *
 * Branch conversations (those with parentConversationId in metadata) are
 * skipped since they are variants of their parent conversation.
 *
 * Individual QA pair embedding is idempotent via contentHash checks in
 * EmbeddingService, making it safe to re-process partially completed
 * conversations.
 */
export class ConversationIndexer {
  private db: SQLiteCacheManager;
  private embeddingService: EmbeddingService;
  private onProgress: (progress: ConversationIndexerProgress) => void;
  private saveInterval: number;

  private isRunning = false;
  private abortSignal: AbortSignal | null = null;

  constructor(
    db: SQLiteCacheManager,
    embeddingService: EmbeddingService,
    onProgress: (progress: ConversationIndexerProgress) => void,
    saveInterval: number = 10
  ) {
    this.db = db;
    this.embeddingService = embeddingService;
    this.onProgress = onProgress;
    this.saveInterval = saveInterval;
  }

  /**
   * Whether a conversation backfill is currently running.
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Start (or resume) conversation backfill.
   *
   * @param abortSignal - Signal from the parent queue for cancellation
   * @param yieldInterval - Yield to main thread every N conversations
   * @returns Total and processed counts when finished
   */
  async start(
    abortSignal: AbortSignal | null,
    yieldInterval: number = 5
  ): Promise<{ total: number; processed: number }> {
    console.log('[DEBUG] ConversationIndexer.start() entered: isRunning =', this.isRunning, ', isServiceEnabled =', this.embeddingService.isServiceEnabled());
    if (this.isRunning) {
      console.log('[DEBUG] ConversationIndexer.start() early return: already running');
      return { total: 0, processed: 0 };
    }

    if (!this.embeddingService.isServiceEnabled()) {
      console.log('[DEBUG] ConversationIndexer.start() early return: service not enabled');
      return { total: 0, processed: 0 };
    }

    this.abortSignal = abortSignal;

    try {
      // Check existing backfill state for resume support
      const existingState = await this.db.queryOne<BackfillStateRow>(
        'SELECT * FROM embedding_backfill_state WHERE id = ?',
        [CONVERSATION_BACKFILL_ID]
      );
      console.log('[DEBUG] ConversationIndexer.start(): existingState =', existingState ? JSON.stringify(existingState) : 'null');

      // If already completed, nothing to do
      if (existingState && existingState.status === 'completed') {
        console.log('[DEBUG] ConversationIndexer.start(): backfill already completed, returning early');
        return { total: 0, processed: 0 };
      }

      // Get all non-branch conversations, newest first
      const allConversations = await this.db.query<{
        id: string;
        metadataJson: string | null;
        workspaceId: string | null;
        sessionId: string | null;
      }>(
        'SELECT id, metadataJson, workspaceId, sessionId FROM conversations ORDER BY created DESC'
      );
      console.log('[DEBUG] ConversationIndexer.start(): allConversations count =', allConversations.length);

      // Filter out branch conversations (those with parentConversationId)
      const nonBranchConversations = allConversations.filter(conv => {
        if (!conv.metadataJson) return true;
        try {
          const metadata = JSON.parse(conv.metadataJson) as Record<string, unknown>;
          return !metadata.parentConversationId;
        } catch {
          return true;
        }
      });
      console.log('[DEBUG] ConversationIndexer.start(): nonBranchConversations count =', nonBranchConversations.length);

      if (nonBranchConversations.length === 0) {
        await this.updateBackfillState({
          status: 'completed',
          totalConversations: 0,
          processedConversations: 0,
          lastProcessedConversationId: null,
        });
        return { total: 0, processed: 0 };
      }

      // Determine resume point if we were interrupted mid-backfill
      let startIndex = 0;
      let processedSoFar = 0;

      if (existingState && existingState.lastProcessedConversationId) {
        const resumeIndex = nonBranchConversations.findIndex(
          c => c.id === existingState.lastProcessedConversationId
        );
        if (resumeIndex >= 0) {
          startIndex = resumeIndex + 1;
          processedSoFar = existingState.processedConversations;
        }
      }

      const totalCount = nonBranchConversations.length;

      // Nothing remaining to process
      if (startIndex >= totalCount) {
        await this.updateBackfillState({
          status: 'completed',
          totalConversations: totalCount,
          processedConversations: totalCount,
          lastProcessedConversationId: existingState?.lastProcessedConversationId ?? null,
        });
        return { total: totalCount, processed: totalCount };
      }

      // Mark as running
      this.isRunning = true;
      let lastProcessedId = existingState?.lastProcessedConversationId ?? null;

      await this.updateBackfillState({
        status: 'running',
        totalConversations: totalCount,
        processedConversations: processedSoFar,
        lastProcessedConversationId: lastProcessedId,
      });

      this.onProgress({ totalConversations: totalCount, processedConversations: processedSoFar });

      console.log('[DEBUG] ConversationIndexer.start(): processing from startIndex =', startIndex, ', totalCount =', totalCount, ', processedSoFar =', processedSoFar);

      // Process each conversation from the resume point
      for (let i = startIndex; i < totalCount; i++) {
        if (this.abortSignal?.aborted) {
          console.log('[DEBUG] ConversationIndexer.start(): abort signal received at index', i);
          break;
        }

        const conv = nonBranchConversations[i];
        console.log('[DEBUG] ConversationIndexer.start(): processing conversation', conv.id, '(', (i + 1), '/', totalCount, ')');

        try {
          await this.backfillConversation(
            conv.id,
            conv.workspaceId ?? undefined,
            conv.sessionId ?? undefined
          );
        } catch (error) {
          console.error(
            `[ConversationIndexer] Failed to backfill conversation ${conv.id}:`,
            error
          );
        }

        processedSoFar++;
        lastProcessedId = conv.id;

        this.onProgress({ totalConversations: totalCount, processedConversations: processedSoFar });

        // Persist progress periodically
        if (processedSoFar % this.saveInterval === 0) {
          await this.updateBackfillState({
            status: 'running',
            totalConversations: totalCount,
            processedConversations: processedSoFar,
            lastProcessedConversationId: lastProcessedId,
          });
          await this.db.save();
        }

        // Yield to main thread periodically
        if (i > startIndex && (i - startIndex) % yieldInterval === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }

      // Final state update
      await this.updateBackfillState({
        status: 'completed',
        totalConversations: totalCount,
        processedConversations: processedSoFar,
        lastProcessedConversationId: lastProcessedId,
      });
      await this.db.save();

      console.log('[DEBUG] ConversationIndexer.start(): completed. total =', totalCount, ', processed =', processedSoFar);
      return { total: totalCount, processed: processedSoFar };

    } catch (error: unknown) {
      console.error('[ConversationIndexer] Conversation backfill failed:', error);
      console.log('[DEBUG] ConversationIndexer.start(): caught error:', error);
      await this.updateBackfillState({
        status: 'error',
        totalConversations: 0,
        processedConversations: 0,
        lastProcessedConversationId: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return { total: 0, processed: 0 };
    } finally {
      console.log('[DEBUG] ConversationIndexer.start() finally block: setting isRunning = false');
      this.isRunning = false;
    }
  }

  /**
   * Backfill a single conversation by fetching its messages, building QA pairs,
   * and embedding each pair. The EmbeddingService.embedConversationTurn method
   * is idempotent (checks contentHash), so re-processing a conversation that
   * was partially embedded is safe.
   */
  private async backfillConversation(
    conversationId: string,
    workspaceId?: string,
    sessionId?: string
  ): Promise<void> {
    const messageRows = await this.db.query<{
      id: string;
      conversationId: string;
      role: string;
      content: string | null;
      timestamp: number;
      state: string | null;
      toolCallsJson: string | null;
      toolCallId: string | null;
      sequenceNumber: number;
      reasoningContent: string | null;
      alternativesJson: string | null;
      activeAlternativeIndex: number;
    }>(
      `SELECT id, conversationId, role, content, timestamp, state,
              toolCallsJson, toolCallId, sequenceNumber, reasoningContent,
              alternativesJson, activeAlternativeIndex
       FROM messages
       WHERE conversationId = ?
       ORDER BY sequenceNumber ASC`,
      [conversationId]
    );

    if (messageRows.length === 0) {
      return;
    }

    const messages: MessageData[] = messageRows.map(row => ({
      id: row.id,
      conversationId: row.conversationId,
      role: row.role as MessageData['role'],
      content: row.content ?? null,
      timestamp: row.timestamp,
      state: (row.state ?? 'complete') as MessageData['state'],
      sequenceNumber: row.sequenceNumber,
      toolCalls: row.toolCallsJson ? JSON.parse(row.toolCallsJson) : undefined,
      toolCallId: row.toolCallId ?? undefined,
      reasoning: row.reasoningContent ?? undefined,
      alternatives: row.alternativesJson ? JSON.parse(row.alternativesJson) : undefined,
      activeAlternativeIndex: row.activeAlternativeIndex ?? 0,
    }));

    const qaPairs = buildQAPairs(messages, conversationId, workspaceId, sessionId);

    for (const qaPair of qaPairs) {
      await this.embeddingService.embedConversationTurn(qaPair);
    }
  }

  /**
   * Insert or update the backfill progress state in the database.
   * Uses INSERT for the first write and UPDATE for subsequent writes so that
   * startedAt is preserved across progress updates.
   */
  private async updateBackfillState(state: {
    status: string;
    totalConversations: number;
    processedConversations: number;
    lastProcessedConversationId: string | null;
    errorMessage?: string;
  }): Promise<void> {
    const now = Date.now();

    const existing = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM embedding_backfill_state WHERE id = ?',
      [CONVERSATION_BACKFILL_ID]
    );

    if (existing) {
      const completedAt = state.status === 'completed' ? now : null;
      await this.db.run(
        `UPDATE embedding_backfill_state
         SET lastProcessedConversationId = ?,
             totalConversations = ?,
             processedConversations = ?,
             status = ?,
             completedAt = ?,
             errorMessage = ?
         WHERE id = ?`,
        [
          state.lastProcessedConversationId,
          state.totalConversations,
          state.processedConversations,
          state.status,
          completedAt,
          state.errorMessage ?? null,
          CONVERSATION_BACKFILL_ID,
        ]
      );
    } else {
      await this.db.run(
        `INSERT INTO embedding_backfill_state
          (id, lastProcessedConversationId, totalConversations, processedConversations,
           status, startedAt, completedAt, errorMessage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          CONVERSATION_BACKFILL_ID,
          state.lastProcessedConversationId,
          state.totalConversations,
          state.processedConversations,
          state.status,
          now,
          state.status === 'completed' ? now : null,
          state.errorMessage ?? null,
        ]
      );
    }
  }
}
