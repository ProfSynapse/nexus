/** Wrap raw 16-bit PCM in a WAV header so ordinary players can open it. */
export function wrapPcmAsWav(pcmAudio: ArrayBuffer, sampleRate = 24000, channelCount = 1): ArrayBuffer {
  const bitsPerSample = 16;
  const headerSize = 44;
  const pcmBytes = new Uint8Array(pcmAudio);
  const wavBytes = new Uint8Array(headerSize + pcmBytes.byteLength);
  const view = new DataView(wavBytes.buffer);

  writeAscii(wavBytes, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  writeAscii(wavBytes, 8, 'WAVE');
  writeAscii(wavBytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * (bitsPerSample / 8), true);
  view.setUint16(32, channelCount * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(wavBytes, 36, 'data');
  view.setUint32(40, pcmBytes.byteLength, true);
  wavBytes.set(pcmBytes, headerSize);

  return wavBytes.buffer;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
