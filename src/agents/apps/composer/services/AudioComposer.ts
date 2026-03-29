/**
 * AudioComposer — Audio composition via OfflineAudioContext.
 *
 * Located at: src/agents/apps/composer/services/AudioComposer.ts
 * Handles both concat (sequential) and mix (layered) modes. Concat mode
 * decodes files and renders them sequentially via OfflineAudioContext.
 * Mix mode delegates to AudioMixer for per-track volume/offset/fade control.
 * Desktop-only (requires OfflineAudioContext + MediaRecorder).
 * Implements IFormatComposer.
 *
 * Used by: compose.ts tool when format='audio'.
 */

import { TFile, Vault, Platform } from 'obsidian';
import {
  IFormatComposer,
  ComposeInput,
  ComposeOptions,
  ComposerError,
  AudioOutputFormat,
} from '../types';
import { AudioMixer } from './AudioMixer';
import { AudioEncoder } from './AudioEncoder';

export class AudioComposer implements IFormatComposer {
  readonly supportedExtensions = ['mp3', 'wav', 'ogg', 'webm', 'aac', 'm4a', 'flac'];

  get isAvailableOnPlatform(): boolean {
    return Platform.isDesktop;
  }

  async compose(
    input: ComposeInput,
    vault: Vault,
    options: ComposeOptions
  ): Promise<Uint8Array> {
    if (!this.isAvailableOnPlatform) {
      throw new ComposerError('Audio composition requires desktop (Electron) platform');
    }

    const outputFormat: AudioOutputFormat = options.outputFormat ?? 'wav';
    let audioBuffer: AudioBuffer;

    if (input.mode === 'mix') {
      const mixer = new AudioMixer();
      audioBuffer = await mixer.mix(input.tracks, vault);
    } else {
      audioBuffer = await this.concat(input.files, vault);
    }

    // Apply optional duration trim
    if (options.duration !== undefined && options.duration < audioBuffer.duration) {
      audioBuffer = await trimAudioBuffer(audioBuffer, options.duration);
    }

    const encoder = new AudioEncoder();
    return encoder.encode(audioBuffer, outputFormat);
  }

  /**
   * Concatenate audio files sequentially.
   * Decodes each file, computes total duration, renders via OfflineAudioContext.
   */
  private async concat(files: TFile[], vault: Vault): Promise<AudioBuffer> {
    const audioContext = new AudioContext();
    const decodedBuffers: AudioBuffer[] = [];

    try {
      for (const file of files) {
        const arrayBuffer = await vault.readBinary(file);
        try {
          // .slice(0) creates a copy because decodeAudioData detaches the ArrayBuffer
          const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
          decodedBuffers.push(decoded);
        } catch (err) {
          throw new ComposerError(
            `Failed to decode audio: ${file.path} — file may be corrupted or use unsupported codec`,
            [file.path]
          );
        }
      }
    } finally {
      audioContext.close();
    }

    if (decodedBuffers.length === 0) {
      throw new ComposerError('No audio buffers to concatenate');
    }

    const sampleRate = decodedBuffers[0].sampleRate;
    const mismatchedFiles = files.filter((_, i) => decodedBuffers[i].sampleRate !== sampleRate);
    if (mismatchedFiles.length > 0) {
      throw new ComposerError(
        `Sample rate mismatch: first file is ${sampleRate}Hz but ${mismatchedFiles.length} file(s) differ. ` +
        `All audio files must share the same sample rate for concatenation.`,
        mismatchedFiles.map(f => f.path)
      );
    }
    const numberOfChannels = Math.max(...decodedBuffers.map(b => b.numberOfChannels));
    const totalLength = decodedBuffers.reduce((sum, b) => sum + b.length, 0);

    const offlineCtx = new OfflineAudioContext(
      numberOfChannels,
      totalLength,
      sampleRate
    );

    let currentOffset = 0;
    for (const buffer of decodedBuffers) {
      const source = offlineCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(offlineCtx.destination);
      source.start(currentOffset / sampleRate);
      currentOffset += buffer.length;
    }

    return offlineCtx.startRendering();
  }
}

/**
 * Trim an AudioBuffer to a specified duration in seconds.
 * Uses OfflineAudioContext to render only the desired portion.
 */
async function trimAudioBuffer(buffer: AudioBuffer, durationSeconds: number): Promise<AudioBuffer> {
  const sampleCount = Math.min(
    Math.floor(durationSeconds * buffer.sampleRate),
    buffer.length
  );

  const offlineCtx = new OfflineAudioContext(
    buffer.numberOfChannels,
    sampleCount,
    buffer.sampleRate
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  return offlineCtx.startRendering();
}
