/**
 * DeepSeekAdapter characterization tests.
 *
 * Pin current behavior (non-streaming generate with reasoning_content and
 * cache-hit usage, thinking-mode request shaping, SSE streaming with
 * reasoning deltas, error mapping, API-key handling) ahead of shared-code
 * extraction.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { DeepSeekAdapter } from '../../src/services/llm/adapters/deepseek/DeepSeekAdapter';
import { DEEPSEEK_DEFAULT_MODEL } from '../../src/services/llm/adapters/deepseek/DeepSeekModels';
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

describe('DeepSeekAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('non-streaming generate', () => {
    it('parses content, reasoning_content metadata, and cache-hit usage', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          choices: [{
            message: { content: 'Answer', reasoning_content: 'step by step' },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 9,
            completion_tokens: 4,
            total_tokens: 13,
            prompt_cache_hit_tokens: 6
          }
        });
      });

      const adapter = new DeepSeekAdapter('dk-test');
      const result = await adapter.generateUncached('hi', { systemPrompt: 'Be brief' });

      expect(result.text).toBe('Answer');
      expect(result.model).toBe(DEEPSEEK_DEFAULT_MODEL);
      expect(result.provider).toBe('deepseek');
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({
        promptTokens: 9,
        completionTokens: 4,
        totalTokens: 13,
        cachedTokens: 6
      });
      expect(result.metadata?.reasoning).toBe('step by step');
      expect(result.metadata?.apiModel).toBe(DEEPSEEK_DEFAULT_MODEL);

      expect(requests[0].url).toBe('https://api.deepseek.com/chat/completions');
      expect(requests[0].headers?.['Authorization']).toBe('Bearer dk-test');
    });

    it('strips the -thinking suffix on the wire while keeping the user-facing model id', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
        });
      });

      const adapter = new DeepSeekAdapter('dk-test');
      const result = await adapter.generateUncached('hi', { model: 'deepseek-v4-flash-thinking' });

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.model).toBe('deepseek-v4-flash');
      expect(body.thinking).toEqual({ type: 'enabled', reasoning_effort: 'high' });
      expect(result.model).toBe('deepseek-v4-flash-thinking');
      expect(result.metadata?.apiModel).toBe('deepseek-v4-flash');
    });

    it('never forwards frequency/presence penalties and drops undefined keys', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
        });
      });

      const adapter = new DeepSeekAdapter('dk-test');
      await adapter.generateUncached('hi', { frequencyPenalty: 0.5, presencePenalty: 0.5 });

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body).not.toHaveProperty('frequency_penalty');
      expect(body).not.toHaveProperty('presence_penalty');
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('stop');
    });
  });

  describe('SSE streaming', () => {
    it('yields reasoning_content deltas as reasoning and content deltas as text', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { choices: [{ delta: { reasoning_content: 'thinking...' } }] },
        { choices: [{ delta: { content: 'Ans' } }] },
        { choices: [{ delta: { content: 'wer' } }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
        },
        '[DONE]'
      )));

      const adapter = new DeepSeekAdapter('dk-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      const reasoningChunk = chunks.find(chunk => chunk.reasoning !== undefined);
      expect(reasoningChunk).toMatchObject({ reasoning: 'thinking...', reasoningComplete: false });
      expect(concatContent(chunks)).toBe('Answer');

      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
    });

    it('prepends the system prompt to conversationHistory when missing', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'));
      });

      const adapter = new DeepSeekAdapter('dk-test');
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
      __setRequestUrlMock(async () => jsonResponse(401, { error: { message: 'Authentication Fails' } }));

      const adapter = new DeepSeekAdapter('dk-bad');
      const error = await captureError(collect(adapter.generateStreamAsync('hi')));

      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as ProviderHttpError).response.status).toBe(401);
    });
  });

  describe('error mapping (non-streaming)', () => {
    it.each([
      [401, 'AUTHENTICATION_ERROR', 'Authentication Fails'],
      [429, 'RATE_LIMIT_ERROR', 'Rate limit reached'],
      [500, 'SERVER_ERROR', 'Internal error']
    ])('maps HTTP %i to %s', async (status, code, providerMessage) => {
      __setRequestUrlMock(async () => jsonResponse(status, { error: { message: providerMessage } }));

      const adapter = new DeepSeekAdapter('dk-test');
      const error = await captureError(adapter.generateUncached('hi')) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe(code);
      expect(error.provider).toBe('deepseek');
      expect(error.message).toBe(`generation failed: ${providerMessage}`);
    });
  });

  describe('config / API key handling', () => {
    it('masks the API key and reports NOT_SET when missing', () => {
      expect(new DeepSeekAdapter('dk-test-1357').getApiKey()).toBe('***1357');
      expect(new DeepSeekAdapter('').getApiKey()).toBe('NOT_SET');
    });

    it('isAvailable is false without an API key and true with one (static listModels)', async () => {
      await expect(new DeepSeekAdapter('').isAvailable()).resolves.toBe(false);
      await expect(new DeepSeekAdapter('dk-test').isAvailable()).resolves.toBe(true);
    });
  });
});
