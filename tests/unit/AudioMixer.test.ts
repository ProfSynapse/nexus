/**
 * AudioMixer tests — validates multi-track mixing with per-track controls.
 *
 * Covers:
 * - 2-track mixing with volume, offset, fadeIn, fadeOut
 * - GainNode per track wiring
 * - Empty tracks error
 * - Corrupted track error with failedFiles
 * - AudioContext cleanup in finally block
 */

import { Vault, TFile } from 'obsidian';
import { ComposerError, TrackInput } from '../../src/agents/apps/composer/types';

// --- Mock Web Audio API ---

function createMockAudioBuffer(opts: {
  numberOfChannels?: number;
  length?: number;
  sampleRate?: number;
}): AudioBuffer {
  const numberOfChannels = opts.numberOfChannels ?? 1;
  const length = opts.length ?? 44100;
  const sampleRate = opts.sampleRate ?? 44100;

  return {
    numberOfChannels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: jest.fn((ch: number) => new Float32Array(length)),
  } as unknown as AudioBuffer;
}

const mockDecodeAudioData = jest.fn();
const mockAudioCtxClose = jest.fn().mockResolvedValue(undefined);

(global as any).AudioContext = jest.fn().mockImplementation(() => ({
  decodeAudioData: mockDecodeAudioData,
  close: mockAudioCtxClose,
}));

const mockGainSetValueAtTime = jest.fn();
const mockGainLinearRamp = jest.fn();
const mockGainConnect = jest.fn();
const mockSourceConnect = jest.fn();
const mockSourceStart = jest.fn();
const mockStartRendering = jest.fn();

(global as any).OfflineAudioContext = jest.fn().mockImplementation((channels: number, length: number, sampleRate: number) => {
  const renderedBuffer = createMockAudioBuffer({ numberOfChannels: channels, length, sampleRate });
  mockStartRendering.mockResolvedValue(renderedBuffer);

  return {
    destination: {},
    createBufferSource: jest.fn(() => ({
      buffer: null,
      connect: mockSourceConnect,
      start: mockSourceStart,
    })),
    createGain: jest.fn(() => ({
      gain: {
        setValueAtTime: mockGainSetValueAtTime,
        linearRampToValueAtTime: mockGainLinearRamp,
      },
      connect: mockGainConnect,
    })),
    startRendering: mockStartRendering,
  };
});

import { AudioMixer } from '../../src/agents/apps/composer/services/AudioMixer';

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

function makeTrack(file: TFile, overrides?: Partial<TrackInput>): TrackInput {
  return {
    file,
    volume: 1.0,
    offset: 0,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  };
}

describe('AudioMixer', () => {
  let mixer: AudioMixer;

  beforeEach(() => {
    mixer = new AudioMixer();
    jest.clearAllMocks();

    mockDecodeAudioData.mockResolvedValue(
      createMockAudioBuffer({ numberOfChannels: 2, length: 44100, sampleRate: 44100 })
    );
  });

  it('should throw ComposerError for empty tracks', async () => {
    const vault = makeVault();

    await expect(
      mixer.mix([], vault)
    ).rejects.toThrow(ComposerError);
  });

  it('should mix 2 tracks with volume control', async () => {
    const file1 = makeTFile('vocals.mp3');
    const file2 = makeTFile('music.mp3');
    const vault = makeVault({
      'vocals.mp3': new ArrayBuffer(16),
      'music.mp3': new ArrayBuffer(16),
    });

    const tracks: TrackInput[] = [
      makeTrack(file1, { volume: 0.8 }),
      makeTrack(file2, { volume: 0.5 }),
    ];

    const result = await mixer.mix(tracks, vault);

    expect(result).toBeDefined();
    expect(mockDecodeAudioData).toHaveBeenCalledTimes(2);
    // Two GainNode setValueAtTime calls (one per track)
    expect(mockGainSetValueAtTime).toHaveBeenCalledWith(0.8, 0);
    expect(mockGainSetValueAtTime).toHaveBeenCalledWith(0.5, 0);
    // Source connected to GainNode
    expect(mockSourceConnect).toHaveBeenCalledTimes(2);
    // GainNode connected to destination
    expect(mockGainConnect).toHaveBeenCalledTimes(2);
  });

  it('should apply track offset', async () => {
    const file = makeTFile('delayed.mp3');
    const vault = makeVault({ 'delayed.mp3': new ArrayBuffer(16) });

    const tracks: TrackInput[] = [
      makeTrack(file, { offset: 2.5 }),
    ];

    await mixer.mix(tracks, vault);

    // Source should start at offset time
    expect(mockSourceStart).toHaveBeenCalledWith(2.5);
  });

  it('should apply fade-in using linearRampToValueAtTime', async () => {
    const file = makeTFile('fade.mp3');
    const vault = makeVault({ 'fade.mp3': new ArrayBuffer(16) });

    const tracks: TrackInput[] = [
      makeTrack(file, { volume: 0.8, fadeIn: 1.5 }),
    ];

    await mixer.mix(tracks, vault);

    // Fade-in: gain starts at 0 at offset, ramps to volume over fadeIn duration
    expect(mockGainSetValueAtTime).toHaveBeenCalledWith(0, 0); // start at 0
    expect(mockGainLinearRamp).toHaveBeenCalledWith(0.8, 1.5); // ramp to 0.8 over 1.5s
  });

  it('should apply fade-out using linearRampToValueAtTime', async () => {
    const file = makeTFile('fadeout.mp3');
    const vault = makeVault({ 'fadeout.mp3': new ArrayBuffer(16) });

    // 1 second buffer, fadeOut 0.5s → fadeOutStart = 1.0 - 0.5 = 0.5
    mockDecodeAudioData.mockResolvedValueOnce(
      createMockAudioBuffer({ numberOfChannels: 1, length: 44100, sampleRate: 44100 }) // 1s
    );

    const tracks: TrackInput[] = [
      makeTrack(file, { volume: 1.0, fadeOut: 0.5 }),
    ];

    await mixer.mix(tracks, vault);

    // Fade-out: at (duration - fadeOut), set volume; at duration, ramp to 0
    expect(mockGainSetValueAtTime).toHaveBeenCalledWith(1.0, 0.5); // hold at fadeOutStart
    expect(mockGainLinearRamp).toHaveBeenCalledWith(0, 1.0); // ramp to 0 at end
  });

  it('should compute total duration from tracks with offsets', async () => {
    const file1 = makeTFile('a.mp3');
    const file2 = makeTFile('b.mp3');
    const vault = makeVault({
      'a.mp3': new ArrayBuffer(16),
      'b.mp3': new ArrayBuffer(16),
    });

    // file1: 1s at offset 0 → ends at 1s
    // file2: 1s at offset 3 → ends at 4s
    mockDecodeAudioData
      .mockResolvedValueOnce(createMockAudioBuffer({ numberOfChannels: 1, length: 44100, sampleRate: 44100 }))
      .mockResolvedValueOnce(createMockAudioBuffer({ numberOfChannels: 1, length: 44100, sampleRate: 44100 }));

    const tracks: TrackInput[] = [
      makeTrack(file1, { offset: 0 }),
      makeTrack(file2, { offset: 3 }),
    ];

    await mixer.mix(tracks, vault);

    // Total duration = max(0+1, 3+1) = 4 seconds → 4*44100 = 176400 samples
    expect(OfflineAudioContext).toHaveBeenCalledWith(
      expect.any(Number),
      Math.ceil(4 * 44100),
      44100
    );
  });

  it('should throw ComposerError for corrupted track', async () => {
    const file = makeTFile('corrupt.mp3');
    const vault = makeVault({ 'corrupt.mp3': new ArrayBuffer(8) });

    mockDecodeAudioData.mockRejectedValueOnce(new Error('Invalid data'));

    try {
      await mixer.mix([makeTrack(file)], vault);
      fail('Expected ComposerError');
    } catch (err) {
      expect(err).toBeInstanceOf(ComposerError);
      expect((err as ComposerError).failedFiles).toContain('corrupt.mp3');
    }
  });

  it('should close AudioContext in finally block', async () => {
    const file = makeTFile('a.mp3');
    const vault = makeVault({ 'a.mp3': new ArrayBuffer(16) });

    await mixer.mix([makeTrack(file)], vault);

    expect(mockAudioCtxClose).toHaveBeenCalled();
  });

  it('should close AudioContext even when decode fails', async () => {
    const file = makeTFile('bad.mp3');
    const vault = makeVault({ 'bad.mp3': new ArrayBuffer(8) });

    mockDecodeAudioData.mockRejectedValueOnce(new Error('fail'));

    try {
      await mixer.mix([makeTrack(file)], vault);
    } catch {
      // Expected
    }

    expect(mockAudioCtxClose).toHaveBeenCalled();
  });

  it('should use max channels from all tracks', async () => {
    const file1 = makeTFile('mono.mp3');
    const file2 = makeTFile('stereo.mp3');
    const vault = makeVault({
      'mono.mp3': new ArrayBuffer(16),
      'stereo.mp3': new ArrayBuffer(16),
    });

    mockDecodeAudioData
      .mockResolvedValueOnce(createMockAudioBuffer({ numberOfChannels: 1, length: 44100, sampleRate: 44100 }))
      .mockResolvedValueOnce(createMockAudioBuffer({ numberOfChannels: 2, length: 44100, sampleRate: 44100 }));

    await mixer.mix(
      [makeTrack(file1), makeTrack(file2)],
      vault
    );

    // OfflineAudioContext should use max channels (2)
    expect(OfflineAudioContext).toHaveBeenCalledWith(
      2,
      expect.any(Number),
      expect.any(Number)
    );
  });
});
