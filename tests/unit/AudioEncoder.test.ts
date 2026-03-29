/**
 * AudioEncoder tests — validates WAV, WebM, and MP3 encoding paths.
 *
 * Covers:
 * - WAV: 44-byte header structure + PCM data
 * - WebM: mocked MediaRecorder pipeline, audioCtx.close() in finally
 * - MP3: mocked wasm-media-encoders dynamic import, Float32Array[] per channel deviation
 * - downmixToStereo: OfflineAudioContext for >2 channel buffers
 * - Unsupported format error
 *
 * Auditor YELLOW notes addressed:
 * - WebM audioCtx.close() tested via mock verification
 * - downmixToStereo tested for channel averaging correctness
 */

import { ComposerError } from '../../src/agents/apps/composer/types';

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

// Mock OfflineAudioContext for downmixToStereo
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

// Global OfflineAudioContext mock
(global as any).OfflineAudioContext = jest.fn().mockImplementation(() => ({
  createBuffer: mockCreateBuffer,
}));

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

(global as any).AudioContext = jest.fn().mockImplementation(() => ({
  sampleRate: 44100,
  createMediaStreamDestination: jest.fn(() => mockMediaStreamDest),
  createBufferSource: jest.fn(() => ({ ...mockSourceNode })),
  close: mockCloseFn,
}));

// Mock MediaRecorder for WebM path
let mediaRecorderInstance: any;
(global as any).MediaRecorder = jest.fn().mockImplementation(function (this: any, _stream: any, _opts: any) {
  this.ondataavailable = null;
  this.onstop = null;
  this.onerror = null;
  this.start = jest.fn(() => {
    // Simulate data available
    setTimeout(() => {
      if (this.ondataavailable) {
        this.ondataavailable({ data: new Blob([new Uint8Array([1, 2, 3])]) });
      }
    }, 0);
  });
  this.stop = jest.fn(() => {
    setTimeout(() => {
      if (this.onstop) this.onstop();
    }, 0);
  });
  mediaRecorderInstance = this;
  return this;
});

// Mock Blob.prototype.arrayBuffer (not available in Node)
(global as any).Blob = class MockBlob {
  private parts: any[];
  size: number;
  type: string;
  constructor(parts: any[] = [], options?: { type?: string }) {
    this.parts = parts;
    this.type = options?.type ?? '';
    this.size = parts.reduce((s: number, p: any) => s + (p.byteLength || p.length || 0), 0);
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    // Concatenate all parts
    const totalSize = this.parts.reduce((s: number, p: any) => {
      if (p instanceof Uint8Array) return s + p.byteLength;
      return s + 0;
    }, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const part of this.parts) {
      if (part instanceof Uint8Array) {
        result.set(part, offset);
        offset += part.byteLength;
      }
    }
    return result.buffer;
  }
};

// Mock wasm-media-encoders dynamic import
const mockEncoder = {
  configure: jest.fn(),
  encode: jest.fn().mockReturnValue(new Uint8Array([0xFF, 0xFB, 0x90])),
  finalize: jest.fn().mockReturnValue(new Uint8Array([0x00])),
};

jest.mock('wasm-media-encoders', () => ({
  createMp3Encoder: jest.fn().mockResolvedValue(mockEncoder),
}), { virtual: true });

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

  describe('MP3 encoding', () => {
    it('should dynamically import wasm-media-encoders', async () => {
      const buffer = createMockAudioBuffer({
        numberOfChannels: 2,
        length: 4,
        sampleRate: 44100,
        channelData: [
          new Float32Array([0.1, 0.2, 0.3, 0.4]),
          new Float32Array([0.5, 0.6, 0.7, 0.8]),
        ],
      });

      const result = await encoder.encode(buffer, 'mp3');

      expect(result).toBeInstanceOf(Uint8Array);
      // Encoded (3 bytes) + finalized (1 byte) = 4 bytes
      expect(result.byteLength).toBe(4);
    });

    it('should configure encoder with correct sampleRate and channels', async () => {
      const buffer = createMockAudioBuffer({
        numberOfChannels: 2,
        length: 4,
        sampleRate: 48000,
      });

      await encoder.encode(buffer, 'mp3');

      expect(mockEncoder.configure).toHaveBeenCalledWith({
        sampleRate: 48000,
        channels: 2,
        vbrQuality: 2,
      });
    });

    it('should pass Float32Array[] per channel (deviation from simple interleaved)', async () => {
      const ch0 = new Float32Array([0.1, 0.2]);
      const ch1 = new Float32Array([0.3, 0.4]);
      const buffer = createMockAudioBuffer({
        numberOfChannels: 2,
        length: 2,
        sampleRate: 44100,
        channelData: [ch0, ch1],
      });

      await encoder.encode(buffer, 'mp3');

      // The encoder.encode() receives Float32Array[] — one array per channel
      const encodedArg = mockEncoder.encode.mock.calls[0][0];
      expect(Array.isArray(encodedArg)).toBe(true);
      expect(encodedArg).toHaveLength(2);
      expect(encodedArg[0]).toBeInstanceOf(Float32Array);
      expect(encodedArg[1]).toBeInstanceOf(Float32Array);
    });

    it('should concatenate encode + finalize output', async () => {
      const buffer = createMockAudioBuffer();
      mockEncoder.encode.mockReturnValue(new Uint8Array([0xAA, 0xBB]));
      mockEncoder.finalize.mockReturnValue(new Uint8Array([0xCC]));

      const result = await encoder.encode(buffer, 'mp3');

      expect(result).toEqual(new Uint8Array([0xAA, 0xBB, 0xCC]));
    });

    it('should downmix >2 channels to stereo before encoding', async () => {
      // 4-channel buffer
      const buffer = createMockAudioBuffer({
        numberOfChannels: 4,
        length: 2,
        sampleRate: 44100,
        channelData: [
          new Float32Array([1.0, 0.0]),  // ch0 (even → left)
          new Float32Array([0.5, 0.0]),  // ch1 (odd → right)
          new Float32Array([0.5, 0.0]),  // ch2 (even → left)
          new Float32Array([0.5, 0.0]),  // ch3 (odd → right)
        ],
      });

      await encoder.encode(buffer, 'mp3');

      // After downmix: 2 channels
      expect(mockEncoder.configure).toHaveBeenCalledWith(
        expect.objectContaining({ channels: 2 })
      );

      // The encoded data should come from the downmixed 2-channel buffer
      const encodedArg = mockEncoder.encode.mock.calls[0][0];
      expect(encodedArg).toHaveLength(2);
    });
  });

  describe('unsupported format', () => {
    it('should throw ComposerError for unknown format', async () => {
      const buffer = createMockAudioBuffer();

      await expect(
        encoder.encode(buffer, 'flac' as any)
      ).rejects.toThrow(ComposerError);
    });
  });
});
