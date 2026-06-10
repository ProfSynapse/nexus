/**
 * AnthropicAdapter characterization tests.
 *
 * Pin current behavior of the Messages API adapter (non-streaming generate,
 * SSE event streaming including thinking and tool_use blocks, withRetry-wrapped
 * error mapping, API-key handling) ahead of shared-code extraction.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { AnthropicAdapter } from '../../src/services/llm/adapters/anthropic/AnthropicAdapter';
import { ANTHROPIC_DEFAULT_MODEL } from '../../src/services/llm/adapters/anthropic/AnthropicModels';
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

describe('AnthropicAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    jest.useRealTimers();
  });

  describe('non-streaming generate', () => {
    it('parses text and thinking blocks, maps end_turn, and derives totalTokens', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          model: 'claude-test-model',
          content: [
            { type: 'thinking', thinking: 'pondering' },
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' world' }
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 }
        });
      });

      const adapter = new AnthropicAdapter('ak-test');
      const result = await adapter.generateUncached('hi', { systemPrompt: 'Be brief' });

      expect(result.text).toBe('Hello world');
      expect(result.model).toBe('claude-test-model');
      expect(result.provider).toBe('anthropic');
      expect(result.finishReason).toBe('stop');
      // totalTokens is derived as input + output (Anthropic sends no total)
      expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
      expect(result.metadata?.thinking).toBe('pondering');

      expect(requests[0].url).toBe('https://api.anthropic.com/v1/messages');
      expect(requests[0].headers?.['x-api-key']).toBe('ak-test');
      expect(requests[0].headers?.['anthropic-version']).toBe('2023-06-01');
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.system).toBe('Be brief');
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
      expect(body.max_tokens).toBe(4096);
    });

    it('extracts tool_use blocks into toolCalls with stringified input', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, {
        content: [
          { type: 'text', text: 'Using a tool' },
          { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } }
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 4, output_tokens: 2 }
      }));

      const adapter = new AnthropicAdapter('ak-test');
      const result = await adapter.generateUncached('hi');

      expect(result.finishReason).toBe('tool_calls');
      expect(result.toolCalls).toEqual([
        { id: 'toolu_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }
      ]);
    });

    it('falls back to the current model when the response omits model', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn'
      }));

      const adapter = new AnthropicAdapter('ak-test');
      const result = await adapter.generateUncached('hi');
      expect(result.model).toBe(ANTHROPIC_DEFAULT_MODEL);
    });
  });

  describe('SSE streaming', () => {
    it('yields text deltas, thinking deltas, accumulated tool calls, and final usage', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
        { type: 'message_delta', usage: { input_tokens: 10, output_tokens: 5 } },
        { type: 'message_stop' }
      )));

      const adapter = new AnthropicAdapter('ak-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      expect(concatContent(chunks)).toBe('Hello');

      const reasoningChunks = chunks.filter(chunk => chunk.reasoning !== undefined);
      expect(reasoningChunks[0]).toMatchObject({ reasoning: 'hmm', reasoningComplete: false });
      expect(reasoningChunks[1]).toMatchObject({ reasoning: '', reasoningComplete: true });

      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      // Anthropic streaming usage has no total_tokens; totalTokens stays 0
      expect(final.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 0 });
      expect(final.toolCallsReady).toBe(true);
      // Current behavior: the synthetic id from input_json_delta overwrites
      // the real tool_use id supplied by content_block_start
      expect(final.toolCalls).toEqual([
        { id: 'anthropic-tool-2', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }
      ]);
    });

    it('rethrows streaming HTTP errors as raw ProviderHttpError (not LLMProviderError)', async () => {
      __setRequestUrlMock(async () => jsonResponse(401, { error: { message: 'invalid x-api-key' } }));

      const adapter = new AnthropicAdapter('ak-bad');
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
        return jsonResponse(401, { error: { message: 'invalid x-api-key' } });
      });

      const adapter = new AnthropicAdapter('ak-bad');
      const error = await captureError(adapter.generateUncached('hi')) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe('AUTHENTICATION_ERROR');
      expect(error.provider).toBe('anthropic');
      expect(error.message).toBe('generation failed: invalid x-api-key');
      expect(calls).toBe(1);
    });

    it.each([
      [429, 'RATE_LIMIT_ERROR', 'rate limited'],
      [500, 'SERVER_ERROR', 'overloaded']
    ])('retries HTTP %i three times before failing with %s', async (status, code, providerMessage) => {
      jest.useFakeTimers();
      let calls = 0;
      __setRequestUrlMock(async () => {
        calls++;
        return jsonResponse(status, { error: { message: providerMessage } });
      });

      const adapter = new AnthropicAdapter('ak-test');
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
      expect(new AnthropicAdapter('ak-test-4321').getApiKey()).toBe('***4321');
      expect(new AnthropicAdapter('').getApiKey()).toBe('NOT_SET');
    });

    it('isAvailable is false without an API key and true with one (static listModels)', async () => {
      await expect(new AnthropicAdapter('').isAvailable()).resolves.toBe(false);
      await expect(new AnthropicAdapter('ak-test').isAvailable()).resolves.toBe(true);
    });

    it('suffixes :1m onto ids of 1M-context models in listModels', async () => {
      const adapter = new AnthropicAdapter('ak-test');
      const models = await adapter.listModels();

      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        if (model.contextWindow >= 1000000) {
          expect(model.id.endsWith(':1m')).toBe(true);
        } else {
          expect(model.id.endsWith(':1m')).toBe(false);
        }
      }
    });
  });
});
