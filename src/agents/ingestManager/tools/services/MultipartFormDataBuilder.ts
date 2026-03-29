/**
 * Location: src/agents/ingestManager/tools/services/MultipartFormDataBuilder.ts
 * Purpose: Build multipart/form-data payloads for Whisper API transcription requests.
 * Constructs raw ArrayBuffer payloads without relying on the browser FormData API,
 * since Obsidian's requestUrl expects raw body content.
 *
 * Used by: TranscriptionService
 * Dependencies: None (pure utility)
 */

const CRLF = '\r\n';

/**
 * Build a multipart/form-data payload as an ArrayBuffer.
 * Returns the payload and the Content-Type header with boundary.
 */
export function buildMultipartFormData(fields: MultipartField[]): MultipartResult {
  const boundary = `----NexusIngest${Date.now()}${Math.random().toString(36).slice(2)}`;
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();

  for (const field of fields) {
    let header = `--${boundary}${CRLF}`;

    if (field.filename) {
      const safeName = field.filename.replace(/["\r\n]/g, '');
      header += `Content-Disposition: form-data; name="${field.name}"; filename="${safeName}"${CRLF}`;
      header += `Content-Type: ${field.contentType || 'application/octet-stream'}${CRLF}`;
    } else {
      header += `Content-Disposition: form-data; name="${field.name}"${CRLF}`;
    }

    header += CRLF;
    parts.push(encoder.encode(header));

    if (field.value instanceof ArrayBuffer) {
      parts.push(new Uint8Array(field.value));
    } else {
      parts.push(encoder.encode(field.value));
    }

    parts.push(encoder.encode(CRLF));
  }

  parts.push(encoder.encode(`--${boundary}--${CRLF}`));

  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }

  return {
    body: result.buffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export interface MultipartField {
  name: string;
  value: string | ArrayBuffer;
  filename?: string;
  contentType?: string;
}

export interface MultipartResult {
  body: ArrayBuffer;
  contentType: string;
}
