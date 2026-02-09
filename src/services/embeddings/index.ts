/**
 * Location: src/services/embeddings/index.ts
 * Purpose: Barrel exports for embedding system
 */

export { EmbeddingEngine } from './EmbeddingEngine';
export { EmbeddingService } from './EmbeddingService';
export { NoteEmbeddingService } from './NoteEmbeddingService';
export { TraceEmbeddingService } from './TraceEmbeddingService';
export { ConversationEmbeddingService } from './ConversationEmbeddingService';
export { EmbeddingWatcher } from './EmbeddingWatcher';
export { ConversationEmbeddingWatcher } from './ConversationEmbeddingWatcher';
export { ConversationWindowRetriever } from './ConversationWindowRetriever';
export { IndexingQueue } from './IndexingQueue';
export { EmbeddingStatusBar } from './EmbeddingStatusBar';
export { EmbeddingManager } from './EmbeddingManager';

export { chunkContent } from './ContentChunker';
export { buildQAPairs, hashContent } from './QAPairBuilder';
export { preprocessContent, extractWikiLinks } from './EmbeddingUtils';

export type { SimilarNote } from './NoteEmbeddingService';
export type { TraceSearchResult } from './TraceEmbeddingService';
export type { ConversationSearchResult } from './ConversationEmbeddingService';
export type { IndexingProgress } from './IndexingQueue';
export type { ChunkOptions, ContentChunk } from './ContentChunker';
export type { QAPair } from './QAPairBuilder';
export type { WindowOptions, MessageWindow } from './ConversationWindowRetriever';
