import { __setRequestUrlMock } from '../mocks/obsidian';
import {
  ProviderHttpClient,
  ProviderHttpError
} from '../../src/services/llm/adapters/shared/ProviderHttpClient';

describe('ProviderHttpClient', () => {
  type HttpErrorResponse = {
    response: {
      status: number;
    };
    message: string;
  };

  beforeEach(() => {
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      text: '{"ok":true}',
      json: { ok: true },
      arrayBuffer: new ArrayBuffer(0)
    }));
  });

  it('returns normalized response fields', async () => {
    const response = await ProviderHttpClient.request({
      url: 'https://example.com',
      provider: 'openai',
      operation: 'test'
    });

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ok: true });
  });

  it('retries retryable statuses', async () => {
    let calls = 0;
    __setRequestUrlMock(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 429,
          headers: {},
          text: '{"error":{"message":"rate limited"}}',
          json: { error: { message: 'rate limited' } },
          arrayBuffer: new ArrayBuffer(0)
        };
      }

      return {
        status: 200,
        headers: {},
        text: '{"ok":true}',
        json: { ok: true },
        arrayBuffer: new ArrayBuffer(0)
      };
    });

    const response = await ProviderHttpClient.request({
      url: 'https://example.com',
      provider: 'openrouter',
      operation: 'retry',
      retries: 1,
      retryDelayMs: 1
    });

    expect(calls).toBe(2);
    expect(response.ok).toBe(true);
  });

  it('assertOk throws ProviderHttpError on non-2xx', () => {
    expect(() =>
      ProviderHttpClient.assertOk({
        ok: false,
        status: 500,
        headers: {},
        text: 'server error',
        json: null,
        arrayBuffer: new ArrayBuffer(0)
      })
    ).toThrow(ProviderHttpError);
  });

  it('rejects timeout when request takes too long', async () => {
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    __setRequestUrlMock(() => new Promise((resolve) => {
      // Never resolves before the client timeout, but keep a handle so the test can clean up.
      pendingTimer = setTimeout(resolve, 60_000);
    }));

    try {
      await expect(
        ProviderHttpClient.request({
          url: 'https://example.com',
          provider: 'openai',
          operation: 'test',
          timeoutMs: 50
        })
      ).rejects.toThrow(/timeout/i);
    } finally {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
      }
    }
  });

  it('applies exponential backoff between retries', async () => {
    let calls = 0;
    const callTimestamps: number[] = [];
    __setRequestUrlMock(async () => {
      calls += 1;
      callTimestamps.push(Date.now());
      return {
        status: 500,
        headers: {},
        text: 'error',
        json: null,
        arrayBuffer: new ArrayBuffer(0)
      };
    });

    await ProviderHttpClient.request({
      url: 'https://example.com',
      provider: 'openai',
      operation: 'backoff-test',
      retries: 2,
      retryDelayMs: 50
    });

    expect(calls).toBe(3);
    // Second delay should be longer than first (exponential)
    const firstDelay = callTimestamps[1] - callTimestamps[0];
    const secondDelay = callTimestamps[2] - callTimestamps[1];
    expect(secondDelay).toBeGreaterThanOrEqual(firstDelay);
  });

  it('throws the last error after exhausting all retries', async () => {
    __setRequestUrlMock(async () => {
      throw new Error('network down');
    });

    await expect(
      ProviderHttpClient.request({
        url: 'https://example.com',
        provider: 'openai',
        operation: 'exhaust-test',
        retries: 2,
        retryDelayMs: 1
      })
    ).rejects.toThrow('network down');
  });

  it('requestJson returns parsed JSON from response', async () => {
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      text: '{"models":["gpt-5"]}',
      json: { models: ['gpt-5'] },
      arrayBuffer: new ArrayBuffer(0)
    }));

    const result = await ProviderHttpClient.requestJson({
      url: 'https://example.com',
      provider: 'openai',
      operation: 'json-test'
    });

    expect(result).toEqual({ models: ['gpt-5'] });
  });

  it('requestText returns raw text from response', async () => {
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: 'plain text body',
      json: null,
      arrayBuffer: new ArrayBuffer(0)
    }));

    const result = await ProviderHttpClient.requestText({
      url: 'https://example.com',
      provider: 'openai',
      operation: 'text-test'
    });

    expect(result).toBe('plain text body');
  });

  it('respects custom retryOnStatuses', async () => {
    let calls = 0;
    __setRequestUrlMock(async () => {
      calls += 1;
      return {
        status: 418,
        headers: {},
        text: 'teapot',
        json: null,
        arrayBuffer: new ArrayBuffer(0)
      };
    });

    const response = await ProviderHttpClient.request({
      url: 'https://example.com',
      provider: 'openai',
      operation: 'custom-retry',
      retries: 2,
      retryDelayMs: 1,
      retryOnStatuses: [418]
    });

    // Should have retried on 418 (3 total attempts)
    expect(calls).toBe(3);
    expect(response.status).toBe(418);
  });

  it('blocks http:// for remote hosts', async () => {
    await expect(
      ProviderHttpClient.request({
        url: 'http://api.openai.com/v1/chat',
        provider: 'openai',
        operation: 'insecure-test'
      })
    ).rejects.toThrow(/insecure http/i);
  });

  it('allows http:// for localhost', async () => {
    const response = await ProviderHttpClient.request({
      url: 'http://localhost:11434/api/generate',
      provider: 'ollama',
      operation: 'local-test'
    });

    expect(response.ok).toBe(true);
  });

  it('allows http:// for 127.0.0.1', async () => {
    const response = await ProviderHttpClient.request({
      url: 'http://127.0.0.1:1234/v1/chat',
      provider: 'lmstudio',
      operation: 'local-ip-test'
    });

    expect(response.ok).toBe(true);
  });

  it('assertOk includes status in error for different codes', () => {
    const error403 = (() => {
      try {
        ProviderHttpClient.assertOk({
          ok: false,
          status: 403,
          headers: {},
          text: 'forbidden',
          json: null,
          arrayBuffer: new ArrayBuffer(0)
        });
      } catch (e) {
        return e as HttpErrorResponse;
      }
    })();

    expect(error403).toBeInstanceOf(ProviderHttpError);
    expect(error403.response.status).toBe(403);
    expect(error403.message).toContain('403');
  });

  it('assertOk uses custom message when provided', () => {
    expect(() =>
      ProviderHttpClient.assertOk(
        {
          ok: false,
          status: 422,
          headers: {},
          text: 'unprocessable',
          json: null,
          arrayBuffer: new ArrayBuffer(0)
        },
        'Custom validation error'
      )
    ).toThrow('Custom validation error');
  });
});
