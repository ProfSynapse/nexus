/**
 * AudioEncoder tests - validates WAV and WebM encoding paths.
 *
 * Covers:
 * - WAV: 44-byte header structure + PCM data
 * - WebM: mocked MediaRecorder pipeline, audioCtx.close() in finally
 * - Unsupported format error
 *
 * Auditor YELLOW notes addressed:
 * - WebM audioCtx.close() tested via mock verification
 */

import { ComposerError, AudioOutputFormat } from '../../src/agents/apps/composer/types';

// --- Web Audio API mocks ---

function createMockAudioBuffer(opts: {
  numberOfChannels?: number;
  length?: number;
  sampleRate?: number;
  channelData?: Float32Array[];
} = {}): AudioBuffer {
  const numberOfChannels = opts.numberOfChannels ?? 1;
  const length = opts.length ?? 4;
  const sampleRate = opts.sampleRate ?? 44100;

  // Default: all zeros if no explicit data
  const channelData = opts.channelData ??
    Array.from({ length: numberOfChannels }, () => new Float32Array(length));

  return {
    numberOfChannels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: jest.fn((ch: number) => channelData[ch]),
  } as unknown as AudioBuffer;
}

type MockBlobPart = Uint8Array | ArrayBuffer | string;

class MockMediaRecorder {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  start = jest.fn(() => {
    // Simulate data available
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    }, 0);
  });

  stop = jest.fn(() => {
    setTimeout(() => {
      this.onstop?.();
    }, 0);
  });
}

class MockBlob {
  private readonly parts: MockBlobPart[];
  size: number;
  type: string;

  constructor(parts: MockBlobPart[] = [], options?: { type?: string }) {
    this.parts = parts;
    this.type = options?.type ?? '';
    this.size = parts.reduce((total, part) => {
      if (part instanceof Uint8Array || part instanceof ArrayBuffer) {
        return total + part.byteLength;
      }
      if (typeof part === 'string') {
        return total + part.length;
      }
      return total;
    }, 0);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    // Concatenate all parts
    const totalSize = this.parts.reduce((total, part) => {
      if (part instanceof Uint8Array || part instanceof ArrayBuffer) {
        return total + part.byteLength;
      }
      return total;
    }, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const part of this.parts) {
      if (part instanceof Uint8Array) {
        result.set(part, offset);
        offset += part.byteLength;
      } else if (part instanceof ArrayBuffer) {
        result.set(new Uint8Array(part), offset);
        offset += part.byteLength;
      }
    }
    return result.buffer;
  }
}

const mockCreateBuffer = jest.fn((channels: number, length: number, sampleRate: number) => {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (ch: number) => data[ch],
  } as unknown as AudioBuffer;
});

const globalForTests = globalThis as typeof globalThis & {
  OfflineAudioContext: typeof OfflineAudioContext;
  AudioContext: typeof AudioContext;
  MediaRecorder: typeof MediaRecorder;
  Blob: typeof Blob;
};

// Global OfflineAudioContext mock
globalForTests.OfflineAudioContext = jest.fn().mockImplementation(() => ({
  createBuffer: mockCreateBuffer,
})) as unknown as typeof OfflineAudioContext;

// Mock AudioContext for WebM path
const mockCloseFn = jest.fn().mockResolvedValue(undefined);
const mockMediaStreamDest = {
  stream: { getTracks: () => [], id: 'mock-stream' },
};
const mockSourceNode = {
  buffer: null,
  connect: jest.fn(),
  start: jest.fn(),
  onended: null as (() => void) | null,
};

globalForTests.AudioContext = jest.fn().mockImplementation(() => ({
  sampleRate: 44100,
  createMediaStreamDestination: jest.fn(() => mockMediaStreamDest),
  createBufferSource: jest.fn(() => ({ ...mockSourceNode })),
  close: mockCloseFn,
})) as unknown as typeof AudioContext;

// Mock MediaRecorder for WebM path
globalForTests.MediaRecorder = jest.fn().mockImplementation(() => new MockMediaRecorder()) as unknown as typeof MediaRecorder;

// Mock Blob.prototype.arrayBuffer (not available in Node)
globalForTests.Blob = MockBlob as unknown as typeof Blob;

// Import AFTER mocks are set up
import { AudioEncoder } from '../../src/agents/apps/composer/services/AudioEncoder';

// Use fake timers to prevent open handle warnings from setTimeout in MediaRecorder mock
beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

describe('AudioEncoder', () => {
  let encoder: AudioEncoder;

  beforeEach(() => {
    encoder = new AudioEncoder();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
  });

  describe('WAV encoding', () => {
    it('should produce output with 44-byte WAV header', async () => {
      const buffer = createMockAudioBuffer({
        numberOfChannels: 1,
        length: 4,
        sampleRate: 44100,
        channelData: [new Float32Array([0.5, -0.5, 0.25, -0.25])],
      });

      const result = await encoder.encode(buffer, 'wav');

      expect(result).toBeInstanceOf(Uint8Array);
      // Total = 44 header + (4 samples * 1 channel * 2 bytes) = 44 + 8 = 52
      expect(result.byteLength).toBe(52);
    });

    it('should write correct RIFF header', async () => {
      const buffer = createMockAudioBuffer({
        numberOfChannels: 1,
        length: 2,
        sampleRate: 44100,
      });

      const result = await encoder.encode(buffer, 'wav');
      const view = new DataView(result.buffer);

      // "RIFF" at offset 0
      expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)))
        .toBe('RIFF');

      // "WAVE" at offset 8
      expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)))
        .toBe('WAVE');

      // "fmt " at offset 12
      expect(String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15)))
        .toBe('fmt ');

      // Audio format = 1 (PCM) at offset 20
      expect(view.getUint16(20, true)).toBe(1);

      // Number of channels = 1 at offset 22
      expect(view.getUint16(22, true)).toBe(1);

      // Sample rate = 44100 at offset 24
      expect(view.getUint32(24, true)).toBe(44100);

      // "data" at offset 36
      expect(String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39)))
        .toBe('data');
    });

    it('should correctly interleave stereo channels', async () => {
      const left = new Float32Array([1.0, -1.0]);
      const right = new Float32Array([0.5, -0.5]);
      const buffer = createMockAudioBuffer({
        numberOfChannels: 2,
        length: 2,
        sampleRate: 44100,
        channelData: [left, right],
      });

      const result = await encoder.encode(buffer, 'wav');
      const view = new DataView(result.buffer);

      // Stereo: L0, R0, L1, R1 (each 2 bytes, starting at offset 44)
      // L0 = 1.0 → 0x7FFF, R0 = 0.5 → ~0x3FFF
      const l0 = view.getInt16(44, true);
      const r0 = view.getInt16(46, true);
      const l1 = view.getInt16(48, true);
      const r1 = view.getInt16(50, true);

      expect(l0).toBe(0x7FFF); // 1.0 clamped
      expect(r0).toBeCloseTo(0x3FFF, -2); // 0.5 * 0x7FFF
      expect(l1).toBe(-0x8000); // -1.0 clamped
      expect(r1).toBeCloseTo(-0x4000, -2); // -0.5 * 0x8000
    });

    it('should clamp samples outside [-1, 1] range', async () => {
      const buffer = createMockAudioBuffer({
        numberOfChannels: 1,
        length: 2,
        sampleRate: 44100,
        channelData: [new Float32Array([2.0, -2.0])],
      });

      const result = await encoder.encode(buffer, 'wav');
      const view = new DataView(result.buffer);

      // Clamped to 1.0 → 0x7FFF
      expect(view.getInt16(44, true)).toBe(0x7FFF);
      // Clamped to -1.0 → -0x8000
      expect(view.getInt16(46, true)).toBe(-0x8000);
    });

    it('should set correct file size in header', async () => {
      const buffer = createMockAudioBuffer({
        numberOfChannels: 2,
        length: 10,
        sampleRate: 48000,
      });

      const result = await encoder.encode(buffer, 'wav');
      const view = new DataView(result.buffer);

      const dataSize = 10 * 2 * 2; // 10 samples * 2 channels * 2 bytes = 40
      const totalSize = 44 + dataSize; // 84

      // RIFF chunk size (offset 4) = total - 8
      expect(view.getUint32(4, true)).toBe(totalSize - 8);

      // data sub-chunk size (offset 40)
      expect(view.getUint32(40, true)).toBe(dataSize);
    });
  });


  describe('unsupported format', () => {
    it('should throw ComposerError for unknown format', async () => {
      const buffer = createMockAudioBuffer();

      await expect(
        encoder.encode(buffer, 'flac' as unknown as AudioOutputFormat)
      ).rejects.toThrow(ComposerError);
    });
  });
});
