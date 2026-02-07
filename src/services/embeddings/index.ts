/**
 * Location: src/services/embeddings/index.ts
 * Purpose: Barrel exports for embedding system
 */

export { EmbeddingEngine } from './EmbeddingEngine';
export { EmbeddingService } from './EmbeddingService';
export { EmbeddingWatcher } from './EmbeddingWatcher';
export { IndexingQueue } from './IndexingQueue';
export { EmbeddingStatusBar } from './EmbeddingStatusBar';
export { EmbeddingManager } from './EmbeddingManager';

export { chunkContent } from './ContentChunker';
export { buildQAPairs, hashContent } from './QAPairBuilder';

export type { SimilarNote, TraceSearchResult } from './EmbeddingService';
export type { IndexingProgress } from './IndexingQueue';
export type { ChunkOptions, ContentChunk } from './ContentChunker';
export type { QAPair } from './QAPairBuilder';
