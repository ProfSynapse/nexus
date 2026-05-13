/**
 * AudioEncoder - Format encoding for AudioBuffer to WAV/WebM.
 *
 * Located at: src/agents/apps/composer/services/AudioEncoder.ts
 * Two encoding paths:
 * - WAV: Direct PCM construction (zero deps, 44-byte header + interleaved Int16)
 * - WebM/Opus: MediaRecorder API (Chromium-native, zero deps, real-time speed)
 *
 * Design decisions:
 * - WAV is synchronous PCM construction - fastest, lossless, largest files.
 * - WebM uses real-time AudioContext + MediaRecorder because MediaRecorder
 *   requires a live MediaStream. Encoding time equals audio duration.
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
      default:
        throw new ComposerError(`Unsupported audio output format: ${String(format)}`);
    }
  }

  /**
   * WAV encoding - direct PCM from AudioBuffer.
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
   * Available natively in Chromium/Electron - zero extra dependencies.
   * Note: Encoding time equals audio duration (real-time playback required).
   */
  private async encodeWebm(buffer: AudioBuffer): Promise<Uint8Array> {
    const audioCtx = new AudioContext({ sampleRate: buffer.sampleRate });

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
        } catch (err: unknown) {
          reject(new ComposerError(`WebM encoding post-processing failed: ${err instanceof Error ? err.message : String(err)}`));
        } finally {
          void audioCtx.close();
        }
      };

      recorder.onerror = () => {
        void audioCtx.close();
        reject(new ComposerError('WebM encoding failed'));
      };

      recorder.start();
      source.start(0);

      // Stop recording when buffer playback completes
      source.onended = () => {
        recorder.stop();
      };
    });
  }

}

/** Write an ASCII string into a DataView at the given offset. */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
