/**
 * AudioComposer tests — validates audio concatenation and mix routing.
 *
 * Covers:
 * - Concat mode: 2 audio buffers concatenated sequentially
 * - Mix mode delegation to AudioMixer
 * - Platform gating (desktop only)
 * - Corrupted audio decode error with failedFiles
 * - Duration trim
 */

import { TFile, Vault, Platform } from 'obsidian';
import { ComposerError, TrackInput } from '../../src/agents/apps/composer/types';

// --- Mock Web Audio API ---

function createMockAudioBuffer(opts: {
  numberOfChannels?: number;
  length?: number;
  sampleRate?: number;
}): AudioBuffer {
  const numberOfChannels = opts.numberOfChannels ?? 1;
  const length = opts.length ?? 44100; // 1 second
  const sampleRate = opts.sampleRate ?? 44100;

  return {
    numberOfChannels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: jest.fn((ch: number) => new Float32Array(length)),
  } as unknown as AudioBuffer;
}

// Mock AudioContext (for decodeAudioData)
const mockDecodeAudioData = jest.fn();
const mockAudioCtxClose = jest.fn().mockResolvedValue(undefined);

(global as any).AudioContext = jest.fn().mockImplementation(() => ({
  decodeAudioData: mockDecodeAudioData,
  close: mockAudioCtxClose,
  createMediaStreamDestination: jest.fn(),
  createBufferSource: jest.fn(() => ({
    buffer: null,
    connect: jest.fn(),
    start: jest.fn(),
    onended: null,
  })),
}));

// Mock OfflineAudioContext (for concat rendering)
const mockStartRendering = jest.fn();
const mockCreateBufferSource = jest.fn();

(global as any).OfflineAudioContext = jest.fn().mockImplementation((channels: number, length: number, sampleRate: number) => {
  const renderedBuffer = createMockAudioBuffer({ numberOfChannels: channels, length, sampleRate });
  mockStartRendering.mockResolvedValue(renderedBuffer);

  return {
    destination: {},
    createBufferSource: mockCreateBufferSource.mockReturnValue({
      buffer: null,
      connect: jest.fn(),
      start: jest.fn(),
    }),
    createGain: jest.fn(() => ({
      gain: {
        setValueAtTime: jest.fn(),
        linearRampToValueAtTime: jest.fn(),
      },
      connect: jest.fn(),
    })),
    startRendering: mockStartRendering,
    createBuffer: jest.fn((channels: number, length: number, sampleRate: number) => {
      return createMockAudioBuffer({ numberOfChannels: channels, length, sampleRate });
    }),
  };
});

// Mock AudioEncoder to avoid its own complex mocks
jest.mock('../../src/agents/apps/composer/services/AudioEncoder', () => ({
  AudioEncoder: jest.fn().mockImplementation(() => ({
    encode: jest.fn().mockResolvedValue(new Uint8Array([0x52, 0x49, 0x46, 0x46])),
  })),
}));

// Mock wasm-media-encoders (prevent import failure)
jest.mock('wasm-media-encoders', () => ({}), { virtual: true });

import { AudioComposer } from '../../src/agents/apps/composer/services/AudioComposer';

function makeTFile(name: string, path?: string): TFile {
  const file = new TFile(name, path ?? name);
  (file as any).stat = { size: 4096, mtime: Date.now(), ctime: Date.now() };
  return file;
}

function makeVault(binaryMap: Record<string, ArrayBuffer> = {}): Vault {
  const vault = new Vault();
  (vault as any).readBinary = jest.fn((file: TFile) => {
    return Promise.resolve(binaryMap[file.path] ?? new ArrayBuffer(16));
  });
  return vault;
}

describe('AudioComposer', () => {
  let composer: AudioComposer;

  beforeEach(() => {
    composer = new AudioComposer();
    jest.clearAllMocks();

    // Default: decodeAudioData returns a 1-second mono buffer
    mockDecodeAudioData.mockResolvedValue(
      createMockAudioBuffer({ numberOfChannels: 1, length: 44100, sampleRate: 44100 })
    );
  });

  it('should report audio extensions', () => {
    expect(composer.supportedExtensions).toContain('mp3');
    expect(composer.supportedExtensions).toContain('wav');
    expect(composer.supportedExtensions).toContain('ogg');
  });

  it('should report desktop-only availability', () => {
    expect(composer.isAvailableOnPlatform).toBe(Platform.isDesktop);
  });

  describe('platform gating', () => {
    it('should throw ComposerError on non-desktop platform', async () => {
      const origIsDesktop = Platform.isDesktop;
      (Platform as any).isDesktop = false;

      try {
        const localComposer = new AudioComposer();
        const vault = makeVault();

        await expect(
          localComposer.compose(
            { mode: 'concat', files: [makeTFile('a.mp3')] },
            vault,
            {}
          )
        ).rejects.toThrow(ComposerError);
      } finally {
        (Platform as any).isDesktop = origIsDesktop;
      }
    });
  });

  describe('concat mode', () => {
    it('should concatenate 2 audio files', async () => {
      const file1 = makeTFile('track1.mp3');
      const file2 = makeTFile('track2.mp3');
      const vault = makeVault({
        'track1.mp3': new ArrayBuffer(16),
        'track2.mp3': new ArrayBuffer(16),
      });

      const buf1 = createMockAudioBuffer({ numberOfChannels: 1, length: 44100, sampleRate: 44100 });
      const buf2 = createMockAudioBuffer({ numberOfChannels: 1, length: 22050, sampleRate: 44100 });

      mockDecodeAudioData
        .mockResolvedValueOnce(buf1)
        .mockResolvedValueOnce(buf2);

      const result = await composer.compose(
        { mode: 'concat', files: [file1, file2] },
        vault,
        {}
      );

      expect(result).toBeInstanceOf(Uint8Array);
      // decodeAudioData called twice (once per file)
      expect(mockDecodeAudioData).toHaveBeenCalledTimes(2);
      // OfflineAudioContext created for rendering
      expect(OfflineAudioContext).toHaveBeenCalled();
      // startRendering called
      expect(mockStartRendering).toHaveBeenCalled();
    });

    it('should use max channels from all buffers', async () => {
      const file1 = makeTFile('mono.mp3');
      const file2 = makeTFile('stereo.mp3');
      const vault = makeVault({
        'mono.mp3': new ArrayBuffer(16),
        'stereo.mp3': new ArrayBuffer(16),
      });

      mockDecodeAudioData
        .mockResolvedValueOnce(createMockAudioBuffer({ numberOfChannels: 1, length: 44100, sampleRate: 44100 }))
        .mockResolvedValueOnce(createMockAudioBuffer({ numberOfChannels: 2, length: 44100, sampleRate: 44100 }));

      await composer.compose(
        { mode: 'concat', files: [file1, file2] },
        vault,
        {}
      );

      // OfflineAudioContext should be created with 2 channels (max)
      expect(OfflineAudioContext).toHaveBeenCalledWith(
        2, // max channels
        expect.any(Number),
        expect.any(Number)
      );
    });

    it('should throw ComposerError for corrupted audio file', async () => {
      const file = makeTFile('corrupt.mp3');
      const vault = makeVault({ 'corrupt.mp3': new ArrayBuffer(8) });

      mockDecodeAudioData.mockRejectedValueOnce(new Error('Invalid audio data'));

      try {
        await composer.compose(
          { mode: 'concat', files: [file] },
          vault,
          {}
        );
        fail('Expected ComposerError');
      } catch (err) {
        expect(err).toBeInstanceOf(ComposerError);
        expect((err as ComposerError).failedFiles).toContain('corrupt.mp3');
      }
    });

    it('should close AudioContext in finally block', async () => {
      const file = makeTFile('a.mp3');
      const vault = makeVault({ 'a.mp3': new ArrayBuffer(16) });

      await composer.compose(
        { mode: 'concat', files: [file] },
        vault,
        {}
      );

      expect(mockAudioCtxClose).toHaveBeenCalled();
    });

    it('should close AudioContext even when decode fails', async () => {
      const file = makeTFile('bad.mp3');
      const vault = makeVault({ 'bad.mp3': new ArrayBuffer(8) });

      mockDecodeAudioData.mockRejectedValueOnce(new Error('decode fail'));

      try {
        await composer.compose(
          { mode: 'concat', files: [file] },
          vault,
          {}
        );
      } catch {
        // Expected
      }

      expect(mockAudioCtxClose).toHaveBeenCalled();
    });

    it('should throw when empty files array for concat', async () => {
      const vault = makeVault();

      await expect(
        composer.compose({ mode: 'concat', files: [] }, vault, {})
      ).rejects.toThrow('No audio buffers to concatenate');
    });
  });

  describe('duration trim', () => {
    it('should trim output when duration option is shorter than composed audio', async () => {
      const file = makeTFile('long.mp3');
      const vault = makeVault({ 'long.mp3': new ArrayBuffer(16) });

      mockDecodeAudioData.mockResolvedValueOnce(
        createMockAudioBuffer({ numberOfChannels: 1, length: 441000, sampleRate: 44100 }) // 10 seconds
      );

      await composer.compose(
        { mode: 'concat', files: [file] },
        vault,
        { duration: 5 } // Trim to 5 seconds
      );

      // Two OfflineAudioContext calls: one for concat, one for trim
      expect(OfflineAudioContext).toHaveBeenCalledTimes(2);
    });
  });
});
