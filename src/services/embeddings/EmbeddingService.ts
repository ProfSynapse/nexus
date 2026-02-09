/**
 * Location: src/services/embeddings/EmbeddingService.ts
 * Purpose: Facade/coordinator for the embedding system's three domain services.
 *
 * Delegates all embedding operations to domain-specific services:
 * - NoteEmbeddingService: note-level embeddings and semantic note search
 * - TraceEmbeddingService: memory trace embeddings and semantic trace search
 * - ConversationEmbeddingService: conversation QA pair embeddings and search
 *
 * This facade preserves the original public API so that all existing callers
 * (EmbeddingWatcher, IndexingQueue, ConversationEmbeddingWatcher,
 * SearchManager, ChatTraceService, etc.) continue to work without changes.
 *
 * Owns shared state: engine, isEnabled flag, initialization.
 *
 * Relationships:
 * - Used by EmbeddingManager for lifecycle management
 * - Used by EmbeddingWatcher, IndexingQueue, ConversationEmbeddingWatcher
 * - Used by SearchManager (searchContent, MemorySearchProcessor)
 * - Used by ChatTraceService for trace embedding
 */

import { App, Notice, Platform } from 'obsidian';
import { EmbeddingEngine } from './EmbeddingEngine';
import { NoteEmbeddingService } from './NoteEmbeddingService';
import { TraceEmbeddingService } from './TraceEmbeddingService';
import { ConversationEmbeddingService } from './ConversationEmbeddingService';
import type { QAPair } from './QAPairBuilder';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';

// Re-export types so existing callers importing from EmbeddingService still work
export type { SimilarNote } from './NoteEmbeddingService';
export type { TraceSearchResult } from './TraceEmbeddingService';
export type { ConversationSearchResult } from './ConversationEmbeddingService';

/**
 * Embedding service facade for notes, traces, and conversations.
 *
 * Desktop-only - check Platform.isMobile before using.
 * All public methods are guarded by the isEnabled flag and return safe
 * defaults (empty arrays, zero counts) when disabled.
 */
export class EmbeddingService {
  private engine: EmbeddingEngine;
  private isEnabled: boolean;

  private noteService: NoteEmbeddingService;
  private traceService: TraceEmbeddingService;
  private conversationService: ConversationEmbeddingService;

  constructor(
    app: App,
    db: SQLiteCacheManager,
    engine: EmbeddingEngine
  ) {
    this.engine = engine;

    // Disable on mobile entirely
    this.isEnabled = !Platform.isMobile;

    // Create domain services
    this.noteService = new NoteEmbeddingService(app, db, engine);
    this.traceService = new TraceEmbeddingService(db, engine);
    this.conversationService = new ConversationEmbeddingService(db, engine);
  }

  /**
   * Initialize the service (loads embedding model)
   */
  async initialize(): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    try {
      await this.engine.initialize();
    } catch (error) {
      console.error('[EmbeddingService] Initialization failed:', error);
      new Notice('Failed to load embedding model. Vector search will be unavailable.');
      this.isEnabled = false;
    }
  }

  // ==================== NOTE EMBEDDINGS ====================

  async embedNote(notePath: string): Promise<void> {
    if (!this.isEnabled) return;
    return this.noteService.embedNote(notePath);
  }

  async findSimilarNotes(notePath: string, limit = 10) {
    if (!this.isEnabled) return [];
    return this.noteService.findSimilarNotes(notePath, limit);
  }

  async semanticSearch(query: string, limit = 10) {
    if (!this.isEnabled) return [];
    return this.noteService.semanticSearch(query, limit);
  }

  async removeEmbedding(notePath: string): Promise<void> {
    if (!this.isEnabled) return;
    return this.noteService.removeEmbedding(notePath);
  }

  async updatePath(oldPath: string, newPath: string): Promise<void> {
    if (!this.isEnabled) return;
    return this.noteService.updatePath(oldPath, newPath);
  }

  // ==================== TRACE EMBEDDINGS ====================

  async embedTrace(
    traceId: string,
    workspaceId: string,
    sessionId: string | undefined,
    content: string
  ): Promise<void> {
    if (!this.isEnabled) return;
    return this.traceService.embedTrace(traceId, workspaceId, sessionId, content);
  }

  async semanticTraceSearch(query: string, workspaceId: string, limit = 20) {
    if (!this.isEnabled) return [];
    return this.traceService.semanticTraceSearch(query, workspaceId, limit);
  }

  async removeTraceEmbedding(traceId: string): Promise<void> {
    if (!this.isEnabled) return;
    return this.traceService.removeTraceEmbedding(traceId);
  }

  async removeWorkspaceTraceEmbeddings(workspaceId: string): Promise<number> {
    if (!this.isEnabled) return 0;
    return this.traceService.removeWorkspaceTraceEmbeddings(workspaceId);
  }

  // ==================== CONVERSATION EMBEDDINGS ====================

  async embedConversationTurn(qaPair: QAPair): Promise<void> {
    if (!this.isEnabled) return;
    return this.conversationService.embedConversationTurn(qaPair);
  }

  async semanticConversationSearch(
    query: string,
    workspaceId: string,
    sessionId?: string,
    limit = 20
  ) {
    if (!this.isEnabled) return [];
    return this.conversationService.semanticConversationSearch(query, workspaceId, sessionId, limit);
  }

  async removeConversationEmbeddings(conversationId: string): Promise<void> {
    if (!this.isEnabled) return;
    return this.conversationService.removeConversationEmbeddings(conversationId);
  }

  async onConversationDeleted(conversationId: string): Promise<void> {
    if (!this.isEnabled) return;
    return this.conversationService.onConversationDeleted(conversationId);
  }

  // ==================== UTILITIES ====================

  /**
   * Check if service is enabled
   */
  isServiceEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Get embedding statistics aggregated from all domain services
   */
  async getStats(): Promise<{
    noteCount: number;
    traceCount: number;
    conversationChunkCount: number;
  }> {
    if (!this.isEnabled) {
      return { noteCount: 0, traceCount: 0, conversationChunkCount: 0 };
    }

    try {
      const [noteCount, traceCount, conversationChunkCount] = await Promise.all([
        this.noteService.getNoteStats(),
        this.traceService.getTraceStats(),
        this.conversationService.getConversationStats(),
      ]);

      return { noteCount, traceCount, conversationChunkCount };
    } catch (error) {
      console.error('[EmbeddingService] Failed to get stats:', error);
      return { noteCount: 0, traceCount: 0, conversationChunkCount: 0 };
    }
  }
}
