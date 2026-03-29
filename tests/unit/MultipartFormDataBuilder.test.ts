/**
 * MultipartFormDataBuilder Unit Tests
 *
 * Tests the pure multipart/form-data building utility.
 * Verifies the raw ArrayBuffer payload structure, boundary generation,
 * and Content-Type header format.
 */

import {
  buildMultipartFormData,
  MultipartField,
} from '../../src/agents/ingestManager/tools/services/MultipartFormDataBuilder';

/** Decode an ArrayBuffer to string for assertion */
function decodeBody(body: ArrayBuffer): string {
  return new TextDecoder().decode(body);
}

describe('MultipartFormDataBuilder', () => {
  // ==========================================================================
  // Basic structure
  // ==========================================================================

  describe('basic structure', () => {
    it('should return contentType with boundary', () => {
      const fields: MultipartField[] = [
        { name: 'model', value: 'whisper-1' },
      ];
      const { contentType } = buildMultipartFormData(fields);
      expect(contentType).toMatch(/^multipart\/form-data; boundary=----NexusIngest/);
    });

    it('should return body as ArrayBuffer', () => {
      const fields: MultipartField[] = [
        { name: 'model', value: 'whisper-1' },
      ];
      const { body } = buildMultipartFormData(fields);
      expect(body).toBeInstanceOf(ArrayBuffer);
    });

    it('should include boundary at start and end of body', () => {
      const fields: MultipartField[] = [
        { name: 'test', value: 'value' },
      ];
      const { body, contentType } = buildMultipartFormData(fields);
      const boundary = contentType.split('boundary=')[1];
      const decoded = decodeBody(body);
      expect(decoded).toContain(`--${boundary}`);
      expect(decoded).toContain(`--${boundary}--`);
    });
  });

  // ==========================================================================
  // String fields
  // ==========================================================================

  describe('string fields', () => {
    it('should encode string field with Content-Disposition', () => {
      const fields: MultipartField[] = [
        { name: 'model', value: 'whisper-1' },
      ];
      const { body } = buildMultipartFormData(fields);
      const decoded = decodeBody(body);
      expect(decoded).toContain('Content-Disposition: form-data; name="model"');
      expect(decoded).toContain('whisper-1');
    });

    it('should encode multiple string fields', () => {
      const fields: MultipartField[] = [
        { name: 'model', value: 'whisper-1' },
        { name: 'response_format', value: 'verbose_json' },
        { name: 'language', value: 'en' },
      ];
      const { body } = buildMultipartFormData(fields);
      const decoded = decodeBody(body);
      expect(decoded).toContain('name="model"');
      expect(decoded).toContain('whisper-1');
      expect(decoded).toContain('name="response_format"');
      expect(decoded).toContain('verbose_json');
      expect(decoded).toContain('name="language"');
      expect(decoded).toContain('en');
    });
  });

  // ==========================================================================
  // File fields
  // ==========================================================================

  describe('file fields', () => {
    it('should include filename and Content-Type for file fields', () => {
      const fileData = new ArrayBuffer(8);
      const fields: MultipartField[] = [
        {
          name: 'file',
          value: fileData,
          filename: 'audio.mp3',
          contentType: 'audio/mpeg',
        },
      ];
      const { body } = buildMultipartFormData(fields);
      const decoded = decodeBody(body);
      expect(decoded).toContain('name="file"; filename="audio.mp3"');
      expect(decoded).toContain('Content-Type: audio/mpeg');
    });

    it('should default contentType to application/octet-stream if not provided', () => {
      const fileData = new ArrayBuffer(4);
      const fields: MultipartField[] = [
        {
          name: 'file',
          value: fileData,
          filename: 'data.bin',
        },
      ];
      const { body } = buildMultipartFormData(fields);
      const decoded = decodeBody(body);
      expect(decoded).toContain('Content-Type: application/octet-stream');
    });

    it('should include binary data in body', () => {
      const fileData = new ArrayBuffer(4);
      const view = new Uint8Array(fileData);
      view[0] = 0x48; // H
      view[1] = 0x49; // I
      view[2] = 0x21; // !
      view[3] = 0x0A; // \n

      const fields: MultipartField[] = [
        {
          name: 'file',
          value: fileData,
          filename: 'test.bin',
          contentType: 'application/octet-stream',
        },
      ];
      const { body } = buildMultipartFormData(fields);
      const decoded = decodeBody(body);
      expect(decoded).toContain('HI!');
    });
  });

  // ==========================================================================
  // Mixed fields (string + file)
  // ==========================================================================

  describe('mixed fields', () => {
    it('should handle Whisper API request fields correctly', () => {
      const audioBuffer = new ArrayBuffer(16);
      const fields: MultipartField[] = [
        { name: 'file', value: audioBuffer, filename: 'recording.mp3', contentType: 'audio/mpeg' },
        { name: 'model', value: 'whisper-1' },
        { name: 'response_format', value: 'verbose_json' },
        { name: 'timestamp_granularities[]', value: 'segment' },
      ];
      const { body, contentType } = buildMultipartFormData(fields);
      const decoded = decodeBody(body);

      expect(contentType).toContain('multipart/form-data');
      expect(decoded).toContain('filename="recording.mp3"');
      expect(decoded).toContain('whisper-1');
      expect(decoded).toContain('verbose_json');
      expect(decoded).toContain('segment');
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle empty fields array', () => {
      const { body, contentType } = buildMultipartFormData([]);
      expect(contentType).toContain('multipart/form-data');
      const decoded = decodeBody(body);
      // Should still have closing boundary
      expect(decoded).toMatch(/--.*--\r\n$/);
    });

    it('should handle empty string value', () => {
      const fields: MultipartField[] = [{ name: 'language', value: '' }];
      const { body } = buildMultipartFormData(fields);
      const decoded = decodeBody(body);
      expect(decoded).toContain('name="language"');
    });

    it('should handle empty ArrayBuffer value', () => {
      const fields: MultipartField[] = [
        { name: 'file', value: new ArrayBuffer(0), filename: 'empty.bin' },
      ];
      const { body } = buildMultipartFormData(fields);
      expect(body.byteLength).toBeGreaterThan(0); // At least headers
    });

    it('should generate unique boundaries', () => {
      const result1 = buildMultipartFormData([{ name: 'a', value: 'b' }]);
      const result2 = buildMultipartFormData([{ name: 'a', value: 'b' }]);
      const boundary1 = result1.contentType.split('boundary=')[1];
      const boundary2 = result2.contentType.split('boundary=')[1];
      // Boundaries include Date.now() and Math.random(), so should differ
      expect(boundary1).not.toBe(boundary2);
    });

    it('should use CRLF line endings', () => {
      const fields: MultipartField[] = [{ name: 'test', value: 'value' }];
      const { body } = buildMultipartFormData(fields);
      const decoded = decodeBody(body);
      expect(decoded).toContain('\r\n');
    });
  });
});
