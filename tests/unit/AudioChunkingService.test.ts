/**
 * AudioChunkingService Unit Tests
 *
 * Tests the audio chunking logic:
 * - Small files pass through as single chunk
 * - Large files on mobile throw an error
 * - decodeAudioData failure falls back to returning unsplit buffer
 */

import { chunkAudio } from '../../src/agents/ingestManager/tools/services/AudioChunkingService';
import { Platform } from 'obsidian';

describe('AudioChunkingService', () => {
  // ==========================================================================
  // Small files (under 25MB threshold)
  // ==========================================================================

  describe('small files (under 25MB)', () => {
    it('should return single chunk for small buffer', async () => {
      const data = new ArrayBuffer(1024); // 1KB
      const chunks = await chunkAudio(data, 'audio/mpeg');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].data).toBe(data);
      expect(chunks[0].mimeType).toBe('audio/mpeg');
      expect(chunks[0].startSeconds).toBe(0);
      expect(chunks[0].durationSeconds).toBe(0);
    });

    it('should return single chunk for exactly 25MB buffer', async () => {
      const data = new ArrayBuffer(25 * 1024 * 1024); // exactly 25MB
      const chunks = await chunkAudio(data, 'audio/wav');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].data).toBe(data);
      expect(chunks[0].mimeType).toBe('audio/wav');
    });

    it('should preserve original mimeType for small files', async () => {
      const data = new ArrayBuffer(100);
      const chunks = await chunkAudio(data, 'audio/flac');
      expect(chunks[0].mimeType).toBe('audio/flac');
    });

    it('should return empty-ish duration for small files (unknown without decoding)', async () => {
      const data = new ArrayBuffer(500);
      const chunks = await chunkAudio(data, 'audio/ogg');
      expect(chunks[0].durationSeconds).toBe(0);
    });
  });

  // ==========================================================================
  // Large files — mobile guard
  // ==========================================================================

  describe('large files on mobile', () => {
    const originalIsDesktop = Platform.isDesktop;

    afterEach(() => {
      (Platform as { isDesktop: boolean }).isDesktop = originalIsDesktop;
    });

    it('should throw an error on mobile for files over 25MB', async () => {
      (Platform as { isDesktop: boolean }).isDesktop = false;
      const data = new ArrayBuffer(26 * 1024 * 1024); // 26MB

      await expect(chunkAudio(data, 'audio/mpeg')).rejects.toThrow(
        'Audio file exceeds 25MB limit'
      );
    });

    it('should include mobile guidance in error message', async () => {
      (Platform as { isDesktop: boolean }).isDesktop = false;
      const data = new ArrayBuffer(26 * 1024 * 1024);

      await expect(chunkAudio(data, 'audio/mpeg')).rejects.toThrow(
        'desktop app'
      );
    });
  });

  // ==========================================================================
  // Large files — decodeAudioData fallback
  // ==========================================================================

  describe('large files - decode failure fallback', () => {
    // AudioContext won't be available in Node.js test environment,
    // so the decodeAndChunk path will naturally fail and trigger the fallback.
    it('should return unsplit buffer when decodeAudioData fails', async () => {
      const data = new ArrayBuffer(26 * 1024 * 1024); // 26MB
      const chunks = await chunkAudio(data, 'audio/mpeg');

      // Should have fallen back to the catch branch
      expect(chunks).toHaveLength(1);
      expect(chunks[0].data).toBe(data);
      expect(chunks[0].mimeType).toBe('audio/mpeg');
      expect(chunks[0].startSeconds).toBe(0);
      expect(chunks[0].durationSeconds).toBe(0);
    });

    it('should log error when decode fails', async () => {
      const data = new ArrayBuffer(26 * 1024 * 1024);
      await chunkAudio(data, 'audio/wav');

      // console.error is mocked in setup.ts
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('[AudioChunkingService]'),
        expect.anything()
      );
    });
  });
});
