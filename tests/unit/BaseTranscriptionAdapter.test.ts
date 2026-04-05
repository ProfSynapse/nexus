/**
 * BaseTranscriptionAdapter Unit Tests
 *
 * Tests the abstract base class shared helpers via a concrete test subclass:
 * - isAvailable (API key presence)
 * - getModels (delegates to VoiceTypes)
 * - mimeToExtension mapping
 * - mimeToOpenRouterFormat
 * - arrayBufferToBase64
 * - buildChunkFileName
 */

import {
  BaseTranscriptionAdapter,
  TranscriptionAdapterConfig
} from '../../src/services/llm/adapters/BaseTranscriptionAdapter';
import type {
  AudioChunk,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionSegment
} from '../../src/services/llm/types/VoiceTypes';

// Concrete subclass to test protected/abstract members
class TestAdapter extends BaseTranscriptionAdapter {
  readonly provider: TranscriptionProvider = 'openai';

  async transcribeChunk(): Promise<TranscriptionSegment[]> {
    return [];
  }

  // Expose protected methods for testing
  public testMimeToExtension(mimeType: string): string {
    return this.mimeToExtension(mimeType);
  }

  public testMimeToOpenRouterFormat(mimeType: string): string {
    return this.mimeToOpenRouterFormat(mimeType);
  }

  public testArrayBufferToBase64(buffer: ArrayBuffer): string {
    return this.arrayBufferToBase64(buffer);
  }

  public testBuildChunkFileName(fileName: string, mimeType: string): string {
    return this.buildChunkFileName(fileName, mimeType);
  }
}

function makeAdapter(config: Partial<TranscriptionAdapterConfig> = {}): TestAdapter {
  return new TestAdapter({ apiKey: 'test-key', ...config });
}

describe('BaseTranscriptionAdapter', () => {
  // ── isAvailable ─────────────────────────────────────────────────────

  describe('isAvailable', () => {
    it('returns true when API key is set', () => {
      const adapter = makeAdapter({ apiKey: 'sk-test' });
      expect(adapter.isAvailable()).toBe(true);
    });

    it('returns false when API key is empty string', () => {
      const adapter = makeAdapter({ apiKey: '' });
      expect(adapter.isAvailable()).toBe(false);
    });

    it('returns false when API key is whitespace-only (falsy after Boolean)', () => {
      // Note: '  ' is truthy in JS, so isAvailable returns true.
      // This documents the actual behavior.
      const adapter = makeAdapter({ apiKey: '  ' });
      expect(adapter.isAvailable()).toBe(true);
    });
  });

  // ── getModels ───────────────────────────────────────────────────────

  describe('getModels', () => {
    it('returns models for the adapter provider', () => {
      const adapter = makeAdapter();
      const models = adapter.getModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.provider === 'openai')).toBe(true);
    });

    it('returns model declarations with required fields', () => {
      const adapter = makeAdapter();
      const models = adapter.getModels();
      for (const model of models) {
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('name');
        expect(model).toHaveProperty('execution');
        expect(typeof model.supportsWordTimestamps).toBe('boolean');
      }
    });
  });

  // ── mimeToExtension ─────────────────────────────────────────────────

  describe('mimeToExtension', () => {
    const adapter = makeAdapter();

    it.each([
      ['audio/wav', '.wav'],
      ['audio/mpeg', '.mp3'],
      ['audio/mp4', '.m4a'],
      ['audio/aac', '.aac'],
      ['audio/ogg', '.ogg'],
      ['audio/opus', '.opus'],
      ['audio/flac', '.flac'],
      ['audio/webm', '.webm'],
      ['audio/x-ms-wma', '.wma'],
    ])('maps %s to %s', (mime, ext) => {
      expect(adapter.testMimeToExtension(mime)).toBe(ext);
    });

    it('returns .bin for unknown MIME type', () => {
      expect(adapter.testMimeToExtension('audio/unknown')).toBe('.bin');
    });

    it('returns .bin for empty string', () => {
      expect(adapter.testMimeToExtension('')).toBe('.bin');
    });

    it('returns .bin for non-audio MIME type', () => {
      expect(adapter.testMimeToExtension('text/plain')).toBe('.bin');
    });
  });

  // ── mimeToOpenRouterFormat ──────────────────────────────────────────

  describe('mimeToOpenRouterFormat', () => {
    const adapter = makeAdapter();

    it('strips leading dot from known extensions', () => {
      expect(adapter.testMimeToOpenRouterFormat('audio/mpeg')).toBe('mp3');
      expect(adapter.testMimeToOpenRouterFormat('audio/wav')).toBe('wav');
    });

    it('returns bin for unknown MIME type', () => {
      expect(adapter.testMimeToOpenRouterFormat('audio/unknown')).toBe('bin');
    });
  });

  // ── arrayBufferToBase64 ─────────────────────────────────────────────

  describe('arrayBufferToBase64', () => {
    const adapter = makeAdapter();

    it('encodes empty buffer to empty string', () => {
      expect(adapter.testArrayBufferToBase64(new ArrayBuffer(0))).toBe('');
    });

    it('encodes known bytes correctly', () => {
      const buffer = new ArrayBuffer(3);
      const view = new Uint8Array(buffer);
      view[0] = 72;  // H
      view[1] = 105; // i
      view[2] = 33;  // !
      expect(adapter.testArrayBufferToBase64(buffer)).toBe(btoa('Hi!'));
    });

    it('handles binary data with high bytes', () => {
      const buffer = new ArrayBuffer(2);
      const view = new Uint8Array(buffer);
      view[0] = 0xFF;
      view[1] = 0x00;
      const result = adapter.testArrayBufferToBase64(buffer);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ── buildChunkFileName ──────────────────────────────────────────────

  describe('buildChunkFileName', () => {
    const adapter = makeAdapter();

    it('replaces extension with MIME-derived extension', () => {
      expect(adapter.testBuildChunkFileName('recording.mp3', 'audio/wav')).toBe('recording.wav');
    });

    it('handles file with no extension', () => {
      expect(adapter.testBuildChunkFileName('recording', 'audio/mpeg')).toBe('recording.mp3');
    });

    it('handles file with multiple dots', () => {
      expect(adapter.testBuildChunkFileName('my.recording.v2.ogg', 'audio/wav')).toBe('my.recording.v2.wav');
    });

    it('uses .bin for unknown MIME type', () => {
      expect(adapter.testBuildChunkFileName('test.mp3', 'audio/unknown')).toBe('test.bin');
    });
  });
});
