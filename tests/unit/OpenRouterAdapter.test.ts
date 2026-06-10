/**
 * OpenRouterAdapter characterization tests.
 *
 * Pin current behavior (non-streaming generate with OpenRouter headers and
 * usage tracking flag, SSE streaming with tool-call accumulation and
 * reasoning_details, error mapping, API-key handling) ahead of shared-code
 * extraction.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { OpenRouterAdapter } from '../../src/services/llm/adapters/openrouter/OpenRouterAdapter';
import { LLMProviderError } from '../../src/services/llm/adapters/types';
import { BRAND_NAME } from '../../src/constants/branding';
import {
  jsonResponse,
  sseResponse,
  sse,
  collect,
  concatContent,
  captureError,
  CapturedRequest
} from './helpers/llmAdapterTestHarness';

describe('OpenRouterAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('non-streaming generate', () => {
    it('parses chat completion text and usage, sending OpenRouter attribution headers', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          choices: [{ message: { content: 'Routed' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 }
        });
      });

      const adapter = new OpenRouterAdapter('or-test');
      const result = await adapter.generateUncached('hi', { systemPrompt: 'Be brief' });

      expect(result.text).toBe('Routed');
      expect(result.model).toBe('openai/gpt-5.5');
      expect(result.provider).toBe('openrouter');
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({ promptTokens: 6, completionTokens: 2, totalTokens: 8 });

      expect(requests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(requests[0].headers?.['Authorization']).toBe('Bearer or-test');
      expect(requests[0].headers?.['HTTP-Referer']).toBe('https://synapticlabs.ai');
      expect(requests[0].headers?.['X-Title']).toBe(BRAND_NAME);
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.usage).toEqual({ include: true });
      expect(body.messages).toEqual([
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'hi' }
      ]);
    });

    it('throws UNKNOWN_ERROR when the response has no choices', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, { choices: [] }));

      const adapter = new OpenRouterAdapter('or-test');
      const error = await captureError(adapter.generateUncached('hi')) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe('UNKNOWN_ERROR');
      expect(error.message).toBe('generation failed: OpenRouter generation returned an empty response');
    });
  });

  describe('SSE streaming', () => {
    it('yields content deltas and completes without usage (fetched async via generation id)', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { id: 'gen-1', choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]'
      )));

      const adapter = new OpenRouterAdapter('or-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      expect(concatContent(chunks)).toBe('Hello');
      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.usage).toBeUndefined();
    });

    it('accumulates incremental tool-call deltas into the final chunk', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call_or_1', type: 'function', function: { name: 'search', arguments: '' } }]
            }
          }]
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]'
      )));

      const adapter = new OpenRouterAdapter('or-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.toolCallsReady).toBe(true);
      expect(final.toolCalls).toEqual([
        { id: 'call_or_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }
      ]);
    });

    it('yields reasoning.text entries from reasoning_details as reasoning chunks', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'Let me think' }] } }] },
        { choices: [{ delta: { content: 'Answer' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]'
      )));

      const adapter = new OpenRouterAdapter('or-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      const reasoningChunk = chunks.find(chunk => chunk.reasoning !== undefined);
      expect(reasoningChunk).toMatchObject({ reasoning: 'Let me think', reasoningComplete: false });
      expect(concatContent(chunks)).toBe('Answer');
    });

    it('prepends the system prompt to conversationHistory when missing', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'));
      });

      const adapter = new OpenRouterAdapter('or-test');
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

    it('maps streaming HTTP errors through handleError to LLMProviderError', async () => {
      __setRequestUrlMock(async () => jsonResponse(401, { error: { message: 'No auth credentials found' } }));

      const adapter = new OpenRouterAdapter('or-bad');
      const error = await captureError(collect(adapter.generateStreamAsync('hi'))) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe('AUTHENTICATION_ERROR');
      expect(error.message).toBe('streaming generation failed: No auth credentials found');
    });
  });

  describe('error mapping (non-streaming)', () => {
    it.each([
      [401, 'AUTHENTICATION_ERROR', 'No auth credentials found'],
      [429, 'RATE_LIMIT_ERROR', 'Rate limit exceeded'],
      [500, 'SERVER_ERROR', 'Internal error']
    ])('maps HTTP %i to %s', async (status, code, providerMessage) => {
      __setRequestUrlMock(async () => jsonResponse(status, { error: { message: providerMessage } }));

      const adapter = new OpenRouterAdapter('or-test');
      const error = await captureError(adapter.generateUncached('hi')) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe(code);
      expect(error.provider).toBe('openrouter');
      expect(error.message).toBe(`generation failed: ${providerMessage}`);
    });
  });

  describe('config / API key handling', () => {
    it('masks the API key and reports NOT_SET when missing', () => {
      expect(new OpenRouterAdapter('or-test-2468').getApiKey()).toBe('***2468');
      expect(new OpenRouterAdapter('').getApiKey()).toBe('NOT_SET');
    });

    it('isAvailable is false without an API key and true with one (registry-backed listModels)', async () => {
      await expect(new OpenRouterAdapter('').isAvailable()).resolves.toBe(false);
      await expect(new OpenRouterAdapter('or-test').isAvailable()).resolves.toBe(true);
    });
  });
});
