/**
 * Shared audio chunking utility for transcription workflows.
 *
 * Uses Web Audio API to split large files into WAV chunks that can be sent to
 * speech-to-text providers with upload limits.
 */

import { Platform } from 'obsidian';
import type { AudioChunk } from '../types/VoiceTypes';

const MAX_CHUNK_SIZE_BYTES = 25 * 1024 * 1024;
const TARGET_CHUNK_DURATION_SECONDS = 600;

/** Average bitrates (bytes per second) for estimating duration of single-chunk files */
const AVERAGE_BYTES_PER_SECOND: Record<string, number> = {
  'audio/mpeg': 16000,       // ~128 kbps MP3
  'audio/mp4': 16000,        // ~128 kbps AAC
  'audio/aac': 16000,        // ~128 kbps AAC
  'audio/ogg': 16000,        // ~128 kbps Vorbis/Opus
  'audio/opus': 8000,        // ~64 kbps Opus
  'audio/wav': 176400,       // 44.1kHz 16-bit stereo PCM
  'audio/flac': 88200,       // ~50% of WAV
  'audio/webm': 8000,        // ~64 kbps Opus in WebM
  'audio/x-ms-wma': 16000    // ~128 kbps WMA
};

export async function chunkAudio(
  audioData: ArrayBuffer,
  mimeType: string
): Promise<AudioChunk[]> {
  if (audioData.byteLength <= MAX_CHUNK_SIZE_BYTES) {
    return [{
      data: audioData,
      mimeType,
      startSeconds: 0,
      durationSeconds: estimateDuration(audioData.byteLength, mimeType)
    }];
  }

  if (!Platform.isDesktop) {
    throw new Error(
      'Audio file exceeds 25MB limit. Audio chunking requires the desktop app. ' +
      'Please use a smaller file or switch to desktop.'
    );
  }

  try {
    return await decodeAndChunk(audioData);
  } catch (error) {
    console.error('[AudioChunkingService] decodeAudioData failed:', error);

    if (audioData.byteLength > MAX_CHUNK_SIZE_BYTES) {
      const sizeMb = (audioData.byteLength / (1024 * 1024)).toFixed(1);
      throw new Error(
        `Audio file is ${sizeMb}MB (limit: 25MB) and chunking failed. ` +
        'Try converting to a smaller file or a different format (e.g. MP3).'
      );
    }

    return [{
      data: audioData,
      mimeType,
      startSeconds: 0,
      durationSeconds: estimateDuration(audioData.byteLength, mimeType)
    }];
  }
}

/**
 * Estimate audio duration from file size and mime type using average bitrates.
 * Returns a rough estimate — the actual duration from the provider response
 * will be more accurate, but this avoids returning 0 for single-chunk files.
 */
function estimateDuration(byteLength: number, mimeType: string): number {
  const bytesPerSecond = AVERAGE_BYTES_PER_SECOND[mimeType] ?? 16000;
  return Math.max(1, Math.round(byteLength / bytesPerSecond));
}

async function decodeAndChunk(audioData: ArrayBuffer): Promise<AudioChunk[]> {
  const audioCtx = new AudioContext();
  let audioBuffer: AudioBuffer;

  try {
    audioBuffer = await audioCtx.decodeAudioData(audioData.slice(0));
  } finally {
    await audioCtx.close();
  }

  const sampleRate = audioBuffer.sampleRate;
  const numberOfChannels = audioBuffer.numberOfChannels;
  const totalDuration = audioBuffer.duration;
  const chunks: AudioChunk[] = [];
  let offset = 0;

  while (offset < totalDuration) {
    const duration = Math.min(TARGET_CHUNK_DURATION_SECONDS, totalDuration - offset);
    const startSample = Math.floor(offset * sampleRate);
    const endSample = Math.min(
      Math.floor((offset + duration) * sampleRate),
      audioBuffer.length
    );

    const channelData: Float32Array[] = [];
    for (let ch = 0; ch < numberOfChannels; ch++) {
      channelData.push(audioBuffer.getChannelData(ch).slice(startSample, endSample));
    }

    chunks.push({
      data: encodeWav(channelData, sampleRate, numberOfChannels),
      mimeType: 'audio/wav',
      startSeconds: offset,
      durationSeconds: duration
    });

    offset += duration;
  }

  return chunks;
}

function encodeWav(
  channelData: Float32Array[],
  sampleRate: number,
  numberOfChannels: number
): ArrayBuffer {
  const numSamples = channelData[0].length;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numberOfChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let writeOffset = headerSize;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(writeOffset, intSample, true);
      writeOffset += 2;
    }
  }

  return buffer;
}

function writeString(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

