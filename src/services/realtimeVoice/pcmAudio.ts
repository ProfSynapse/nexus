/**
 * Shared PCM helpers for realtime transcription sessions.
 *
 * Both the AssemblyAI and OpenAI live-transcribe sessions capture microphone
 * audio through a ScriptProcessor and ship little-endian 16-bit PCM upstream,
 * just at different sample rates.
 */

/** Downmix a Float32 buffer to little-endian PCM16 at the target sample rate. */
export function encodeFloatPcm16(
  samples: Float32Array,
  inputRate: number,
  targetRate: number
): ArrayBuffer {
  const resampled = inputRate === targetRate
    ? samples
    : resampleLinear(samples, inputRate, targetRate);
  const bytes = new ArrayBuffer(resampled.length * 2);
  const view = new DataView(bytes);

  for (let index = 0; index < resampled.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, resampled[index]));
    const value = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(index * 2, value, true);
  }

  return bytes;
}

/** Linear-interpolation resample. Good enough for speech at these rates. */
export function resampleLinear(
  samples: Float32Array,
  inputRate: number,
  targetRate: number
): Float32Array {
  if (samples.length === 0) {
    return new Float32Array();
  }

  const targetLength = Math.max(1, Math.round(samples.length * targetRate / inputRate));
  const result = new Float32Array(targetLength);
  const scale = inputRate / targetRate;
  for (let index = 0; index < targetLength; index += 1) {
    const position = index * scale;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    result[index] = samples[left] + (samples[right] - samples[left]) * weight;
  }
  return result;
}

/** Root-mean-square amplitude, used as a cheap voice-activity signal. */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / samples.length);
}

/** Base64-encode PCM bytes without relying on Node's Buffer. */
export function encodeBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let index = 0; index < view.length; index += 1) {
    binary += String.fromCharCode(view[index]);
  }
  return btoa(binary);
}
