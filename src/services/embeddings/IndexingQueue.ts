/**
 * Location: src/services/embeddings/IndexingQueue.ts
 * Purpose: Background initial indexing queue with progress tracking
 *
 * Features:
 * - Processes one note at a time (memory conscious)
 * - Yields to UI between notes (50ms)
 * - Progress events with ETA calculation
 * - Pause/resume/cancel controls
 * - Resumable via content hash comparison
 * - Saves DB every 10 notes
 * - Backfill indexing for existing conversations (resume-on-interrupt)
 *
 * Relationships:
 * - Uses EmbeddingService for embedding notes and conversation turns
 * - Uses QAPairBuilder for converting messages into QA pairs
 * - Uses SQLiteCacheManager for periodic saves and direct conversation queries
 * - Emits progress events for UI updates
 */

import { App, TFile } from 'obsidian';
import { EventEmitter } from 'events';
import { EmbeddingService } from './EmbeddingService';
import { buildQAPairs } from './QAPairBuilder';
import type { MessageData } from '../../types/storage/HybridStorageTypes';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';

export interface IndexingProgress {
  phase: 'idle' | 'loading_model' | 'indexing' | 'complete' | 'paused' | 'error';
  totalNotes: number;
  processedNotes: number;
  currentNote: string | null;
  estimatedTimeRemaining: number | null;  // seconds
  error?: string;
}

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
 * Background indexing queue for notes
 *
 * Processes notes one at a time with UI yielding to keep Obsidian responsive.
 * Emits 'progress' events that can be consumed by UI components.
 */
export class IndexingQueue extends EventEmitter {
  private app: App;
  private embeddingService: EmbeddingService;
  private db: SQLiteCacheManager;

  private queue: string[] = [];
  private isRunning = false;
  private isPaused = false;
  private abortController: AbortController | null = null;

  // Tuning parameters
  private readonly BATCH_SIZE = 1;           // Process one at a time for memory
  private readonly YIELD_INTERVAL_MS = 50;   // Yield to UI between notes
  private readonly SAVE_INTERVAL = 10;       // Save DB every N notes
  private readonly CONVERSATION_YIELD_INTERVAL = 5;  // Yield every N conversations during backfill

  private processedCount = 0;
  private totalCount = 0;
  private startTime = 0;
  private processingTimes: number[] = [];    // Rolling average for ETA

  constructor(
    app: App,
    embeddingService: EmbeddingService,
    db: SQLiteCacheManager
  ) {
    super();
    this.app = app;
    this.embeddingService = embeddingService;
    this.db = db;
  }

  /**
   * Start initial indexing of all notes
   */
  async startFullIndex(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    if (!this.embeddingService.isServiceEnabled()) {
      this.emitProgress({
        phase: 'complete',
        totalNotes: 0,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null
      });
      return;
    }

    const allNotes = this.app.vault.getMarkdownFiles();

    // Filter to notes not already indexed (or with changed content)
    const needsIndexing = await this.filterUnindexedNotes(allNotes);

    if (needsIndexing.length === 0) {
      this.emitProgress({
        phase: 'complete',
        totalNotes: 0,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null
      });
      return;
    }

    this.queue = needsIndexing.map(f => f.path);
    this.totalCount = this.queue.length;
    this.processedCount = 0;
    this.startTime = Date.now();
    this.processingTimes = [];
    this.abortController = new AbortController();

    await this.processQueue();
  }

  /**
   * Filter to only notes that need (re)indexing
   */
  private async filterUnindexedNotes(notes: TFile[]): Promise<TFile[]> {
    const needsIndexing: TFile[] = [];

    for (const note of notes) {
      try {
        const content = await this.app.vault.cachedRead(note);
        const contentHash = this.hashContent(this.preprocessContent(content));

        const existing = await this.db.queryOne<{ contentHash: string }>(
          'SELECT contentHash FROM embedding_metadata WHERE notePath = ?',
          [note.path]
        );

        // Needs indexing if: no embedding OR content changed
        if (!existing || existing.contentHash !== contentHash) {
          needsIndexing.push(note);
        }
      } catch {
        // Include in indexing queue anyway
        needsIndexing.push(note);
      }
    }

    return needsIndexing;
  }

  /**
   * Process the queue with memory-conscious batching
   */
  private async processQueue(): Promise<void> {
    this.isRunning = true;
    this.emitProgress({
      phase: 'loading_model',
      totalNotes: this.totalCount,
      processedNotes: 0,
      currentNote: null,
      estimatedTimeRemaining: null
    });

    try {
      // Load model (one-time, ~50-100MB)
      await this.embeddingService.initialize();

      this.emitProgress({
        phase: 'indexing',
        totalNotes: this.totalCount,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null
      });

      while (this.queue.length > 0) {
        // Check for abort/pause
        if (this.abortController?.signal.aborted) {
          this.emitProgress({
            phase: 'paused',
            totalNotes: this.totalCount,
            processedNotes: this.processedCount,
            currentNote: null,
            estimatedTimeRemaining: null
          });
          break;
        }

        if (this.isPaused) {
          await this.waitForResume();
          continue;
        }

        const notePath = this.queue.shift()!;
        const noteStart = Date.now();

        try {
          this.emitProgress({
            phase: 'indexing',
            totalNotes: this.totalCount,
            processedNotes: this.processedCount,
            currentNote: notePath,
            estimatedTimeRemaining: this.calculateETA()
          });

          // Process single note - memory released after each
          await this.embeddingService.embedNote(notePath);
          this.processedCount++;

          // Track timing for ETA
          const elapsed = Date.now() - noteStart;
          this.processingTimes.push(elapsed);
          if (this.processingTimes.length > 20) {
            this.processingTimes.shift(); // Keep rolling window
          }

          // Periodic DB save (embeddings are already in DB, this ensures WAL flush)
          if (this.processedCount % this.SAVE_INTERVAL === 0) {
            await this.db.save();
          }

        } catch (error) {
          console.error(`[IndexingQueue] Failed to embed ${notePath}:`, error);
          // Continue with next note, don't fail entire queue
        }

        // Yield to UI - critical for responsiveness
        await new Promise(r => setTimeout(r, this.YIELD_INTERVAL_MS));
      }

      // Final save
      await this.db.save();

      this.emitProgress({
        phase: 'complete',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null
      });

    } catch (error: any) {
      console.error('[IndexingQueue] Processing failed:', error);
      this.emitProgress({
        phase: 'error',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null,
        error: error.message
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Calculate estimated time remaining
   */
  private calculateETA(): number | null {
    if (this.processingTimes.length < 3) return null;

    const avgTime = this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length;
    const remaining = this.totalCount - this.processedCount;
    return Math.round((remaining * avgTime) / 1000); // seconds
  }

  /**
   * Pause indexing (can resume later)
   */
  pause(): void {
    if (!this.isRunning) return;

    this.isPaused = true;
    this.emitProgress({
      phase: 'paused',
      totalNotes: this.totalCount,
      processedNotes: this.processedCount,
      currentNote: null,
      estimatedTimeRemaining: null
    });
  }

  /**
   * Resume paused indexing
   */
  resume(): void {
    if (!this.isRunning || !this.isPaused) return;
    this.isPaused = false;
  }

  /**
   * Cancel indexing entirely
   */
  cancel(): void {
    if (!this.isRunning) return;
    this.abortController?.abort();
    this.queue = [];
  }

  /**
   * Clean up all resources (called on plugin unload)
   */
  destroy(): void {
    this.cancel();
    this.removeAllListeners();
  }

  /**
   * Wait for resume signal
   */
  private async waitForResume(): Promise<void> {
    while (this.isPaused && !this.abortController?.signal.aborted) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  /**
   * Emit progress event
   */
  private emitProgress(progress: IndexingProgress): void {
    this.emit('progress', progress);
  }

  /**
   * Preprocess content (same as EmbeddingService)
   */
  private preprocessContent(content: string): string {
    // Strip frontmatter
    let processed = content.replace(/^---[\s\S]*?---\n?/, '');

    // Strip image embeds, keep link text
    processed = processed
      .replace(/!\[\[.*?\]\]/g, '')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1');

    // Normalize whitespace
    processed = processed.replace(/\s+/g, ' ').trim();

    return processed;
  }

  /**
   * Hash content (same as EmbeddingService)
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i);
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  /**
   * Check if indexing is currently running
   */
  isIndexing(): boolean {
    return this.isRunning;
  }

  /**
   * Check if indexing is paused
   */
  isIndexingPaused(): boolean {
    return this.isPaused;
  }

  /**
   * Get current progress
   */
  getProgress(): IndexingProgress {
    if (!this.isRunning) {
      return {
        phase: 'idle',
        totalNotes: 0,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null
      };
    }

    return {
      phase: this.isPaused ? 'paused' : 'indexing',
      totalNotes: this.totalCount,
      processedNotes: this.processedCount,
      currentNote: this.queue.length > 0 ? this.queue[0] : null,
      estimatedTimeRemaining: this.calculateETA()
    };
  }

  // ==================== TRACE INDEXING ====================

  /**
   * Start indexing of all memory traces (backfill existing traces)
   * This is separate from note indexing and processes workspace traces
   */
  async startTraceIndex(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    if (!this.embeddingService.isServiceEnabled()) {
      return;
    }

    // Query all traces from the database
    const allTraces = await this.db.query<{
      id: string;
      workspaceId: string;
      sessionId: string | null;
      content: string;
    }>('SELECT id, workspaceId, sessionId, content FROM memory_traces');

    // Filter to traces not already embedded
    const needsIndexing: typeof allTraces = [];

    for (const trace of allTraces) {
      const existing = await this.db.queryOne<{ traceId: string }>(
        'SELECT traceId FROM trace_embedding_metadata WHERE traceId = ?',
        [trace.id]
      );
      if (!existing) {
        needsIndexing.push(trace);
      }
    }

    if (needsIndexing.length === 0) {
      return;
    }

    this.isRunning = true;
    this.totalCount = needsIndexing.length;
    this.processedCount = 0;
    this.startTime = Date.now();
    this.processingTimes = [];
    this.abortController = new AbortController();

    this.emitProgress({
      phase: 'indexing',
      totalNotes: this.totalCount,
      processedNotes: 0,
      currentNote: 'traces',
      estimatedTimeRemaining: null
    });

    try {
      for (const trace of needsIndexing) {
        if (this.abortController?.signal.aborted) {
          break;
        }

        if (this.isPaused) {
          await this.waitForResume();
          continue;
        }

        try {
          await this.embeddingService.embedTrace(
            trace.id,
            trace.workspaceId,
            trace.sessionId ?? undefined,
            trace.content
          );
          this.processedCount++;

          // Periodic DB save
          if (this.processedCount % this.SAVE_INTERVAL === 0) {
            await this.db.save();
          }

        } catch (error) {
          console.error(`[IndexingQueue] Failed to embed trace ${trace.id}:`, error);
        }

        // Yield to UI
        await new Promise(r => setTimeout(r, this.YIELD_INTERVAL_MS));
      }

      // Final save
      await this.db.save();

    } catch (error: any) {
      console.error('[IndexingQueue] Trace processing failed:', error);
    } finally {
      this.isRunning = false;
      this.emitProgress({
        phase: 'complete',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null
      });
    }
  }

  // ==================== CONVERSATION BACKFILL ====================

  /**
   * Backfill embeddings for all existing conversations.
   *
   * Processes conversations newest-first for immediate value from recent chats.
   * Supports resume-on-interrupt: tracks progress in embedding_backfill_state
   * table and skips already-processed conversations on restart. Individual
   * QA pair embedding is also idempotent via contentHash checks.
   *
   * Branch conversations (those with parentConversationId in metadata) are
   * skipped since they are variants of their parent conversation.
   *
   * Yields to the main thread every CONVERSATION_YIELD_INTERVAL conversations
   * to keep Obsidian responsive during backfill.
   */
  async startConversationIndex(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    if (!this.embeddingService.isServiceEnabled()) {
      return;
    }

    try {
      // Check existing backfill state for resume support
      const existingState = await this.db.queryOne<BackfillStateRow>(
        'SELECT * FROM embedding_backfill_state WHERE id = ?',
        [CONVERSATION_BACKFILL_ID]
      );

      // If already completed, nothing to do
      if (existingState && existingState.status === 'completed') {
        return;
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

      // Filter out branch conversations (those with parentConversationId)
      const nonBranchConversations = allConversations.filter(conv => {
        if (!conv.metadataJson) return true;
        try {
          const metadata = JSON.parse(conv.metadataJson) as Record<string, unknown>;
          return !metadata.parentConversationId;
        } catch {
          return true; // If metadata can't be parsed, include the conversation
        }
      });

      if (nonBranchConversations.length === 0) {
        await this.updateBackfillState({
          status: 'completed',
          totalConversations: 0,
          processedConversations: 0,
          lastProcessedConversationId: null,
        });
        return;
      }

      // Determine resume point if we were interrupted mid-backfill
      let startIndex = 0;
      let processedSoFar = 0;

      if (existingState && existingState.lastProcessedConversationId) {
        const resumeIndex = nonBranchConversations.findIndex(
          c => c.id === existingState.lastProcessedConversationId
        );
        if (resumeIndex >= 0) {
          // Start after the last successfully processed conversation
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
        return;
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

      // Process each conversation from the resume point
      for (let i = startIndex; i < totalCount; i++) {
        // Check for abort
        if (this.abortController?.signal.aborted) {
          break;
        }

        const conv = nonBranchConversations[i];

        try {
          await this.backfillConversation(
            conv.id,
            conv.workspaceId ?? undefined,
            conv.sessionId ?? undefined
          );
        } catch (error) {
          // Log and continue -- one bad conversation should not abort the batch
          console.error(
            `[IndexingQueue] Failed to backfill conversation ${conv.id}:`,
            error
          );
        }

        processedSoFar++;
        lastProcessedId = conv.id;

        // Update progress in backfill state table
        if (processedSoFar % this.SAVE_INTERVAL === 0) {
          await this.updateBackfillState({
            status: 'running',
            totalConversations: totalCount,
            processedConversations: processedSoFar,
            lastProcessedConversationId: lastProcessedId,
          });
          await this.db.save();
        }

        // Yield to main thread periodically to keep Obsidian responsive
        if (i > startIndex && (i - startIndex) % this.CONVERSATION_YIELD_INTERVAL === 0) {
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

    } catch (error: any) {
      console.error('[IndexingQueue] Conversation backfill failed:', error);
      await this.updateBackfillState({
        status: 'error',
        totalConversations: 0,
        processedConversations: 0,
        lastProcessedConversationId: null,
        errorMessage: error.message,
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Backfill a single conversation by fetching its messages, building QA pairs,
   * and embedding each pair. The EmbeddingService.embedConversationTurn method
   * is idempotent (checks contentHash), so re-processing a conversation that
   * was partially embedded is safe.
   *
   * @param conversationId - The conversation to backfill
   * @param workspaceId - Optional workspace context
   * @param sessionId - Optional session context
   */
  private async backfillConversation(
    conversationId: string,
    workspaceId?: string,
    sessionId?: string
  ): Promise<void> {
    // Fetch all messages for this conversation from SQLite cache
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

    // Convert rows to MessageData (match field types exactly)
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

    // Build QA pairs from messages
    const qaPairs = buildQAPairs(messages, conversationId, workspaceId, sessionId);

    // Embed each pair (idempotent -- contentHash prevents re-embedding)
    for (const qaPair of qaPairs) {
      await this.embeddingService.embedConversationTurn(qaPair);
    }
  }

  /**
   * Insert or update the backfill progress state in the database.
   * Used to track progress for resume-on-interrupt support.
   *
   * Uses INSERT for the first write and UPDATE for subsequent writes so that
   * startedAt is preserved across progress updates (INSERT OR REPLACE would
   * overwrite the original start timestamp).
   *
   * @param state - Partial backfill state to persist
   */
  private async updateBackfillState(state: {
    status: string;
    totalConversations: number;
    processedConversations: number;
    lastProcessedConversationId: string | null;
    errorMessage?: string;
  }): Promise<void> {
    const now = Date.now();

    // Check if a row already exists
    const existing = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM embedding_backfill_state WHERE id = ?',
      [CONVERSATION_BACKFILL_ID]
    );

    if (existing) {
      // Update existing row -- preserve startedAt, only set completedAt on completion
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
      // First write -- set startedAt
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
