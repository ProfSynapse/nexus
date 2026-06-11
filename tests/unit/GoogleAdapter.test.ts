/**
 * GoogleAdapter characterization tests.
 *
 * Pin current behavior of the Gemini generateContent adapter (non-streaming
 * generate, SSE streaming including thought parts and functionCall parts,
 * finish-reason mapping including blocked-response surfacing, withRetry-wrapped
 * error mapping, API-key handling) ahead of shared-code extraction.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { GoogleAdapter } from '../../src/services/llm/adapters/google/GoogleAdapter';
import { GOOGLE_DEFAULT_MODEL } from '../../src/services/llm/adapters/google/GoogleModels';
import { LLMProviderError } from '../../src/services/llm/adapters/types';
import { ProviderHttpError } from '../../src/services/llm/adapters/shared/ProviderHttpClient';
import {
  jsonResponse,
  sseResponse,
  sse,
  collect,
  concatContent,
  captureError,
  CapturedRequest
} from './helpers/llmAdapterTestHarness';

describe('GoogleAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    jest.useRealTimers();
  });

  describe('non-streaming generate', () => {
    it('parses candidate parts, usageMetadata, and maps STOP', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          candidates: [{
            content: { parts: [{ text: 'Hi' }, { text: ' there' }] },
            finishReason: 'STOP'
          }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }
        });
      });

      const adapter = new GoogleAdapter('gk-test');
      const result = await adapter.generateUncached('hi', { systemPrompt: 'Be brief' });

      expect(result.text).toBe('Hi there');
      expect(result.model).toBe(GOOGLE_DEFAULT_MODEL);
      expect(result.provider).toBe('google');
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });

      expect(requests[0].url).toBe(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GOOGLE_DEFAULT_MODEL)}:generateContent`
      );
      expect(requests[0].headers?.['x-goog-api-key']).toBe('gk-test');
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
      expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief' }] });
    });

    it('maps MAX_TOKENS to length and SAFETY to content_filter', async () => {
      const adapter = new GoogleAdapter('gk-test');

      __setRequestUrlMock(async () => jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }]
      }));
      expect((await adapter.generateUncached('hi')).finishReason).toBe('length');

      __setRequestUrlMock(async () => jsonResponse(200, {
        candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }]
      }));
      expect((await adapter.generateUncached('hi')).finishReason).toBe('content_filter');
    });
  });

  describe('SSE streaming', () => {
    it('yields content, thought parts as reasoning, function calls, and final usage', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse(
          { candidates: [{ content: { parts: [{ thought: 'pondering' }] } }] },
          { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] },
          { candidates: [{ content: { parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }] } }] },
          {
            candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 }
          }
        ));
      });

      const adapter = new GoogleAdapter('gk-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      expect(requests[0].url).toContain(':streamGenerateContent?alt=sse');
      expect(concatContent(chunks)).toBe('Hello!');

      const reasoningChunk = chunks.find(chunk => chunk.reasoning !== undefined);
      expect(reasoningChunk).toMatchObject({ reasoning: 'pondering', reasoningComplete: false });

      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
      expect(final.toolCallsReady).toBe(true);
      expect(final.toolCalls).toEqual([
        { id: 'search_0', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }
      ]);
    });

    it('surfaces MALFORMED_FUNCTION_CALL as user-facing error content and completes the stream', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }
      )));

      const adapter = new GoogleAdapter('gk-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      expect(concatContent(chunks)).toContain('[Error: MALFORMED_FUNCTION_CALL');
      expect(chunks[chunks.length - 1].complete).toBe(true);
    });

    it('rethrows streaming HTTP errors as raw ProviderHttpError (not LLMProviderError)', async () => {
      __setRequestUrlMock(async () => jsonResponse(401, { error: { message: 'API key not valid' } }));

      const adapter = new GoogleAdapter('gk-bad');
      const error = await captureError(collect(adapter.generateStreamAsync('hi')));

      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as ProviderHttpError).response.status).toBe(401);
    });
  });

  describe('error mapping (non-streaming, withRetry-wrapped)', () => {
    it('maps HTTP 401 to AUTHENTICATION_ERROR without retrying', async () => {
      let calls = 0;
      __setRequestUrlMock(async () => {
        calls++;
        return jsonResponse(401, { error: { message: 'API key not valid' } });
      });

      const adapter = new GoogleAdapter('gk-bad');
      const error = await captureError(adapter.generateUncached('hi')) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe('AUTHENTICATION_ERROR');
      expect(error.provider).toBe('google');
      expect(error.message).toBe('generation failed: API key not valid');
      expect(calls).toBe(1);
    });

    it.each([
      [429, 'RATE_LIMIT_ERROR', 'Resource has been exhausted'],
      [500, 'SERVER_ERROR', 'Internal error']
    ])('retries HTTP %i three times before failing with %s', async (status, code, providerMessage) => {
      jest.useFakeTimers();
      let calls = 0;
      __setRequestUrlMock(async () => {
        calls++;
        return jsonResponse(status, { error: { message: providerMessage } });
      });

      const adapter = new GoogleAdapter('gk-test');
      const settled = adapter.generateUncached('hi').then(
        () => null,
        (error: unknown) => error
      );
      await jest.runAllTimersAsync();
      const error = await settled as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe(code);
      expect(error.message).toBe(`generation failed: ${providerMessage}`);
      expect(calls).toBe(4);
    });
  });

  describe('config / API key handling', () => {
    it('masks the API key and reports NOT_SET when missing', () => {
      expect(new GoogleAdapter('gk-test-7777').getApiKey()).toBe('***7777');
      expect(new GoogleAdapter('').getApiKey()).toBe('NOT_SET');
    });

    it('isAvailable is false without an API key and true with one (static listModels)', async () => {
      await expect(new GoogleAdapter('').isAvailable()).resolves.toBe(false);
      await expect(new GoogleAdapter('gk-test').isAvailable()).resolves.toBe(true);
    });

    it('lists static models with capability-driven supportsThinking', async () => {
      const adapter = new GoogleAdapter('gk-test');
      const models = await adapter.listModels();

      expect(models.length).toBeGreaterThan(0);
      expect(models[0].pricing.currency).toBe('USD');
    });
  });
});
