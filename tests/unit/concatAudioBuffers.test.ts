import { concatAudioBuffers } from '../../src/services/readAloud/concatAudioBuffers';

/**
 * Build a minimal valid MPEG-1 Layer III frame (128 kbps, 44100 Hz, no padding)
 * whose body is filled with `fill`. Frame length = 144000 * 128 / 44100 = 417 bytes.
 * Optionally injects a leading ID3v2 tag and/or a "Xing" marker in the body so the
 * mp3 strip logic can be exercised on chunks 2..N.
 */
function makeMp3Frame(options: { fill?: number; id3?: boolean; xing?: boolean } = {}): ArrayBuffer {
  const fill = options.fill ?? 0xaa;
  const FRAME_LEN = 417;
  const frame = new Uint8Array(FRAME_LEN);
  // 4-byte header: FF FB 90 00 = sync + MPEG1 LayerIII + 128kbps + 44100 + no pad.
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  for (let i = 4; i < FRAME_LEN; i += 1) {
    frame[i] = fill;
  }
  if (options.xing) {
    // Place the ASCII "Xing" marker inside the frame body (after side info).
    const marker = 'Xing';
    for (let i = 0; i < marker.length; i += 1) {
      frame[36 + i] = marker.charCodeAt(i);
    }
  }

  if (!options.id3) {
    return frame.buffer as ArrayBuffer;
  }

  // Prepend a 10-byte (empty body) ID3v2 tag: "ID3" + ver + flags + synchsafe size 0.
  const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const withTag = new Uint8Array(id3.length + frame.length);
  withTag.set(id3, 0);
  withTag.set(frame, id3.length);
  return withTag.buffer as ArrayBuffer;
}

/** Build a canonical 44-byte-header WAV with `samples` bytes of PCM payload `fill`. */
function makeWav(samples: number, fill: number): ArrayBuffer {
  const dataSize = samples;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, ascii: string): void => {
    for (let i = 0; i < ascii.length; i += 1) {
      view.setUint8(offset + i, ascii.charCodeAt(i));
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 44100, true);
  view.setUint32(28, 88200, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  const bytes = new Uint8Array(buffer);
  for (let i = 44; i < 44 + dataSize; i += 1) {
    bytes[i] = fill;
  }
  return buffer;
}

describe('concatAudioBuffers', () => {
  it('throws when given no buffers', () => {
    expect(() => concatAudioBuffers([], 'audio/mpeg')).toThrow(/at least one buffer/);
  });

  it('throws on an unsupported mimeType when concatenating multiple buffers', () => {
    const a = new ArrayBuffer(8);
    const b = new ArrayBuffer(8);
    expect(() => concatAudioBuffers([a, b], 'audio/ogg')).toThrow(/does not support mimeType/);
  });

  describe('N=1 passthrough', () => {
    it('returns the single mp3 buffer unchanged (identity)', () => {
      const only = makeMp3Frame({ fill: 0x11, id3: true, xing: true });
      const result = concatAudioBuffers([only], 'audio/mpeg');
      expect(result).toBe(only); // exact same reference — no copy, no strip
    });

    it('returns the single wav buffer unchanged regardless of mimeType casing', () => {
      const only = makeWav(16, 0x22);
      expect(concatAudioBuffers([only], 'AUDIO/WAV')).toBe(only);
    });
  });

  describe('N>1 mp3 join', () => {
    it('byte-joins frames and strips ID3 + Xing from chunks 2..N', () => {
      const first = makeMp3Frame({ fill: 0x11 }); // 417 bytes, kept whole
      const second = makeMp3Frame({ fill: 0x22, id3: true, xing: true }); // 10 ID3 + 417 frame
      const third = makeMp3Frame({ fill: 0x33, id3: true }); // 10 ID3 + 417 frame

      const result = new Uint8Array(concatAudioBuffers([first, second, third], 'audio/mpeg'));

      // first kept whole (417); second's Xing frame stripped (entire 417 frame dropped,
      // ID3 already stripped) → 0 bytes from second; third's ID3 stripped → 417 bytes.
      // first(417) + second(0) + third(417) = 834.
      expect(result.byteLength).toBe(417 + 0 + 417);
      // First frame's sync header preserved at offset 0.
      expect(result[0]).toBe(0xff);
      expect(result[1]).toBe(0xfb);
      // First byte of the third frame's body follows the first frame.
      expect(result[417]).toBe(0xff); // third frame sync header
    });

    it('joins plain frames (no ID3/Xing) end to end', () => {
      const first = makeMp3Frame({ fill: 0x11 });
      const second = makeMp3Frame({ fill: 0x22 });
      const result = new Uint8Array(concatAudioBuffers([first, second], 'audio/mpeg'));
      expect(result.byteLength).toBe(417 * 2);
      expect(result[417]).toBe(0xff); // second frame begins right after the first
    });
  });

  describe('N>1 wav merge', () => {
    it('keeps one header and concatenates PCM payloads, rewriting size fields', () => {
      const a = makeWav(20, 0xa1);
      const b = makeWav(30, 0xb2);

      const merged = concatAudioBuffers([a, b], 'audio/wav');
      const bytes = new Uint8Array(merged);
      const view = new DataView(merged);

      // Header (44) + 20 + 30 = 94 bytes total.
      expect(merged.byteLength).toBe(44 + 20 + 30);
      // RIFF size = total - 8.
      expect(view.getUint32(4, true)).toBe(merged.byteLength - 8);
      // data sub-chunk size = combined PCM payload.
      expect(view.getUint32(40, true)).toBe(50);
      // Payload ordering: first chunk's fill then second chunk's fill.
      expect(bytes[44]).toBe(0xa1);
      expect(bytes[44 + 20]).toBe(0xb2);
    });
  });
});
