/**
 * AudioMixer — Multi-track audio mixing with per-track volume, offset, and fades.
 *
 * Located at: src/agents/apps/composer/services/AudioMixer.ts
 * Decodes audio files from vault, layers them via OfflineAudioContext with
 * individual GainNode per track for volume control and linearRampToValueAtTime
 * for fade-in/fade-out envelopes. Non-real-time rendering.
 *
 * Used by: AudioComposer when input mode is 'mix'.
 */

import { Vault } from 'obsidian';
import { TrackInput, ComposerError } from '../types';

export class AudioMixer {
  /**
   * Mix multiple audio tracks into a single AudioBuffer.
   *
   * Each track is:
   * 1. Decoded from vault binary
   * 2. Connected through a GainNode for volume control
   * 3. Positioned at its offset time
   * 4. Faded in/out via linearRampToValueAtTime
   *
   * @returns Mixed AudioBuffer at the sample rate of the first track
   */
  async mix(tracks: TrackInput[], vault: Vault): Promise<AudioBuffer> {
    if (tracks.length === 0) {
      throw new ComposerError('No tracks provided for mixing');
    }

    // Step 1: Decode all tracks
    const audioContext = new AudioContext();
    const decoded: Array<{ buffer: AudioBuffer; track: TrackInput }> = [];

    try {
      for (const track of tracks) {
        const arrayBuffer = await vault.readBinary(track.file);
        try {
          // .slice(0) creates a copy because decodeAudioData detaches the ArrayBuffer
          const buffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
          decoded.push({ buffer, track });
        } catch (err) {
          throw new ComposerError(
            `Failed to decode audio: ${track.file.path}`,
            [track.file.path]
          );
        }
      }
    } finally {
      audioContext.close();
    }

    // Step 2: Compute output dimensions
    const sampleRate = decoded[0].buffer.sampleRate;
    const numberOfChannels = Math.max(...decoded.map(d => d.buffer.numberOfChannels));
    const totalDuration = Math.max(
      ...decoded.map(d => d.track.offset + d.buffer.duration)
    );
    const totalSamples = Math.ceil(totalDuration * sampleRate);

    // Step 3: Create OfflineAudioContext
    const offlineCtx = new OfflineAudioContext(
      numberOfChannels,
      totalSamples,
      sampleRate
    );

    // Step 4: Connect each track with GainNode
    for (const { buffer, track } of decoded) {
      const source = offlineCtx.createBufferSource();
      source.buffer = buffer;

      const gainNode = offlineCtx.createGain();

      const startTime = track.offset;
      const endTime = startTime + buffer.duration;
      const volume = track.volume;

      if (track.fadeIn > 0) {
        // Start at 0, ramp to target volume over fadeIn duration
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(volume, startTime + track.fadeIn);
      } else {
        gainNode.gain.setValueAtTime(volume, startTime);
      }

      if (track.fadeOut > 0) {
        // At (endTime - fadeOut), begin ramping to 0
        const fadeOutStart = endTime - track.fadeOut;
        gainNode.gain.setValueAtTime(volume, fadeOutStart);
        gainNode.gain.linearRampToValueAtTime(0, endTime);
      }

      // Wire: source -> gain -> destination
      source.connect(gainNode);
      gainNode.connect(offlineCtx.destination);
      source.start(startTime);
    }

    // Step 5: Render
    return offlineCtx.startRendering();
  }
}
