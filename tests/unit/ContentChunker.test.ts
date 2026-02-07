/**
 * ContentChunker Unit Tests
 *
 * Tests the pure chunkContent function that splits text into overlapping
 * chunks for the embedding pipeline. No mocks needed -- pure function testing.
 *
 * Default options: maxChunkSize=500, overlap=100, minChunkSize=50
 * Stride = maxChunkSize - overlap = 400
 */

import { chunkContent, ContentChunk, ChunkOptions } from '../../src/services/embeddings/ContentChunker';
import { CHUNK_CONTENT } from '../fixtures/conversationSearch';

describe('ContentChunker', () => {
  // ==========================================================================
  // Empty / Whitespace Input
  // ==========================================================================

  describe('empty and whitespace input', () => {
    it('should return empty array for empty string', () => {
      const result = chunkContent('');
      expect(result).toEqual([]);
    });

    it('should return empty array for whitespace-only string', () => {
      const result = chunkContent(CHUNK_CONTENT.whitespace);
      expect(result).toEqual([]);
    });

    it('should return empty array for null-ish input', () => {
      // TypeScript allows this at runtime even though type says string
      const result = chunkContent(undefined as unknown as string);
      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // Single Chunk (content <= maxChunkSize)
  // ==========================================================================

  describe('single chunk for short content', () => {
    it('should return single chunk for content under maxChunkSize', () => {
      const result = chunkContent(CHUNK_CONTENT.short);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        text: CHUNK_CONTENT.short,
        chunkIndex: 0,
        charOffset: 0,
      });
    });

    it('should return single chunk for content exactly at maxChunkSize', () => {
      const result = chunkContent(CHUNK_CONTENT.exact500);

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe(CHUNK_CONTENT.exact500);
      expect(result[0].chunkIndex).toBe(0);
      expect(result[0].charOffset).toBe(0);
    });

    it('should return single chunk for 1-character content', () => {
      const result = chunkContent('A');

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('A');
    });
  });

  // ==========================================================================
  // Multiple Chunks with Overlap
  // ==========================================================================

  describe('multiple chunks with overlap', () => {
    it('should split content just over maxChunkSize into chunks', () => {
      // 501 chars, stride=400 => chunk 0: [0,500), next start: 400
      // remainder from 400 = 101 chars, which is > minChunkSize
      const result = chunkContent(CHUNK_CONTENT.just_over);

      expect(result.length).toBeGreaterThanOrEqual(2);
      // First chunk starts at offset 0
      expect(result[0].charOffset).toBe(0);
      expect(result[0].chunkIndex).toBe(0);
      // First chunk is maxChunkSize chars
      expect(result[0].text.length).toBe(500);
    });

    it('should produce correct overlap between consecutive chunks', () => {
      // 1000 chars with default options (stride=400, overlap=100)
      const result = chunkContent(CHUNK_CONTENT.medium);

      expect(result.length).toBeGreaterThanOrEqual(2);

      // Check overlap between first two chunks
      const chunk0End = result[0].charOffset + result[0].text.length;
      const chunk1Start = result[1].charOffset;
      const overlapChars = chunk0End - chunk1Start;

      // Overlap should be at least 100 (the configured overlap)
      expect(overlapChars).toBeGreaterThanOrEqual(100);
    });

    it('should have monotonically increasing chunkIndex values', () => {
      const result = chunkContent(CHUNK_CONTENT.long);

      for (let i = 0; i < result.length; i++) {
        expect(result[i].chunkIndex).toBe(i);
      }
    });

    it('should have monotonically increasing charOffset values', () => {
      const result = chunkContent(CHUNK_CONTENT.long);

      for (let i = 1; i < result.length; i++) {
        expect(result[i].charOffset).toBeGreaterThan(result[i - 1].charOffset);
      }
    });

    it('should cover the entire input content', () => {
      const content = CHUNK_CONTENT.long;
      const result = chunkContent(content);

      // First chunk starts at 0
      expect(result[0].charOffset).toBe(0);

      // Last chunk extends to or past the end of the content
      const lastChunk = result[result.length - 1];
      const lastChunkEnd = lastChunk.charOffset + lastChunk.text.length;
      expect(lastChunkEnd).toBe(content.length);
    });

    it('should produce correct chunks for realistic markdown content', () => {
      const result = chunkContent(CHUNK_CONTENT.markdown);

      // Markdown content is ~700 chars, so should produce at least 2 chunks
      expect(result.length).toBeGreaterThanOrEqual(2);

      // Each chunk text should be a substring of the original
      for (const chunk of result) {
        expect(CHUNK_CONTENT.markdown).toContain(chunk.text);
      }
    });
  });

  // ==========================================================================
  // Trailing Remainder / minChunkSize Behavior
  // ==========================================================================

  describe('trailing remainder and minChunkSize', () => {
    it('should merge tiny trailing remainder into previous chunk', () => {
      // 850 chars, stride=400:
      // chunk0: offset=0, text=[0,500)
      // next offset=400, remainder from 400=450 chars. That's > minChunkSize,
      // so chunk1: offset=400, text=[400, 850). But let's check the logic:
      // After chunk0 emitted, offset=400. end=min(400+500,850)=850.
      // end >= content.length (850 >= 850), so this is the final chunk.
      // chunkText length = 850-400 = 450, which is >= minChunkSize(50).
      // So this specific case doesn't trigger the merge.

      // Instead, let's use a content size that DOES produce a tiny remainder.
      // stride=400. Content = 440 chars above maxChunkSize.
      // chunk0: [0, 500), offset advances to 400. Remainder from 400 = 540-400 = 140. > minChunkSize.
      // That still doesn't work easily. Let's use custom options.

      // Custom: maxChunkSize=100, overlap=20, minChunkSize=30
      // stride = 80.
      // Content = 190 chars.
      // chunk0: [0,100), nextOffset=80, remainderLength=190-80=110, > maxChunkSize? No (110>100 yes actually).
      // chunk0 emitted. offset=80. end=min(80+100,190)=180. end < 190, so not final.
      // nextOffset=160, remainderLength=190-160=30. 30 >= minChunkSize=30? No, 30 is NOT < 30.
      // chunk1 emitted at offset=80. offset=160. end=min(160+100,190)=190. end >= 190, final chunk.
      // chunkText length=190-160=30. 30 >= minChunkSize? Yes. So it stands alone.

      // To trigger merge: Content = 189 chars, minChunkSize=30
      // chunk0: [0,100), nextOffset=80, remainderLength=189-80=109 > maxChunkSize=100.
      // chunk0 emitted. offset=80. end=min(180,189)=180. Not final (180 < 189).
      // nextOffset=160, remainderLength=189-160=29. 29 < minChunkSize=30.
      // This triggers the early extend: emit content.slice(80) and stop.
      const content = 'A'.repeat(189);
      const options: Partial<ChunkOptions> = { maxChunkSize: 100, overlap: 20, minChunkSize: 30 };
      const result = chunkContent(content, options);

      // Should be 2 chunks: first normal, second extended to include remainder
      expect(result).toHaveLength(2);
      expect(result[0].text.length).toBe(100);
      // Second chunk should extend to end of content
      expect(result[1].charOffset).toBe(80);
      expect(result[1].text.length).toBe(189 - 80); // 109 chars
    });

    it('should merge tiny final chunk into previous when final chunk is below minChunkSize', () => {
      // We need the final chunk (reached via end >= content.length) to be below minChunkSize.
      // Custom: maxChunkSize=100, overlap=20, minChunkSize=30, stride=80.
      // Content = 110 chars. First chunk: [0,100). offset advances to 80.
      // Next iteration: end = min(80+100, 110) = 110 >= 110. This is the final chunk.
      // chunkText = content.slice(80, 110) = 30 chars. 30 >= minChunkSize(30)? Yes. Not merged.
      //
      // Content = 109 chars. First chunk: [0,100). Advance to 80.
      // Next: end = min(180, 109) = 109 >= 109. Final chunk.
      // chunkText = content.slice(80, 109) = 29 chars. 29 < minChunkSize(30) AND chunks.length > 0.
      // This triggers the merge into previous chunk (lines 114-115).
      const content = 'A'.repeat(109);
      const options: Partial<ChunkOptions> = { maxChunkSize: 100, overlap: 20, minChunkSize: 30 };
      const result = chunkContent(content, options);

      // Should be only 1 chunk (the tiny remainder merged into the first)
      expect(result).toHaveLength(1);
      expect(result[0].charOffset).toBe(0);
      // The merged chunk should extend to the end of content
      expect(result[0].text.length).toBe(109);
      expect(result[0].text).toBe(content);
    });

    it('should keep the last chunk if it meets minChunkSize', () => {
      // 200 chars, maxChunkSize=100, overlap=20, minChunkSize=30, stride=80
      // chunk0: [0,100). nextOffset=80, remainderLength=200-80=120 > maxChunkSize.
      // chunk0 emitted. offset=80. end=min(180,200)=180. Not final.
      // nextOffset=160, remainderLength=200-160=40 >= minChunkSize=30. NOT < minChunkSize.
      // chunk1 emitted [80,180). offset=160. end=min(260,200)=200. Final.
      // chunkText=200-160=40 >= minChunkSize. Stands alone.
      const content = 'B'.repeat(200);
      const options: Partial<ChunkOptions> = { maxChunkSize: 100, overlap: 20, minChunkSize: 30 };
      const result = chunkContent(content, options);

      expect(result).toHaveLength(3);
      expect(result[2].text.length).toBe(40);
      expect(result[2].charOffset).toBe(160);
    });
  });

  // ==========================================================================
  // Custom Options
  // ==========================================================================

  describe('custom options', () => {
    it('should respect custom maxChunkSize', () => {
      const content = 'A'.repeat(300);
      const result = chunkContent(content, { maxChunkSize: 200 });

      expect(result[0].text.length).toBe(200);
    });

    it('should respect custom overlap', () => {
      // maxChunkSize=200, overlap=50 => stride=150
      const content = 'A'.repeat(400);
      const result = chunkContent(content, { maxChunkSize: 200, overlap: 50 });

      expect(result.length).toBeGreaterThanOrEqual(2);
      // Second chunk should start at offset 150
      expect(result[1].charOffset).toBe(150);
    });

    it('should use defaults for missing partial options', () => {
      const content = 'A'.repeat(600);
      // Only specify maxChunkSize, overlap and minChunkSize use defaults
      const result = chunkContent(content, { maxChunkSize: 300 });

      // With maxChunkSize=300, overlap=100 (default), stride=200
      expect(result[0].text.length).toBe(300);
      if (result.length > 1) {
        expect(result[1].charOffset).toBe(200);
      }
    });
  });

  // ==========================================================================
  // Edge Cases: Invalid stride
  // ==========================================================================

  describe('edge case: zero or negative stride', () => {
    it('should return single truncated chunk when overlap >= maxChunkSize', () => {
      // overlap=500 >= maxChunkSize=500 => stride = 0
      const content = 'A'.repeat(1000);
      const result = chunkContent(content, { maxChunkSize: 500, overlap: 500 });

      expect(result).toHaveLength(1);
      expect(result[0].text.length).toBe(500);
      expect(result[0].charOffset).toBe(0);
    });

    it('should return single truncated chunk when overlap > maxChunkSize', () => {
      const content = 'A'.repeat(1000);
      const result = chunkContent(content, { maxChunkSize: 100, overlap: 200 });

      expect(result).toHaveLength(1);
      expect(result[0].text.length).toBe(100);
    });
  });

  // ==========================================================================
  // charOffset Correctness
  // ==========================================================================

  describe('charOffset correctness', () => {
    it('should produce chunk text that matches original content at charOffset', () => {
      const content = CHUNK_CONTENT.markdown;
      const result = chunkContent(content);

      for (const chunk of result) {
        const expected = content.slice(chunk.charOffset, chunk.charOffset + chunk.text.length);
        expect(chunk.text).toBe(expected);
      }
    });

    it('should produce valid charOffsets for all chunks with custom options', () => {
      const content = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(20); // 520 chars
      const result = chunkContent(content, { maxChunkSize: 100, overlap: 20 });

      for (const chunk of result) {
        expect(chunk.charOffset).toBeGreaterThanOrEqual(0);
        expect(chunk.charOffset).toBeLessThan(content.length);
        const expected = content.slice(chunk.charOffset, chunk.charOffset + chunk.text.length);
        expect(chunk.text).toBe(expected);
      }
    });
  });
});
