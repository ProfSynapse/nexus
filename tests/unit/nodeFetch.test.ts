/**
 * nodeFetch Unit Tests
 *
 * Tests the custom Node.js fetch implementation used to bypass CORS
 * for OpenAI SDK calls in Obsidian's Electron renderer.
 *
 * File under test: src/services/llm/adapters/openai/nodeFetch.ts
 *
 * Mock strategy: We mock `require('https')` to intercept all outgoing
 * requests. Each test controls the mock response (status, headers, body
 * chunks, errors) to verify nodeFetch behavior without real network calls.
 *
 * The implementation normalizes all header keys to lowercase via
 * normalizeHeaders(). Tests assert on lowercase keys accordingly.
 */

import { EventEmitter } from 'events';

// ============================================================================
// Mock Infrastructure
// ============================================================================

/**
 * Creates a mock Node.js IncomingMessage (status, headers, data/end/error).
 */
function createMockResponse(opts: {
  statusCode: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
  chunks?: string[];
  error?: Error;
}) {
  const emitter = new EventEmitter();
  (emitter as any).statusCode = opts.statusCode;
  (emitter as any).statusMessage = opts.statusMessage ?? '';
  (emitter as any).headers = opts.headers ?? {};
  (emitter as any).destroy = jest.fn();
  (emitter as any).resume = jest.fn(); // Required for redirect handling

  const emitData = () => {
    setTimeout(() => {
      if (opts.chunks) {
        for (const chunk of opts.chunks) {
          emitter.emit('data', Buffer.from(chunk));
        }
      }
      if (opts.error) {
        emitter.emit('error', opts.error);
      } else {
        emitter.emit('end');
      }
    }, 0);
  };

  return { response: emitter, emitData };
}

/**
 * Creates a mock ClientRequest (EventEmitter with write/end/destroy/setTimeout).
 */
function createMockRequest() {
  const emitter = new EventEmitter();
  const written: (string | Buffer)[] = [];
  let onEndFn: (() => void) | null = null;

  (emitter as any).write = jest.fn((data: string | Buffer) => {
    written.push(data);
  });
  (emitter as any).destroy = jest.fn((err?: Error) => {
    if (err) emitter.emit('error', err);
  });
  (emitter as any).setTimeout = jest.fn();
  (emitter as any).end = jest.fn(() => {
    if (onEndFn) onEndFn();
  });

  return {
    request: emitter,
    written,
    onEnd(fn: () => void) { onEndFn = fn; },
  };
}

// Track mock state
let mockRequestFactory: jest.Mock;
let lastMockRequest: ReturnType<typeof createMockRequest>;
let lastRequestOptions: any;

// Mock https module — nodeFetch only uses https (HTTPS-only enforcement)
jest.mock('https', () => ({
  request: jest.fn((...args: any[]) => mockRequestFactory(...args)),
}));

// ============================================================================
// Import under test (must come after jest.mock)
// ============================================================================

import { nodeFetch } from '../../src/services/llm/adapters/openai/nodeFetch';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Sets up a standard mock that responds when request.end() is called.
 */
function setupMockResponse(opts: {
  statusCode: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
  chunks?: string[];
  error?: Error;
}) {
  const mock = createMockRequest();
  lastMockRequest = mock;

  mockRequestFactory = jest.fn((options: any, callback: (res: any) => void) => {
    lastRequestOptions = options;
    const { response, emitData } = createMockResponse(opts);

    mock.onEnd(() => {
      callback(response);
      emitData();
    });

    return mock.request;
  });
}

/**
 * Sets up a redirect mock: first request returns 3xx, second returns final response.
 */
function setupRedirectMock(opts: {
  redirectCode: number;
  redirectLocation: string;
  finalStatusCode?: number;
  finalChunks?: string[];
  finalHeaders?: Record<string, string | string[]>;
}) {
  let callCount = 0;
  const allOptions: any[] = [];

  mockRequestFactory = jest.fn((options: any, callback: (res: any) => void) => {
    callCount++;
    allOptions.push(options);
    const mock = createMockRequest();
    lastMockRequest = mock;

    if (callCount === 1) {
      const { response, emitData } = createMockResponse({
        statusCode: opts.redirectCode,
        statusMessage: 'Redirect',
        headers: { location: opts.redirectLocation },
      });
      mock.onEnd(() => {
        callback(response);
        emitData();
      });
    } else {
      const { response, emitData } = createMockResponse({
        statusCode: opts.finalStatusCode ?? 200,
        statusMessage: 'OK',
        headers: opts.finalHeaders ?? {},
        chunks: opts.finalChunks ?? ['final body'],
      });
      mock.onEnd(() => {
        callback(response);
        emitData();
      });
    }

    return mock.request;
  });

  return { allOptions, getCallCount: () => callCount };
}

// ============================================================================
// Tests
// ============================================================================

describe('nodeFetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lastRequestOptions = null;
    mockRequestFactory = jest.fn();
  });

  // --------------------------------------------------------------------------
  // Basic request/response
  // --------------------------------------------------------------------------

  describe('basic GET request', () => {
    it('should resolve with correct status, statusText, and body', async () => {
      setupMockResponse({
        statusCode: 200,
        statusMessage: 'OK',
        chunks: ['Hello, world!'],
      });

      const response = await nodeFetch('https://api.openai.com/v1/models');

      expect(response.status).toBe(200);
      expect(response.statusText).toBe('OK');
      expect(await response.text()).toBe('Hello, world!');
    });

    it('should parse URL correctly (hostname, path, query)', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      await nodeFetch('https://api.openai.com/v1/responses?stream=true');

      expect(lastRequestOptions.hostname).toBe('api.openai.com');
      expect(lastRequestOptions.path).toBe('/v1/responses?stream=true');
      expect(lastRequestOptions.method).toBe('GET');
    });

    it('should default to port 443 for HTTPS', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      await nodeFetch('https://api.openai.com/v1/models');

      expect(lastRequestOptions.port).toBe(443);
    });

    it('should use explicit port from URL', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      await nodeFetch('https://api.openai.com:8443/v1/models');

      expect(lastRequestOptions.port).toBe('8443');
    });

    it('should accept URL object as input', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      const url = new URL('https://api.openai.com/v1/models');
      await nodeFetch(url);

      expect(lastRequestOptions.hostname).toBe('api.openai.com');
      expect(lastRequestOptions.path).toBe('/v1/models');
    });
  });

  // --------------------------------------------------------------------------
  // POST request with body
  // --------------------------------------------------------------------------

  describe('POST request with body', () => {
    it('should send string body and set content-length', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['{"id":"resp_1"}'] });

      const body = JSON.stringify({ model: 'gpt-5', input: 'Hello' });
      await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(lastRequestOptions.method).toBe('POST');
      expect(lastMockRequest.written.join('')).toBe(body);
      // Headers are normalized to lowercase
      expect(lastRequestOptions.headers['content-length']).toBe(
        String(Buffer.byteLength(body))
      );
    });

    it('should send Buffer body', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      const buf = Buffer.from('binary data');
      await nodeFetch('https://api.openai.com/v1/upload', {
        method: 'POST',
        body: buf as any,
      });

      expect(lastMockRequest.written.length).toBe(1);
    });

    it('should convert ArrayBuffer body to Buffer', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      const ab = new ArrayBuffer(4);
      new Uint8Array(ab).set([0x48, 0x69, 0x21, 0x00]);
      await nodeFetch('https://api.openai.com/v1/upload', {
        method: 'POST',
        body: ab as any,
      });

      expect(lastMockRequest.written.length).toBe(1);
    });

    it('should convert Uint8Array body to Buffer', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      const arr = new Uint8Array([72, 101, 108, 108, 111]);
      await nodeFetch('https://api.openai.com/v1/upload', {
        method: 'POST',
        body: arr as any,
      });

      expect(lastMockRequest.written.length).toBe(1);
    });

    it('should not override existing content-length header', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Length': '999' },
        body: 'short',
      });

      // normalizeHeaders lowercases keys, so user-provided Content-Length
      // becomes content-length and should not be overwritten
      expect(lastRequestOptions.headers['content-length']).toBe('999');
    });

    it('should not send body for GET requests without body', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      await nodeFetch('https://api.openai.com/v1/models');

      expect((lastMockRequest.request as any).write).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Header handling
  // --------------------------------------------------------------------------

  describe('header forwarding', () => {
    it('should forward headers from plain object (normalized to lowercase)', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      await nodeFetch('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': 'Bearer sk-test',
          'Content-Type': 'application/json',
        },
      });

      expect(lastRequestOptions.headers['authorization']).toBe('Bearer sk-test');
      expect(lastRequestOptions.headers['content-type']).toBe('application/json');
    });

    it('should forward headers from Headers object', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      const headers = new Headers();
      headers.set('Authorization', 'Bearer sk-test');
      headers.set('X-Custom', 'value');

      await nodeFetch('https://api.openai.com/v1/models', { headers });

      expect(lastRequestOptions.headers['authorization']).toBe('Bearer sk-test');
      expect(lastRequestOptions.headers['x-custom']).toBe('value');
    });

    it('should forward headers from array of tuples', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      const headers: [string, string][] = [
        ['Authorization', 'Bearer sk-test'],
        ['Accept', 'application/json'],
      ];

      await nodeFetch('https://api.openai.com/v1/models', { headers });

      expect(lastRequestOptions.headers['authorization']).toBe('Bearer sk-test');
      expect(lastRequestOptions.headers['accept']).toBe('application/json');
    });

    it('should convert response headers correctly (single values)', async () => {
      setupMockResponse({
        statusCode: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_123',
        },
        chunks: ['ok'],
      });

      const response = await nodeFetch('https://api.openai.com/v1/models');

      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('x-request-id')).toBe('req_123');
    });

    it('should convert response headers correctly (array values)', async () => {
      setupMockResponse({
        statusCode: 200,
        headers: {
          'set-cookie': ['a=1', 'b=2'],
        },
        chunks: ['ok'],
      });

      const response = await nodeFetch('https://api.openai.com/v1/models');

      const cookieHeader = response.headers.get('set-cookie');
      expect(cookieHeader).toContain('a=1');
      expect(cookieHeader).toContain('b=2');
    });
  });

  // --------------------------------------------------------------------------
  // Streaming body (SSE)
  // --------------------------------------------------------------------------

  describe('streaming response body', () => {
    it('should deliver multiple chunks via ReadableStream', async () => {
      setupMockResponse({
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        chunks: [
          'data: {"type":"response.created"}\n\n',
          'data: {"type":"response.text.delta","delta":"Hello"}\n\n',
          'data: {"type":"response.completed"}\n\n',
        ],
      });

      const response = await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{}',
      });

      expect(response.body).toBeTruthy();

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const receivedChunks: string[] = [];

      let done = false;
      while (!done) {
        const result = await reader.read();
        if (result.done) {
          done = true;
        } else {
          receivedChunks.push(decoder.decode(result.value, { stream: true }));
        }
      }

      expect(receivedChunks).toHaveLength(3);
      expect(receivedChunks[0]).toContain('response.created');
      expect(receivedChunks[1]).toContain('Hello');
      expect(receivedChunks[2]).toContain('response.completed');
    });

    it('should allow response.json() to parse complete body', async () => {
      const jsonBody = { id: 'resp_123', status: 'completed' };
      setupMockResponse({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        chunks: [JSON.stringify(jsonBody)],
      });

      const response = await nodeFetch('https://api.openai.com/v1/responses/resp_123');
      const parsed = await response.json();

      expect(parsed).toEqual(jsonBody);
    });

    it('should handle empty body response', async () => {
      // Use 200 with empty chunks (204 with ReadableStream body is invalid per
      // the Response spec — the implementation would need to pass null body for 204)
      setupMockResponse({
        statusCode: 200,
        statusMessage: 'OK',
        chunks: [],
      });

      const response = await nodeFetch('https://api.openai.com/v1/responses/resp_123', {
        method: 'DELETE',
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // Error status codes (should resolve, not reject)
  // --------------------------------------------------------------------------

  describe('error status codes', () => {
    it('should resolve (not reject) on 400 Bad Request', async () => {
      setupMockResponse({
        statusCode: 400,
        statusMessage: 'Bad Request',
        chunks: ['{"error":{"message":"Invalid model"}}'],
      });

      const response = await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{}',
      });

      expect(response.status).toBe(400);
      expect(response.ok).toBe(false);
      const body = await response.json();
      expect(body.error.message).toBe('Invalid model');
    });

    it('should resolve on 401 Unauthorized', async () => {
      setupMockResponse({
        statusCode: 401,
        statusMessage: 'Unauthorized',
        chunks: ['{"error":{"message":"Invalid API key"}}'],
      });

      const response = await nodeFetch('https://api.openai.com/v1/models');

      expect(response.status).toBe(401);
      expect(response.ok).toBe(false);
    });

    it('should resolve on 429 Rate Limited', async () => {
      setupMockResponse({
        statusCode: 429,
        statusMessage: 'Too Many Requests',
        headers: { 'retry-after': '30' },
        chunks: ['{"error":{"message":"Rate limited"}}'],
      });

      const response = await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{}',
      });

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('30');
    });

    it('should resolve on 500 Internal Server Error', async () => {
      setupMockResponse({
        statusCode: 500,
        statusMessage: 'Internal Server Error',
        chunks: ['{"error":{"message":"Server error"}}'],
      });

      const response = await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{}',
      });

      expect(response.status).toBe(500);
      expect(response.ok).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Request-level errors (should reject)
  // --------------------------------------------------------------------------

  describe('request-level errors', () => {
    it('should reject on DNS failure', async () => {
      const mock = createMockRequest();
      lastMockRequest = mock;

      mockRequestFactory = jest.fn((options: any, _callback: any) => {
        lastRequestOptions = options;
        mock.onEnd(() => {
          setTimeout(() => {
            mock.request.emit('error', new Error('getaddrinfo ENOTFOUND api.openai.com'));
          }, 0);
        });
        return mock.request;
      });

      await expect(
        nodeFetch('https://api.openai.com/v1/models')
      ).rejects.toThrow('ENOTFOUND');
    });

    it('should reject on connection refused', async () => {
      const mock = createMockRequest();
      lastMockRequest = mock;

      mockRequestFactory = jest.fn((options: any, _callback: any) => {
        lastRequestOptions = options;
        mock.onEnd(() => {
          setTimeout(() => {
            mock.request.emit('error', new Error('connect ECONNREFUSED'));
          }, 0);
        });
        return mock.request;
      });

      await expect(
        nodeFetch('https://api.openai.com/v1/models')
      ).rejects.toThrow('ECONNREFUSED');
    });
  });

  // --------------------------------------------------------------------------
  // Abort signal
  // --------------------------------------------------------------------------

  describe('abort signal', () => {
    it('should abort request when signal is triggered', async () => {
      const controller = new AbortController();
      const mock = createMockRequest();
      lastMockRequest = mock;

      mockRequestFactory = jest.fn((options: any, _callback: any) => {
        lastRequestOptions = options;
        mock.onEnd(() => {
          setTimeout(() => controller.abort(), 10);
        });
        return mock.request;
      });

      await expect(
        nodeFetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          body: '{}',
          signal: controller.signal,
        })
      ).rejects.toThrow('Request aborted');
    });

    it('should reject immediately if signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      await expect(
        nodeFetch('https://api.openai.com/v1/models', {
          signal: controller.signal,
        })
      ).rejects.toThrow('Request aborted');
    });

    it('should abort mid-stream and destroy the request', async () => {
      const controller = new AbortController();
      const mock = createMockRequest();
      lastMockRequest = mock;
      const responseEmitter = new EventEmitter();
      (responseEmitter as any).statusCode = 200;
      (responseEmitter as any).statusMessage = 'OK';
      (responseEmitter as any).headers = {};
      (responseEmitter as any).destroy = jest.fn();
      (responseEmitter as any).resume = jest.fn();

      mockRequestFactory = jest.fn((options: any, callback: (res: any) => void) => {
        lastRequestOptions = options;
        mock.onEnd(() => {
          callback(responseEmitter);
          setTimeout(() => {
            responseEmitter.emit('data', Buffer.from('data: first\n\n'));
            setTimeout(() => controller.abort(), 5);
          }, 0);
        });
        return mock.request;
      });

      const response = await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{}',
        signal: controller.signal,
      });

      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);

      await new Promise(resolve => setTimeout(resolve, 20));
      expect((mock.request as any).destroy).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Streaming error propagation
  // --------------------------------------------------------------------------

  describe('streaming error propagation', () => {
    it('should propagate stream error through ReadableStream', async () => {
      const mock = createMockRequest();
      lastMockRequest = mock;
      const responseEmitter = new EventEmitter();
      (responseEmitter as any).statusCode = 200;
      (responseEmitter as any).statusMessage = 'OK';
      (responseEmitter as any).headers = {};
      (responseEmitter as any).destroy = jest.fn();
      (responseEmitter as any).resume = jest.fn();

      mockRequestFactory = jest.fn((options: any, callback: (res: any) => void) => {
        lastRequestOptions = options;
        mock.onEnd(() => {
          callback(responseEmitter);
          setTimeout(() => {
            responseEmitter.emit('data', Buffer.from('partial data'));
            responseEmitter.emit('error', new Error('Connection reset'));
          }, 0);
        });
        return mock.request;
      });

      const response = await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{}',
      });

      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);

      await expect(reader.read()).rejects.toThrow('Connection reset');
    });

    it('should cancel ReadableStream and destroy node response', async () => {
      const mock = createMockRequest();
      lastMockRequest = mock;
      const responseEmitter = new EventEmitter();
      (responseEmitter as any).statusCode = 200;
      (responseEmitter as any).statusMessage = 'OK';
      (responseEmitter as any).headers = {};
      (responseEmitter as any).destroy = jest.fn();
      (responseEmitter as any).resume = jest.fn();

      mockRequestFactory = jest.fn((options: any, callback: (res: any) => void) => {
        lastRequestOptions = options;
        mock.onEnd(() => {
          callback(responseEmitter);
          setTimeout(() => {
            responseEmitter.emit('data', Buffer.from('chunk 1'));
          }, 0);
        });
        return mock.request;
      });

      const response = await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{}',
      });

      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();

      expect((responseEmitter as any).destroy).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // HTTPS-only enforcement
  // --------------------------------------------------------------------------

  describe('HTTPS-only enforcement', () => {
    it('should reject plain HTTP URLs', async () => {
      await expect(
        nodeFetch('http://api.openai.com/v1/models')
      ).rejects.toThrow(/https/i);
    });

    it('should accept HTTPS URLs', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      const response = await nodeFetch('https://api.openai.com/v1/models');
      expect(response.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Redirect following
  // --------------------------------------------------------------------------

  describe('redirect following', () => {
    it('should follow 301 redirect', async () => {
      const tracker = setupRedirectMock({
        redirectCode: 301,
        redirectLocation: 'https://api.openai.com/v2/models',
        finalChunks: ['{"models":[]}'],
      });

      const response = await nodeFetch('https://api.openai.com/v1/models');

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"models":[]}');
      expect(tracker.getCallCount()).toBe(2);
    });

    it('should follow 302 redirect', async () => {
      const tracker = setupRedirectMock({
        redirectCode: 302,
        redirectLocation: 'https://api.openai.com/v1/models-new',
        finalChunks: ['ok'],
      });

      const response = await nodeFetch('https://api.openai.com/v1/models');

      expect(response.status).toBe(200);
      expect(tracker.getCallCount()).toBe(2);
    });

    it('should follow 307 redirect preserving method and body', async () => {
      const tracker = setupRedirectMock({
        redirectCode: 307,
        redirectLocation: 'https://api.openai.com/v1/responses-new',
        finalChunks: ['{"id":"resp_1"}'],
      });

      const response = await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{"model":"gpt-5"}',
      });

      expect(response.status).toBe(200);
      expect(tracker.getCallCount()).toBe(2);
      // 307 preserves POST method
      expect(tracker.allOptions[1]?.method).toBe('POST');
    });

    it('should follow 308 redirect preserving method', async () => {
      const tracker = setupRedirectMock({
        redirectCode: 308,
        redirectLocation: 'https://api.openai.com/v1/responses-v2',
        finalChunks: ['ok'],
      });

      const response = await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{}',
      });

      expect(response.status).toBe(200);
      expect(tracker.getCallCount()).toBe(2);
    });

    it('should change POST to GET on 301 redirect (per browser fetch spec)', async () => {
      const tracker = setupRedirectMock({
        redirectCode: 301,
        redirectLocation: 'https://api.openai.com/v2/responses',
        finalChunks: ['ok'],
      });

      await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{}',
      });

      // 301 + POST -> GET (browser behavior)
      expect(tracker.allOptions[1]?.method).toBe('GET');
    });

    it('should change POST to GET on 302 redirect (per browser fetch spec)', async () => {
      const tracker = setupRedirectMock({
        redirectCode: 302,
        redirectLocation: 'https://api.openai.com/v2/responses',
        finalChunks: ['ok'],
      });

      await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{}',
      });

      // 302 + POST -> GET (browser behavior)
      expect(tracker.allOptions[1]?.method).toBe('GET');
    });

    it('should limit redirect hops to prevent infinite loops', async () => {
      let callCount = 0;
      mockRequestFactory = jest.fn((options: any, callback: (res: any) => void) => {
        callCount++;
        const mock = createMockRequest();
        lastMockRequest = mock;
        const { response, emitData } = createMockResponse({
          statusCode: 302,
          headers: { location: 'https://api.openai.com/v1/loop' },
        });
        mock.onEnd(() => {
          callback(response);
          emitData();
        });
        return mock.request;
      });

      await expect(
        nodeFetch('https://api.openai.com/v1/start')
      ).rejects.toThrow(/redirect/i);

      // MAX_REDIRECTS is 5, so we expect 6 calls (initial + 5 redirects)
      expect(callCount).toBe(6);
    });

    it('should strip Authorization header on cross-origin redirect', async () => {
      const tracker = setupRedirectMock({
        redirectCode: 302,
        redirectLocation: 'https://cdn.example.com/v1/data',
        finalChunks: ['ok'],
      });

      await nodeFetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': 'Bearer sk-secret' },
      });

      // First request should have authorization (lowercase)
      expect(tracker.allOptions[0]?.headers?.['authorization']).toBe('Bearer sk-secret');

      // Redirected request to different origin should NOT have authorization
      expect(tracker.allOptions[1]?.headers?.['authorization']).toBeUndefined();
    });

    it('should keep Authorization header on same-origin redirect', async () => {
      const tracker = setupRedirectMock({
        redirectCode: 302,
        redirectLocation: 'https://api.openai.com/v2/models',
        finalChunks: ['ok'],
      });

      await nodeFetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': 'Bearer sk-secret' },
      });

      // Same origin: authorization should be preserved
      expect(tracker.allOptions[1]?.headers?.['authorization']).toBe('Bearer sk-secret');
    });
  });

  // --------------------------------------------------------------------------
  // Timeout handling
  // --------------------------------------------------------------------------

  describe('timeout handling', () => {
    it('should call setTimeout with 120_000ms on the request', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      await nodeFetch('https://api.openai.com/v1/models');

      expect((lastMockRequest.request as any).setTimeout).toHaveBeenCalledWith(
        120_000,
        expect.any(Function)
      );
    });

    it('should destroy request when timeout fires', async () => {
      const mock = createMockRequest();
      lastMockRequest = mock;

      mockRequestFactory = jest.fn((options: any, _callback: any) => {
        lastRequestOptions = options;
        // Don't call callback (simulate hung server)
        // But still need .end() to be callable
        mock.onEnd(() => {
          // Simulate the timeout callback firing
          const setTimeoutCall = (mock.request as any).setTimeout.mock.calls[0];
          if (setTimeoutCall) {
            const timeoutCallback = setTimeoutCall[1];
            setTimeout(() => timeoutCallback(), 5);
          }
        });
        return mock.request;
      });

      await expect(
        nodeFetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          body: '{}',
        })
      ).rejects.toThrow(/timed out/i);
    });
  });

  // --------------------------------------------------------------------------
  // Request object input
  // --------------------------------------------------------------------------

  describe('Request object input', () => {
    it('should extract URL and method from Request object', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      const request = new Request('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer sk-test' },
      });

      await nodeFetch(request);

      expect(lastRequestOptions.hostname).toBe('api.openai.com');
      expect(lastRequestOptions.path).toBe('/v1/models');
      expect(lastRequestOptions.method).toBe('GET');
    });

    it('should merge Request headers with init headers (init takes precedence)', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      const request = new Request('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': 'Bearer from-request',
          'X-Request-Only': 'value1',
        },
      });

      await nodeFetch(request, {
        headers: {
          'Authorization': 'Bearer from-init',
          'X-Init-Only': 'value2',
        },
      });

      // init headers take precedence (all lowercase)
      expect(lastRequestOptions.headers['authorization']).toBe('Bearer from-init');
      expect(lastRequestOptions.headers['x-init-only']).toBe('value2');
      // Request-only header should be merged
      expect(lastRequestOptions.headers['x-request-only']).toBe('value1');
    });

    it('should use init method over Request method', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      const request = new Request('https://api.openai.com/v1/models', {
        method: 'GET',
      });

      await nodeFetch(request, { method: 'POST', body: '{}' });

      expect(lastRequestOptions.method).toBe('POST');
    });
  });

  // --------------------------------------------------------------------------
  // Content-Length calculation
  // --------------------------------------------------------------------------

  describe('content-length calculation', () => {
    it('should calculate correct byte length for multi-byte strings', async () => {
      setupMockResponse({ statusCode: 200, chunks: ['ok'] });

      const body = '{"text":"Hello \u{1F30D}\u{1F30E}\u{1F30F}"}';
      await nodeFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body,
      });

      const expectedLength = Buffer.byteLength(body);
      expect(lastRequestOptions.headers['content-length']).toBe(String(expectedLength));
      // Multi-byte chars: byte length > string length
      expect(expectedLength).toBeGreaterThan(body.length);
    });
  });

  // --------------------------------------------------------------------------
  // response.ok property
  // --------------------------------------------------------------------------

  describe('response.ok property', () => {
    it.each([
      [200, true],
      [201, true],
      [299, true],
      [400, false],
      [401, false],
      [404, false],
      [429, false],
      [500, false],
    ])('should set response.ok=%s for status %d', async (status, expectedOk) => {
      setupMockResponse({
        statusCode: status,
        chunks: ['body'],
      });

      const response = await nodeFetch('https://api.openai.com/v1/models');
      expect(response.ok).toBe(expectedOk);
    });
  });
});
