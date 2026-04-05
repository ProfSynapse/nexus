/**
 * Shared multipart/form-data payload builder for transcription requests.
 */

const CRLF = '\r\n';

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

export function buildMultipartFormData(fields: MultipartField[]): MultipartResult {
  const boundary = `----NexusTranscription${Date.now()}${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  for (const field of fields) {
    const safeFieldName = field.name.replace(/["\r\n]/g, '');
    let header = `--${boundary}${CRLF}`;

    if (field.filename) {
      const safeFileName = field.filename.replace(/["\r\n]/g, '');
      const safeContentType = (field.contentType || 'application/octet-stream').replace(/[\r\n]/g, '');
      header += `Content-Disposition: form-data; name="${safeFieldName}"; filename="${safeFileName}"${CRLF}`;
      header += `Content-Type: ${safeContentType}${CRLF}`;
    } else {
      header += `Content-Disposition: form-data; name="${safeFieldName}"${CRLF}`;
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
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

