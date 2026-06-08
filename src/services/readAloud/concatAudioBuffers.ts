/**
 * Location: src/services/readAloud/concatAudioBuffers.ts
 *
 * Pure, format-aware audio buffer concatenation for the read-aloud "save as
 * audio" feature. Joins the N per-chunk synthesis buffers from a single
 * read-aloud run into ONE embeddable file WITHOUT any audio engine
 * (no AudioContext/OfflineAudioContext/MediaRecorder) and without re-encoding,
 * so the whole path runs identically on desktop and mobile.
 *
 * Used by: ReadAloudSaveService (save selection / save note as audio). The
 * helper has zero Obsidian/platform dependencies and is unit-testable in
 * isolation.
 *
 * Why a raw join works: within one read-aloud run every chunk is synthesized by
 * ONE provider at ONE bitrate / sample-rate / channel mode, so the buffers are
 * format-uniform and can be joined at the container level. See
 * docs/plans/read-aloud-save-embed-scoping.md §4.
 */

/** mimeType emitted by mp3 speech adapters (OpenAI/OpenRouter/Mistral/ElevenLabs). */
const MIME_MPEG = 'audio/mpeg';
/** mimeType emitted by the Google speech adapter (PCM wrapped in RIFF/WAV). */
const MIME_WAV = 'audio/wav';

const WAV_RIFF_HEADER_BYTES = 12; // 'RIFF' + size(4) + 'WAVE'
const WAV_SUBCHUNK_HEADER_BYTES = 8; // id(4) + size(4)

/**
 * Concatenate per-chunk audio buffers (all of one `mimeType`) into a single
 * buffer. `audio/mpeg` → frame byte-join with ID3/Xing strip on chunks 2…N;
 * `audio/wav` → header-aware PCM merge. N=1 returns the single buffer unchanged.
 *
 * @throws if `buffers` is empty or the mimeType is not a supported audio format.
 */
export function concatAudioBuffers(buffers: ArrayBuffer[], mimeType: string): ArrayBuffer {
  if (buffers.length === 0) {
    throw new Error('concatAudioBuffers requires at least one buffer.');
  }

  // N=1 is the common case (selection) — return the single buffer untouched so
  // no format-specific logic can ever corrupt a pristine single chunk.
  if (buffers.length === 1) {
    return buffers[0];
  }

  const normalizedMime = mimeType.toLowerCase();
  if (normalizedMime === MIME_MPEG) {
    return concatMp3(buffers);
  }
  if (normalizedMime === MIME_WAV) {
    return concatWav(buffers);
  }

  throw new Error(
    `concatAudioBuffers does not support mimeType "${mimeType}". Supported: ${MIME_MPEG}, ${MIME_WAV}.`
  );
}

/**
 * MP3 is a stream of self-contained frames, so concatenated frame streams play
 * fine. We byte-join the buffers, stripping any leading ID3v2 tag and Xing/Info
 * VBR header frame from chunks 2…N so metadata/VBR headers never land
 * mid-stream. Chunk 1 keeps whatever leading bytes it has.
 */
function concatMp3(buffers: ArrayBuffer[]): ArrayBuffer {
  const cleaned: Uint8Array[] = buffers.map((buffer, index) => {
    const bytes = new Uint8Array(buffer);
    if (index === 0) {
      return bytes;
    }
    return stripXingHeader(stripId3v2(bytes));
  });

  return toArrayBuffer(concatUint8Arrays(cleaned));
}

/**
 * Strip a leading ID3v2 tag if present. ID3v2 header = "ID3" + 2 version bytes
 * + 1 flags byte + 4 synchsafe size bytes (7 bits each); total tag length =
 * 10 + size. Returns the input unchanged when no ID3v2 tag is present (the
 * common case for raw TTS output).
 */
function stripId3v2(bytes: Uint8Array): Uint8Array {
  if (
    bytes.length < 10 ||
    bytes[0] !== 0x49 || // 'I'
    bytes[1] !== 0x44 || // 'D'
    bytes[2] !== 0x33 // '3'
  ) {
    return bytes;
  }

  // Synchsafe integer: 4 bytes, low 7 bits each.
  const size =
    (bytes[6] & 0x7f) * 0x200000 +
    (bytes[7] & 0x7f) * 0x4000 +
    (bytes[8] & 0x7f) * 0x80 +
    (bytes[9] & 0x7f);
  const tagLength = 10 + size;
  if (tagLength >= bytes.length) {
    return bytes;
  }
  return bytes.subarray(tagLength);
}

/**
 * Strip a leading Xing/Info VBR header frame if present. After any ID3 tag, an
 * mp3 may begin with a single empty frame carrying a "Xing" or "Info" tag
 * describing VBR stats; appended mid-stream it would be decoded as silence /
 * confuse seeking. We detect the tag within the first frame and drop that whole
 * frame. Returns the input unchanged when no Xing/Info tag is found.
 */
function stripXingHeader(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || (bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0)) {
    // Not an mp3 frame sync at offset 0 — nothing to strip.
    return bytes;
  }

  const frameLength = mp3FrameLength(bytes);
  if (frameLength <= 0 || frameLength > bytes.length) {
    return bytes;
  }

  // Xing/Info tag lives a small variable offset into the frame; scan the frame
  // body for the 4-char marker rather than hardcoding the side-info offset.
  const marker = findAsciiMarker(bytes, frameLength, ['Xing', 'Info']);
  if (marker === -1) {
    return bytes;
  }
  return bytes.subarray(frameLength);
}

/**
 * Compute the byte length of the mp3 frame starting at offset 0, from its
 * 4-byte header. Returns 0 if the header is unparseable. Supports MPEG-1/2/2.5
 * Layer III (the layer TTS providers emit).
 */
function mp3FrameLength(bytes: Uint8Array): number {
  const versionBits = (bytes[1] >> 3) & 0x03; // 00=MPEG2.5, 10=MPEG2, 11=MPEG1
  const layerBits = (bytes[1] >> 1) & 0x03; // 01=Layer III
  const bitrateIndex = (bytes[2] >> 4) & 0x0f;
  const sampleRateIndex = (bytes[2] >> 2) & 0x03;
  const padding = (bytes[2] >> 1) & 0x01;

  if (layerBits !== 0x01 || bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) {
    return 0;
  }

  const isMpeg1 = versionBits === 0x03;
  const bitrate = (isMpeg1 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES)[bitrateIndex];
  const sampleRate = SAMPLE_RATES[versionBits][sampleRateIndex];
  if (!bitrate || !sampleRate) {
    return 0;
  }

  // Layer III: MPEG1 = 144 * br / sr; MPEG2/2.5 = 72 * br / sr (half samples/frame).
  const coefficient = isMpeg1 ? 144000 : 72000;
  return Math.floor((coefficient * bitrate) / sampleRate) + padding;
}

const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
// Indexed by versionBits (00=2.5, 01=reserved, 10=2, 11=1), then sampleRateIndex.
const SAMPLE_RATES: Record<number, number[]> = {
  0x00: [11025, 12000, 8000, 0],
  0x02: [22050, 24000, 16000, 0],
  0x03: [44100, 48000, 32000, 0],
};

/**
 * WAV merge: keep chunk 1's full RIFF/`fmt ` header, append only the PCM payload
 * (the bytes inside each chunk's `data` sub-chunk) from every chunk, then
 * rewrite the RIFF size and data size fields. The `data` sub-chunk is located by
 * SCANNING the RIFF sub-chunk list rather than assuming a fixed 44-byte header,
 * so non-canonical files (extra `LIST`/`fact` sub-chunks before `data`) merge
 * correctly. All chunks share one format (single provider per run), so chunk 1's
 * `fmt ` is authoritative.
 */
function concatWav(buffers: ArrayBuffer[]): ArrayBuffer {
  const first = new Uint8Array(buffers[0]);
  const firstData = locateDataSubchunk(first);
  if (!firstData) {
    throw new Error('concatAudioBuffers: first WAV buffer has no "data" sub-chunk.');
  }

  // Header = everything in chunk 1 up to and including the 8-byte `data`
  // sub-chunk header (id + size). PCM payloads follow.
  const headerEnd = firstData.offset; // offset of PCM payload start in chunk 1
  const header = first.subarray(0, headerEnd);

  const payloads: Uint8Array[] = [];
  for (const buffer of buffers) {
    const bytes = new Uint8Array(buffer);
    const data = locateDataSubchunk(bytes);
    if (!data) {
      throw new Error('concatAudioBuffers: a WAV buffer has no "data" sub-chunk.');
    }
    payloads.push(bytes.subarray(data.offset, data.offset + data.size));
  }

  const totalPayload = payloads.reduce((sum, payload) => sum + payload.byteLength, 0);
  const merged = new Uint8Array(header.byteLength + totalPayload);
  merged.set(header, 0);
  let cursor = header.byteLength;
  for (const payload of payloads) {
    merged.set(payload, cursor);
    cursor += payload.byteLength;
  }

  // Rewrite size fields (little-endian).
  const view = new DataView(merged.buffer);
  // RIFF chunk size = total file size - 8 (the 'RIFF' id + this size field).
  view.setUint32(4, merged.byteLength - 8, true);
  // data sub-chunk size = total PCM payload, written at (headerEnd - 4).
  view.setUint32(headerEnd - 4, totalPayload, true);

  return toArrayBuffer(merged);
}

/**
 * Return a freshly-allocated Uint8Array's backing store as a true ArrayBuffer.
 * `Uint8Array.prototype.buffer` is typed `ArrayBufferLike` (could be a
 * SharedArrayBuffer); since we always allocate with `new Uint8Array(n)` the
 * store is a plain ArrayBuffer, so a narrowing copy-free assertion is safe and
 * keeps the public return type `ArrayBuffer`.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer as ArrayBuffer;
}

/**
 * Locate the `data` sub-chunk in a RIFF/WAVE buffer by walking the sub-chunk
 * list. Returns the PCM payload `offset` (first byte after the `data` sub-chunk
 * header) and its declared `size`, or null if no `data` sub-chunk is found.
 */
function locateDataSubchunk(bytes: Uint8Array): { offset: number; size: number } | null {
  if (bytes.byteLength < WAV_RIFF_HEADER_BYTES || !matchesAscii(bytes, 0, 'RIFF') || !matchesAscii(bytes, 8, 'WAVE')) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = WAV_RIFF_HEADER_BYTES;
  while (cursor + WAV_SUBCHUNK_HEADER_BYTES <= bytes.byteLength) {
    const size = view.getUint32(cursor + 4, true);
    const payloadOffset = cursor + WAV_SUBCHUNK_HEADER_BYTES;
    if (matchesAscii(bytes, cursor, 'data')) {
      // Clamp size to the actual remaining bytes to tolerate a truncated/over-
      // declared size field.
      const available = bytes.byteLength - payloadOffset;
      return { offset: payloadOffset, size: Math.min(size, available) };
    }
    // Sub-chunks are word-aligned: advance by header + size + pad-to-even.
    cursor = payloadOffset + size + (size % 2);
  }
  return null;
}

function matchesAscii(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (offset + ascii.length > bytes.byteLength) {
    return false;
  }
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[offset + index] !== ascii.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

/** Find the first occurrence of any of `markers` within bytes[0, limit). */
function findAsciiMarker(bytes: Uint8Array, limit: number, markers: string[]): number {
  const end = Math.min(limit, bytes.byteLength);
  for (let offset = 0; offset < end; offset += 1) {
    for (const marker of markers) {
      if (matchesAscii(bytes, offset, marker)) {
        return offset;
      }
    }
  }
  return -1;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, array) => sum + array.byteLength, 0);
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const array of arrays) {
    merged.set(array, cursor);
    cursor += array.byteLength;
  }
  return merged;
}
