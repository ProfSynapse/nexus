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

/**
 * Build an MPEG-2 Layer III frame (64 kbps, 22050 Hz, no padding).
 * frameLen = floor(72000 * 64 / 22050) = 208 bytes.
 * Header FF F3 80 00: sync(11) + version=10(MPEG2) + layer=01(III) + 64kbps + 22050.
 */
function makeMpeg2Frame(options: { fill?: number; xing?: boolean } = {}): ArrayBuffer {
  const fill = options.fill ?? 0xaa;
  const FRAME_LEN = 208;
  const frame = new Uint8Array(FRAME_LEN);
  frame[0] = 0xff;
  frame[1] = 0xf3; // 1111 0011: sync(11111) + MPEG2(10) + LayerIII(01) + protection(1)
  frame[2] = 0x80; // 1000 0000: bitrateIdx=1000(64k MPEG2) + sampleIdx=00(22050) + pad=0
  frame[3] = 0x00;
  for (let i = 4; i < FRAME_LEN; i += 1) frame[i] = fill;
  if (options.xing) {
    const marker = 'Xing';
    for (let i = 0; i < marker.length; i += 1) frame[20 + i] = marker.charCodeAt(i);
  }
  return frame.buffer as ArrayBuffer;
}

/** WAV with an extra sub-chunk (`id`, `pad` payload bytes) inserted BEFORE `data`. */
function makeWavWithLeadingSubchunk(samples: number, fill: number, id: string, pad: number): ArrayBuffer {
  const fmtBytes = 8 + 16; // 'fmt ' header + 16-byte body
  const extraBytes = 8 + pad; // leading sub-chunk header + payload
  const headerBytes = 12 + fmtBytes + extraBytes + 8; // RIFF + fmt + extra + 'data' header
  const buffer = new ArrayBuffer(headerBytes + samples);
  const view = new DataView(buffer);
  const w = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  w(8, 'WAVE');
  // fmt
  w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 88200, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  // leading extra sub-chunk
  const extraOff = 36;
  w(extraOff, id);
  view.setUint32(extraOff + 4, pad, true);
  // data
  const dataOff = extraOff + 8 + pad;
  w(dataOff, 'data');
  view.setUint32(dataOff + 4, samples, true);
  const bytes = new Uint8Array(buffer);
  for (let i = dataOff + 8; i < dataOff + 8 + samples; i += 1) bytes[i] = fill;
  return buffer;
}

/** A valid RIFF/WAVE with a `fmt ` sub-chunk but NO `data` sub-chunk. */
function makeWavNoData(): ArrayBuffer {
  const buffer = new ArrayBuffer(12 + 8 + 16);
  const view = new DataView(buffer);
  const w = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  view.setUint32(16, 16, true);
  return buffer;
}

/** Walk the RIFF sub-chunk list and return the `data` payload offset + size. */
function findDataSubchunk(bytes: Uint8Array): { offset: number; size: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 12;
  while (cursor + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[cursor], bytes[cursor + 1], bytes[cursor + 2], bytes[cursor + 3]);
    const size = view.getUint32(cursor + 4, true);
    if (id === 'data') return { offset: cursor + 8, size };
    cursor += 8 + size + (size % 2);
  }
  throw new Error('test helper: no data sub-chunk found');
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

    it('locates "data" by SCANNING sub-chunks (non-canonical layout: LIST before data)', () => {
      // Chunk 1 has an extra `LIST` sub-chunk BEFORE `data`, so the PCM payload
      // is NOT at the fixed 44-byte offset. locateDataSubchunk must walk the
      // sub-chunk list to find it.
      const a = makeWavWithLeadingSubchunk(20, 0xc3, 'LIST', 8);
      const b = makeWav(10, 0xd4);

      const merged = concatAudioBuffers([a, b], 'audio/wav');
      const bytes = new Uint8Array(merged);
      const dataInfo = findDataSubchunk(bytes);

      // The merged data payload = 20 + 10 and begins right after chunk 1's
      // (preserved) header incl. the LIST sub-chunk.
      expect(dataInfo.size).toBe(30);
      expect(bytes[dataInfo.offset]).toBe(0xc3); // chunk 1 PCM first
      expect(bytes[dataInfo.offset + 20]).toBe(0xd4); // chunk 2 PCM follows
    });

    it('clamps an over-declared data size to the bytes actually present', () => {
      // Chunk 1 lies: declares data size 100 but only carries 20 PCM bytes.
      const a = makeWav(20, 0xe5);
      new DataView(a).setUint32(40, 100, true); // over-declare
      const b = makeWav(10, 0xf6);

      // Must not read past chunk 1's buffer; merged payload = 20 (clamped) + 10.
      const merged = concatAudioBuffers([a, b], 'audio/wav');
      const view = new DataView(merged);
      expect(view.getUint32(40, true)).toBe(30);
      expect(merged.byteLength).toBe(44 + 30);
    });

    it('throws when the first WAV buffer has no "data" sub-chunk', () => {
      const noData = makeWavNoData();
      const ok = makeWav(8, 0x01);
      expect(() => concatAudioBuffers([noData, ok], 'audio/wav')).toThrow(/no "data" sub-chunk/);
    });

    it('throws when a LATER WAV buffer has no "data" sub-chunk', () => {
      const ok = makeWav(8, 0x01);
      const noData = makeWavNoData();
      expect(() => concatAudioBuffers([ok, noData], 'audio/wav')).toThrow(/no "data" sub-chunk/);
    });
  });

  describe('mp3 frame-length parsing across MPEG versions', () => {
    it('parses an MPEG-2 Layer III frame (72000 coefficient) when stripping Xing on chunk 2', () => {
      // MPEG-2 LayerIII, 64 kbps, 22050 Hz: frameLen = floor(72000*64/22050) = 209.
      const first = makeMpeg2Frame({ fill: 0x11 });
      const second = makeMpeg2Frame({ fill: 0x22, xing: true });
      const result = new Uint8Array(concatAudioBuffers([first, second], 'audio/mpeg'));
      // Chunk 2 is a single Xing frame → stripped entirely (0 bytes). Only chunk 1 (208) remains.
      expect(result.byteLength).toBe(208);
      expect(result[0]).toBe(0xff);
    });
  });

  describe('ID3 strip guards', () => {
    it('leaves chunk 2 unchanged when its declared ID3 tag length exceeds the buffer', () => {
      const first = makeMp3Frame({ fill: 0x11 });
      // Build a chunk 2 whose ID3 header declares a size larger than the buffer
      // (synchsafe size = 0x7F in the last byte → 127, +10 header = 137 > frame).
      const frame = new Uint8Array(makeMp3Frame({ fill: 0x22 }));
      const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x7f, 0x7f, 0x7f, 0x7f]);
      const tagged = new Uint8Array(id3.length + frame.length);
      tagged.set(id3, 0);
      tagged.set(frame, id3.length);

      const result = new Uint8Array(
        concatAudioBuffers([first, tagged.buffer as ArrayBuffer], 'audio/mpeg')
      );
      // ID3 NOT stripped (tagLength >= length guard), so chunk 2 kept whole incl. its ID3.
      // first(417) + tagged(10 + 417) = 844.
      expect(result.byteLength).toBe(417 + 10 + 417);
      // The ID3 'I' byte is preserved at the chunk-2 boundary.
      expect(result[417]).toBe(0x49);
    });
  });
});
