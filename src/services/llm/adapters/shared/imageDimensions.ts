/**
 * Read width and height from a PNG, JPEG or WebP header.
 *
 * Image APIs return bytes without dimensions (or with a requested size that
 * the provider may not have honoured), so adapters read the real dimensions
 * from the file header and fall back to an aspect-ratio table only when the
 * bytes are not one of these formats.
 */
export function readImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  // PNG: signature, then IHDR with width/height as big-endian u32 at 16 and 20.
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // JPEG: walk segments to the first start-of-frame marker.
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 <= buffer.length) {
      if (buffer[offset] !== 0xff) {
        return null;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2; // standalone marker, no length
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (length < 2) {
        return null;
      }
      offset += 2 + length;
    }
    return null;
  }

  // WebP: RIFF....WEBP then a VP8 / VP8L / VP8X chunk.
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return {
        width: buffer.readUIntLE(24, 3) + 1,
        height: buffer.readUIntLE(27, 3) + 1
      };
    }
  }

  return null;
}

/** Sniff png/jpeg/webp from the first bytes; null when none matches. */
export function sniffImageFormat(buffer: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
