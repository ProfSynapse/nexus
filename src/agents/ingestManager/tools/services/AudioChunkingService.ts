/**
 * Location: src/agents/ingestManager/tools/services/AudioChunkingService.ts
 * Purpose: Split audio files larger than 25MB into chunks for Whisper API.
 * Uses Web Audio API (OfflineAudioContext) for decoding, with a fallback
 * that returns the original buffer unsplit if decoding fails.
 *
 * Used by: TranscriptionService
 * Dependencies: Platform (Obsidian)
 *
 * IMPORTANT: This module MUST only be called on desktop (Platform.isDesktop).
 * OfflineAudioContext is not reliably available on mobile.
 */

import { Platform } from 'obsidian';
import { AudioChunk } from '../../types';

const MAX_CHUNK_SIZE_BYTES = 25 * 1024 * 1024; // 25MB Whisper limit
const TARGET_CHUNK_DURATION_SECONDS = 600; // 10 minutes per chunk

/**
 * Split an audio buffer into chunks suitable for the Whisper API.
 * If the file is under 25MB, returns a single chunk.
 * If decodeAudioData fails (Electron crash risk), returns the original file unsplit.
 */
export async function chunkAudio(
  audioData: ArrayBuffer,
  mimeType: string
): Promise<AudioChunk[]> {
  // If small enough, no chunking needed
  if (audioData.byteLength <= MAX_CHUNK_SIZE_BYTES) {
    return [{
      data: audioData,
      mimeType,
      startSeconds: 0,
      durationSeconds: 0, // Unknown without decoding
    }];
  }

  // Desktop guard — OfflineAudioContext requires desktop
  if (!Platform.isDesktop) {
    throw new Error(
      'Audio file exceeds 25MB limit. Audio chunking requires the desktop app. ' +
      'Please use a smaller file or switch to desktop.'
    );
  }

  // Try to decode and re-encode as WAV chunks
  try {
    return await decodeAndChunk(audioData, mimeType);
  } catch (error) {
    // decodeAudioData can crash in Electron with contextIsolation.
    // If the file exceeds the Whisper limit, we cannot send it unsplit.
    console.error('[AudioChunkingService] decodeAudioData failed:', error);
    if (audioData.byteLength > MAX_CHUNK_SIZE_BYTES) {
      const sizeMb = (audioData.byteLength / (1024 * 1024)).toFixed(1);
      throw new Error(
        `Audio file is ${sizeMb}MB (limit: 25MB) and chunking failed. ` +
        `Try converting to a smaller file or a different format (e.g. MP3).`
      );
    }
    // Under 25MB — safe to send unsplit even without chunking
    return [{
      data: audioData,
      mimeType,
      startSeconds: 0,
      durationSeconds: 0,
    }];
  }
}

/**
 * Decode audio data and split into WAV chunks at roughly TARGET_CHUNK_DURATION_SECONDS intervals.
 */
async function decodeAndChunk(
  audioData: ArrayBuffer,
  _mimeType: string
): Promise<AudioChunk[]> {
  // Create an AudioContext just for decoding
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

  // Calculate chunk boundaries
  const chunkDuration = TARGET_CHUNK_DURATION_SECONDS;
  const chunks: AudioChunk[] = [];
  let offset = 0;

  while (offset < totalDuration) {
    const duration = Math.min(chunkDuration, totalDuration - offset);
    const startSample = Math.floor(offset * sampleRate);
    const endSample = Math.min(
      Math.floor((offset + duration) * sampleRate),
      audioBuffer.length
    );
    const numSamples = endSample - startSample;

    // Extract channel data for this chunk
    const channelData: Float32Array[] = [];
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const fullChannel = audioBuffer.getChannelData(ch);
      channelData.push(fullChannel.slice(startSample, endSample));
    }

    // Encode as WAV
    const wavBuffer = encodeWav(channelData, sampleRate, numberOfChannels);

    chunks.push({
      data: wavBuffer,
      mimeType: 'audio/wav',
      startSeconds: offset,
      durationSeconds: duration,
    });

    offset += duration;
  }

  return chunks;
}

/**
 * Encode Float32Array channel data as a WAV file ArrayBuffer.
 */
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

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (PCM)
  view.setUint16(20, 1, true);  // AudioFormat (PCM)
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channel data and write as 16-bit PCM
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

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
