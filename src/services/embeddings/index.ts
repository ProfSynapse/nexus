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

export type { SimilarNote, TraceSearchResult } from './EmbeddingService';
export type { IndexingProgress } from './IndexingQueue';
