/**
 * GroqAdapter characterization tests.
 *
 * Pin current behavior of the OpenAI-compatible chat completions adapter
 * (non-streaming generate, SSE streaming with tool-call accumulation, error
 * mapping, API-key handling) ahead of shared-code extraction.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { GroqAdapter } from '../../src/services/llm/adapters/groq/GroqAdapter';
import { GROQ_DEFAULT_MODEL } from '../../src/services/llm/adapters/groq/GroqModels';
import { LLMProviderError, TokenUsage } from '../../src/services/llm/adapters/types';
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

describe('GroqAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('non-streaming generate', () => {
    it('parses chat completion text, usage (with Groq timing metrics), and finish reason', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 3,
            total_tokens: 10,
            queue_time: 0.01,
            prompt_time: 0.02,
            completion_time: 0.03
          }
        });
      });

      const adapter = new GroqAdapter('gsk-test');
      const result = await adapter.generateUncached('hi', { systemPrompt: 'Be brief' });

      expect(result.text).toBe('Hi there');
      expect(result.model).toBe(GROQ_DEFAULT_MODEL);
      expect(result.provider).toBe('groq');
      expect(result.finishReason).toBe('stop');
      const usage = result.usage as TokenUsage & { queueTime?: number; promptTime?: number; completionTime?: number };
      expect(usage.promptTokens).toBe(7);
      expect(usage.completionTokens).toBe(3);
      expect(usage.totalTokens).toBe(10);
      expect(usage.queueTime).toBe(0.01);
      expect(usage.promptTime).toBe(0.02);
      expect(usage.completionTime).toBe(0.03);

      expect(requests[0].url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(requests[0].headers?.['Authorization']).toBe('Bearer gsk-test');
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.messages).toEqual([
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'hi' }
      ]);
    });

    it('maps length finish reason and unknown reasons to length/stop respectively', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, {
        choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }]
      }));
      const adapter = new GroqAdapter('gsk-test');
      expect((await adapter.generateUncached('hi')).finishReason).toBe('length');

      __setRequestUrlMock(async () => jsonResponse(200, {
        choices: [{ message: { content: 'x' }, finish_reason: 'some_future_reason' }]
      }));
      expect((await adapter.generateUncached('hi')).finishReason).toBe('stop');
    });
  });

  describe('SSE streaming', () => {
    it('yields content deltas and final usage from x_groq metadata', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' world' } }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          x_groq: { usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }
        },
        '[DONE]'
      )));

      const adapter = new GroqAdapter('gsk-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      expect(concatContent(chunks)).toBe('Hello world');
      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.usage).toEqual({ promptTokens: 7, completionTokens: 2, totalTokens: 9 });
    });

    it('accumulates incremental tool-call deltas into the final chunk', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '' } }]
            }
          }]
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]'
      )));

      const adapter = new GroqAdapter('gsk-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      // Initial yield when the tool call first appears
      const initial = chunks.find(chunk => !chunk.complete && chunk.toolCalls);
      expect(initial?.toolCalls?.[0].function.name).toBe('search');

      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.toolCallsReady).toBe(true);
      expect(final.toolCalls).toEqual([
        { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }
      ]);
    });

    it('ignores conversationHistory and rebuilds messages from the prompt (current behavior)', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'));
      });

      const adapter = new GroqAdapter('gsk-test');
      await collect(adapter.generateStreamAsync('current prompt', {
        systemPrompt: 'SYS',
        conversationHistory: [
          { role: 'user', content: 'earlier turn' },
          { role: 'assistant', content: 'earlier answer' }
        ]
      }));

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.messages).toEqual([
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'current prompt' }
      ]);
    });

    it('rethrows streaming HTTP errors as raw ProviderHttpError (not LLMProviderError)', async () => {
      __setRequestUrlMock(async () => jsonResponse(401, { error: { message: 'Invalid API key' } }));

      const adapter = new GroqAdapter('gsk-bad');
      const error = await captureError(collect(adapter.generateStreamAsync('hi')));

      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as ProviderHttpError).response.status).toBe(401);
    });
  });

  describe('error mapping (non-streaming)', () => {
    it.each([
      [401, 'AUTHENTICATION_ERROR', 'Invalid API key'],
      [429, 'RATE_LIMIT_ERROR', 'Rate limit exceeded'],
      [500, 'SERVER_ERROR', 'Internal error']
    ])('maps HTTP %i to %s', async (status, code, providerMessage) => {
      __setRequestUrlMock(async () => jsonResponse(status, { error: { message: providerMessage } }));

      const adapter = new GroqAdapter('gsk-test');
      const error = await captureError(adapter.generateUncached('hi')) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe(code);
      expect(error.provider).toBe('groq');
      expect(error.message).toBe(`generation failed: ${providerMessage}`);
    });
  });

  describe('config / API key handling', () => {
    it('masks the API key and reports NOT_SET when missing', () => {
      expect(new GroqAdapter('gsk-test-5678').getApiKey()).toBe('***5678');
      expect(new GroqAdapter('').getApiKey()).toBe('NOT_SET');
    });

    it('isAvailable is false without an API key and true with one (static listModels)', async () => {
      await expect(new GroqAdapter('').isAvailable()).resolves.toBe(false);
      await expect(new GroqAdapter('gsk-test').isAvailable()).resolves.toBe(true);
    });

    it('lists static models with supportsThinking forced to false', async () => {
      const adapter = new GroqAdapter('gsk-test');
      const models = await adapter.listModels();

      expect(models.length).toBeGreaterThan(0);
      expect(models.every(model => model.supportsThinking === false)).toBe(true);
      expect(models[0].pricing.currency).toBe('USD');
    });
  });
});
