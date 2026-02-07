/**
 * Location: src/services/embeddings/ContentChunker.ts
 * Purpose: Pure function that splits text into overlapping chunks for embedding.
 *
 * Chunks are indexing artifacts for the embedding pipeline. When a chunk matches
 * a search query, the full original content is returned to the LLM -- chunks
 * themselves are never displayed to users.
 *
 * Used by:
 * - QAPairBuilder: chunks Q and A independently, all chunks share a pairId
 * - EmbeddingService: will replace current 2000-char truncation with chunking
 *
 * Design decisions:
 * - 500-char chunks chosen for search precision (full pair returned regardless)
 * - 100-char overlap prevents splitting semantic units at boundaries
 * - 50-char minimum prevents tiny trailing chunks that embed poorly
 * - Trailing content below minChunkSize is merged into the previous chunk
 */

/**
 * Configuration for text chunking behavior.
 */
export interface ChunkOptions {
  /** Maximum number of characters per chunk. Default: 500 */
  maxChunkSize: number;
  /** Number of overlapping characters between consecutive chunks. Default: 100 */
  overlap: number;
  /** Minimum size for the final chunk. Smaller remainders merge into the previous chunk. Default: 50 */
  minChunkSize: number;
}

/**
 * A single chunk of text with its position metadata.
 */
export interface ContentChunk {
  /** The chunk text content */
  text: string;
  /** Zero-based index of this chunk in the sequence */
  chunkIndex: number;
  /** Character offset of this chunk's start position in the original content */
  charOffset: number;
}

/** Default chunking configuration */
const DEFAULT_OPTIONS: ChunkOptions = {
  maxChunkSize: 500,
  overlap: 100,
  minChunkSize: 50,
};

/**
 * Splits text content into overlapping chunks suitable for embedding.
 *
 * The chunking strategy uses a sliding window with configurable size and overlap.
 * The stride (step size) equals maxChunkSize - overlap. For defaults, this means
 * each chunk advances 400 characters while sharing 100 characters with its neighbor.
 *
 * Edge cases:
 * - Empty or whitespace-only content returns an empty array.
 * - Content shorter than or equal to maxChunkSize returns a single chunk.
 * - If the trailing remainder after the last full stride is shorter than minChunkSize,
 *   it is merged into the previous chunk (extending that chunk beyond maxChunkSize).
 *
 * @param content - The text to split into chunks
 * @param options - Optional partial configuration (defaults applied for missing fields)
 * @returns Array of ContentChunk objects, or empty array for empty/whitespace input
 */
export function chunkContent(content: string, options?: Partial<ChunkOptions>): ContentChunk[] {
  const opts: ChunkOptions = { ...DEFAULT_OPTIONS, ...options };

  // Guard: empty or whitespace-only content
  if (!content || content.trim().length === 0) {
    return [];
  }

  // Guard: content fits in a single chunk
  if (content.length <= opts.maxChunkSize) {
    return [{
      text: content,
      chunkIndex: 0,
      charOffset: 0,
    }];
  }

  const stride = opts.maxChunkSize - opts.overlap;

  // Guard: stride must be positive to avoid infinite loops
  if (stride <= 0) {
    return [{
      text: content.slice(0, opts.maxChunkSize),
      chunkIndex: 0,
      charOffset: 0,
    }];
  }

  const chunks: ContentChunk[] = [];
  let offset = 0;
  let chunkIndex = 0;

  while (offset < content.length) {
    const end = Math.min(offset + opts.maxChunkSize, content.length);
    const chunkText = content.slice(offset, end);

    // Check if this is the last chunk and whether there would be a tiny remainder
    const nextOffset = offset + stride;
    const remainderStart = nextOffset;
    const remainderLength = content.length - remainderStart;

    // If we have consumed all content with this chunk, emit and stop
    if (end >= content.length) {
      // This is the final chunk. Check if it's too small to stand alone.
      if (chunkText.length < opts.minChunkSize && chunks.length > 0) {
        // Merge into previous chunk by extending it
        const previousChunk = chunks[chunks.length - 1];
        previousChunk.text = content.slice(previousChunk.charOffset);
      } else {
        chunks.push({
          text: chunkText,
          chunkIndex,
          charOffset: offset,
        });
      }
      break;
    }

    // Check if the NEXT iteration would produce a remainder smaller than minChunkSize.
    // If so, extend this chunk to consume the remainder and stop.
    if (remainderLength > 0 && remainderLength <= opts.maxChunkSize && remainderLength < opts.minChunkSize) {
      // The remainder after this chunk's stride is too small.
      // Extend this chunk to include the remainder.
      chunks.push({
        text: content.slice(offset),
        chunkIndex,
        charOffset: offset,
      });
      break;
    }

    // Normal case: emit this chunk and advance by stride
    chunks.push({
      text: chunkText,
      chunkIndex,
      charOffset: offset,
    });

    offset += stride;
    chunkIndex++;
  }

  return chunks;
}
