/**
 * AudioEncoder — Format encoding for AudioBuffer to WAV/WebM/MP3.
 *
 * Located at: src/agents/apps/composer/services/AudioEncoder.ts
 * Three encoding paths:
 * - WAV: Direct PCM construction (zero deps, 44-byte header + interleaved Int16)
 * - WebM/Opus: MediaRecorder API (Chromium-native, zero deps, real-time speed)
 * - MP3: wasm-media-encoders (MIT, ~200KB WASM, dynamic import for tree-shaking)
 *
 * Design decisions:
 * - WAV is synchronous PCM construction — fastest, lossless, largest files.
 * - WebM uses real-time AudioContext + MediaRecorder because MediaRecorder
 *   requires a live MediaStream. Encoding time equals audio duration.
 * - MP3 uses dynamic import() so WASM is only loaded when MP3 is requested,
 *   enabling tree-shaking for the common WAV case.
 * - MP3 encoder supports 1-2 channels only. Buffers with >2 channels are
 *   downmixed to stereo before encoding.
 *
 * Used by: AudioComposer after mixing/concatenation to produce final output.
 */

import { AudioOutputFormat, ComposerError } from '../types';

export class AudioEncoder {
  /**
   * Encode an AudioBuffer to the specified format.
   *
   * @returns Uint8Array of encoded audio data
   */
  async encode(buffer: AudioBuffer, format: AudioOutputFormat): Promise<Uint8Array> {
    switch (format) {
      case 'wav':
        return this.encodeWav(buffer);
      case 'webm':
        return this.encodeWebm(buffer);
      case 'mp3':
        return this.encodeMp3(buffer);
      default:
        throw new ComposerError(`Unsupported audio output format: ${format}`);
    }
  }

  /**
   * WAV encoding — direct PCM from AudioBuffer.
   * Zero dependencies. Constructs WAV header + interleaved 16-bit PCM data.
   */
  private encodeWav(buffer: AudioBuffer): Uint8Array {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataLength = buffer.length * blockAlign;
    const headerLength = 44;
    const totalLength = headerLength + dataLength;

    const output = new ArrayBuffer(totalLength);
    const view = new DataView(output);

    // "RIFF" chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, totalLength - 8, true);
    writeString(view, 8, 'WAVE');

    // "fmt " sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);                     // sub-chunk size (PCM = 16)
    view.setUint16(20, 1, true);                      // audio format (1 = PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); // byte rate
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // "data" sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // Interleaved PCM samples
    let offset = headerLength;
    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = buffer.getChannelData(ch)[i];
        const clamped = Math.max(-1, Math.min(1, sample));
        const int16 = clamped < 0
          ? clamped * 0x8000
          : clamped * 0x7FFF;
        view.setInt16(offset, int16, true);
        offset += bytesPerSample;
      }
    }

    return new Uint8Array(output);
  }

  /**
   * WebM/Opus encoding via MediaRecorder API.
   * Available natively in Chromium/Electron — zero extra dependencies.
   * Note: Encoding time equals audio duration (real-time playback required).
   */
  private async encodeWebm(buffer: AudioBuffer): Promise<Uint8Array> {
    const audioCtx = new AudioContext({ sampleRate: buffer.sampleRate });

    try {
      const dest = audioCtx.createMediaStreamDestination();
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(dest);

      const recorder = new MediaRecorder(dest.stream, {
        mimeType: 'audio/webm;codecs=opus',
      });

      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      return new Promise<Uint8Array>((resolve, reject) => {
        recorder.onstop = async () => {
          try {
            const blob = new Blob(chunks, { type: 'audio/webm;codecs=opus' });
            const arrayBuffer = await blob.arrayBuffer();
            resolve(new Uint8Array(arrayBuffer));
          } catch (err) {
            reject(new ComposerError(`WebM encoding post-processing failed: ${err}`));
          }
        };

        recorder.onerror = () => {
          reject(new ComposerError('WebM encoding failed'));
        };

        recorder.start();
        source.start(0);

        // Stop recording when buffer playback completes
        source.onended = () => {
          recorder.stop();
        };
      });
    } finally {
      audioCtx.close();
    }
  }

  /**
   * MP3 encoding via wasm-media-encoders.
   * MIT-licensed WASM module, ~200KB. Dynamic import for tree-shaking.
   */
  private async encodeMp3(buffer: AudioBuffer): Promise<Uint8Array> {
    const { createMp3Encoder } = await import('wasm-media-encoders');
    const encoder = await createMp3Encoder();

    // wasm-media-encoders supports 1 or 2 channels only
    let targetBuffer = buffer;
    if (buffer.numberOfChannels > 2) {
      targetBuffer = downmixToStereo(buffer);
    }

    encoder.configure({
      sampleRate: targetBuffer.sampleRate,
      channels: targetBuffer.numberOfChannels as 1 | 2,
      vbrQuality: 2, // High quality VBR (~190kbps)
    });

    const channelData = getChannelDataArrays(targetBuffer);
    const encoded = encoder.encode(channelData);
    const flushed = encoder.finalize();

    // Concatenate encoded + flushed
    const result = new Uint8Array(encoded.length + flushed.length);
    result.set(encoded, 0);
    result.set(flushed, encoded.length);

    return result;
  }
}

/** Write an ASCII string into a DataView at the given offset. */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** Extract per-channel Float32Array data from an AudioBuffer. */
function getChannelDataArrays(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }
  return channels;
}

/**
 * Downmix a multi-channel AudioBuffer to stereo (2 channels).
 * Averages all channels into L/R by splitting odd/even or averaging all.
 */
function downmixToStereo(buffer: AudioBuffer): AudioBuffer {
  const ctx = new OfflineAudioContext(2, buffer.length, buffer.sampleRate);
  const newBuffer = ctx.createBuffer(2, buffer.length, buffer.sampleRate);

  const leftData = newBuffer.getChannelData(0);
  const rightData = newBuffer.getChannelData(1);
  const numChannels = buffer.numberOfChannels;

  for (let i = 0; i < buffer.length; i++) {
    let left = 0;
    let right = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = buffer.getChannelData(ch)[i];
      if (ch % 2 === 0) {
        left += sample;
      } else {
        right += sample;
      }
    }
    const leftCount = Math.ceil(numChannels / 2);
    const rightCount = Math.floor(numChannels / 2);
    leftData[i] = left / leftCount;
    rightData[i] = rightCount > 0 ? right / rightCount : left / leftCount;
  }

  return newBuffer;
}
