/**
 * Location: src/services/embeddings/EmbeddingEngine.ts
 * Purpose: Local embedding generation using iframe-sandboxed transformers.js
 *
 * Uses iframe sandbox approach to avoid Electron/Node.js environment issues.
 * The iframe loads transformers.js from CDN in a pure browser context.
 *
 * Based on Smart Connections' proven approach for Obsidian compatibility.
 */

import { EmbeddingIframe } from './EmbeddingIframe';

/**
 * Embedding engine using iframe-sandboxed Transformers.js
 *
 * Model: Xenova/all-MiniLM-L6-v2
 * - Dimensions: 384
 * - Size: ~23MB (quantized)
 * - Good balance of speed and quality for semantic search
 */
export class EmbeddingEngine {
  private iframe: EmbeddingIframe | null = null;
  private readonly MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
  private readonly DIMENSIONS = 384;

  /**
   * Initialize the embedding model via iframe
   * Downloads model on first use (~23MB, cached in IndexedDB)
   */
  async initialize(): Promise<void> {
    if (this.iframe?.ready()) {
      return;
    }

    console.log('[EmbeddingEngine] ========================================');
    console.log('[EmbeddingEngine] Initializing via iframe sandbox...');
    console.log('[EmbeddingEngine] This avoids Electron/Node.js conflicts');

    const startTime = performance.now();

    this.iframe = new EmbeddingIframe();
    await this.iframe.initialize();

    const totalTime = (performance.now() - startTime).toFixed(0);
    console.log(`[EmbeddingEngine] Model loaded in ${totalTime}ms`);
    console.log('[EmbeddingEngine] Ready to generate embeddings');
    console.log('[EmbeddingEngine] ========================================');
  }

  /**
   * Generate embedding for text
   *
   * @param text - Text to embed (truncated to ~2000 chars in iframe)
   * @returns Float32Array of 384 dimensions
   */
  async generateEmbedding(text: string): Promise<Float32Array> {
    if (!this.iframe) {
      await this.initialize();
    }

    return this.iframe!.generateEmbedding(text);
  }

  /**
   * Generate embeddings for multiple texts (batch processing)
   *
   * @param texts - Array of texts to embed
   * @returns Array of Float32Array embeddings
   */
  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    if (!this.iframe) {
      await this.initialize();
    }

    return this.iframe!.generateEmbeddings(texts);
  }

  /**
   * Dispose of the engine to free memory
   */
  async dispose(): Promise<void> {
    if (this.iframe) {
      await this.iframe.dispose();
      this.iframe = null;
    }
  }

  /**
   * Check if engine is initialized
   */
  isReady(): boolean {
    return this.iframe?.ready() ?? false;
  }

  /**
   * Get model info
   */
  getModelInfo(): { id: string; dimensions: number } {
    return {
      id: this.MODEL_ID,
      dimensions: this.DIMENSIONS
    };
  }
}
