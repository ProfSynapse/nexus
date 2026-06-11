/**
 * MistralAdapter characterization tests.
 *
 * Pin current behavior (non-streaming generate including content-part arrays,
 * SSE streaming, finish-reason passthrough, error mapping, API-key handling)
 * ahead of shared-code extraction.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { MistralAdapter } from '../../src/services/llm/adapters/mistral/MistralAdapter';
import { MISTRAL_DEFAULT_MODEL } from '../../src/services/llm/adapters/mistral/MistralModels';
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

describe('MistralAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('non-streaming generate', () => {
    it('parses chat completion text, usage, and request shape', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          choices: [{ message: { content: 'Bonjour' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        });
      });

      const adapter = new MistralAdapter('mk-test');
      const result = await adapter.generateUncached('hi', { systemPrompt: 'Be brief' });

      expect(result.text).toBe('Bonjour');
      expect(result.model).toBe(MISTRAL_DEFAULT_MODEL);
      expect(result.provider).toBe('mistral');
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });

      expect(requests[0].url).toBe('https://api.mistral.ai/v1/chat/completions');
      expect(requests[0].headers?.['Authorization']).toBe('Bearer mk-test');
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.messages).toEqual([
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'hi' }
      ]);
    });

    it('joins text parts when message content is a content-part array', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, {
        choices: [{
          message: {
            content: [
              { type: 'text', text: 'A' },
              { type: 'image_url' },
              { type: 'text', text: 'B' }
            ]
          },
          finish_reason: 'stop'
        }]
      }));

      const adapter = new MistralAdapter('mk-test');
      const result = await adapter.generateUncached('hi');
      expect(result.text).toBe('AB');
    });

    it('passes provider finish reasons through unmapped (current behavior)', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, {
        choices: [{ message: { content: 'x' }, finish_reason: 'model_length' }]
      }));

      const adapter = new MistralAdapter('mk-test');
      const result = await adapter.generateUncached('hi');
      // Mistral's private mapFinishReason is dead code; raw value flows through
      expect(result.finishReason).toBe('model_length');
    });

    it('throws when choices are missing', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, { choices: [] }));

      const adapter = new MistralAdapter('mk-test');
      const error = await captureError(adapter.generateUncached('hi')) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe('UNKNOWN_ERROR');
      expect(error.message).toBe('generation failed: No response from Mistral');
    });
  });

  describe('SSE streaming', () => {
    it('yields content deltas and final usage', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { choices: [{ delta: { content: 'Bon' } }] },
        { choices: [{ delta: { content: 'jour' } }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
        },
        '[DONE]'
      )));

      const adapter = new MistralAdapter('mk-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      expect(concatContent(chunks)).toBe('Bonjour');
      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.usage).toEqual({ promptTokens: 4, completionTokens: 2, totalTokens: 6 });
    });

    it('prepends the system prompt to conversationHistory when missing', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'));
      });

      const adapter = new MistralAdapter('mk-test');
      await collect(adapter.generateStreamAsync('ignored', {
        systemPrompt: 'SYS',
        conversationHistory: [{ role: 'user', content: 'earlier turn' }]
      }));

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.messages).toEqual([
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'earlier turn' }
      ]);
    });

    it('rethrows streaming HTTP errors as raw ProviderHttpError (not LLMProviderError)', async () => {
      __setRequestUrlMock(async () => jsonResponse(429, { message: 'Requests rate limit exceeded' }));

      const adapter = new MistralAdapter('mk-test');
      const error = await captureError(collect(adapter.generateStreamAsync('hi')));

      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as ProviderHttpError).response.status).toBe(429);
    });
  });

  describe('error mapping (non-streaming)', () => {
    it.each([
      [401, 'AUTHENTICATION_ERROR', 'Unauthorized'],
      [429, 'RATE_LIMIT_ERROR', 'Requests rate limit exceeded'],
      [500, 'SERVER_ERROR', 'Internal error']
    ])('maps HTTP %i to %s', async (status, code, providerMessage) => {
      __setRequestUrlMock(async () => jsonResponse(status, { error: { message: providerMessage } }));

      const adapter = new MistralAdapter('mk-test');
      const error = await captureError(adapter.generateUncached('hi')) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe(code);
      expect(error.provider).toBe('mistral');
      expect(error.message).toBe(`generation failed: ${providerMessage}`);
    });
  });

  describe('config / API key handling', () => {
    it('masks the API key and reports NOT_SET when missing', () => {
      expect(new MistralAdapter('mk-test-9999').getApiKey()).toBe('***9999');
      expect(new MistralAdapter('').getApiKey()).toBe('NOT_SET');
    });

    it('isAvailable is false without an API key and true with one (static listModels)', async () => {
      await expect(new MistralAdapter('').isAvailable()).resolves.toBe(false);
      await expect(new MistralAdapter('mk-test').isAvailable()).resolves.toBe(true);
    });

    it('lists static models with supportsThinking forced to false', async () => {
      const adapter = new MistralAdapter('mk-test');
      const models = await adapter.listModels();

      expect(models.length).toBeGreaterThan(0);
      expect(models.every(model => model.supportsThinking === false)).toBe(true);
    });
  });
});
