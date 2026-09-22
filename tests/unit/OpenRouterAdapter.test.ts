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
      expect(result.model).toBe('openai/gpt-5.6-sol');
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

    it('requests reasoning and exposes the non-streaming reasoning string', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          choices: [{ message: { content: 'Answer', reasoning: 'Working it out' }, finish_reason: 'stop' }]
        });
      });

      const result = await new OpenRouterAdapter('or-test').generateUncached('hi', {
        enableThinking: true,
        thinkingEffort: 'high'
      });

      expect(JSON.parse(requests[0].body ?? '{}').reasoning).toEqual({ effort: 'high', exclude: false });
      expect(result.metadata?.thinking).toBe('Working it out');
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
    it('completes on [DONE] so the usage frame that follows finish_reason lands on the completion chunk', async () => {
      // Real OpenRouter frame order with `usage: { include: true }`: the
      // finish_reason frame, THEN a usage-only frame (tokens, cached_tokens,
      // cost), then [DONE]. Completing at finish_reason used to drop the usage
      // frame and leave every OpenRouter turn with no tokens or cost until the
      // out-of-band generation fetch — which the orchestrator path never wires.
      __setRequestUrlMock(async () => sseResponse(sse(
        { id: 'gen-1', choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 5300, completion_tokens: 7, total_tokens: 5307,
            prompt_tokens_details: { cached_tokens: 5000 },
            completion_tokens_details: { reasoning_tokens: 3 },
            cost: 0.00123
          }
        },
        '[DONE]'
      )));

      const adapter = new OpenRouterAdapter('or-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      expect(concatContent(chunks)).toBe('Hello');
      expect(chunks.filter(c => c.complete)).toHaveLength(1);
      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.usage).toMatchObject({
        promptTokens: 5300,
        completionTokens: 7,
        totalTokens: 5307,
        cacheReadTokens: 5000,
        reasoningTokens: 3,
        providerCost: { totalCost: 0.00123, currency: 'USD' },
      });
    });

    it('still completes (with tool calls) when the stream ends without [DONE]', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
      )));

      const adapter = new OpenRouterAdapter('or-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.toolCallsReady).toBe(true);
      expect(final.toolCalls?.[0]).toMatchObject({ id: 'call_1', function: { name: 'f' } });
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

    it('yields the documented plain reasoning field and sends the selected effort', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse(
          { choices: [{ delta: { reasoning: 'Let me think' } }] },
          { choices: [{ delta: { content: 'Answer' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          '[DONE]'
        ));
      });

      const chunks = await collect(new OpenRouterAdapter('or-test').generateStreamAsync('hi', {
        enableThinking: true,
        thinkingEffort: 'low'
      }));

      expect(chunks.find(chunk => chunk.reasoning === 'Let me think')).toBeDefined();
      expect(JSON.parse(requests[0].body ?? '{}').reasoning).toEqual({ effort: 'low', exclude: false });
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

    it('marks the system message as an Anthropic cache breakpoint for anthropic/* models only', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'));
      });

      const adapter = new OpenRouterAdapter('or-test');
      await collect(adapter.generateStreamAsync('hi', { model: 'anthropic/claude-haiku-4-5', systemPrompt: 'SYS' }));
      await collect(adapter.generateStreamAsync('hi', { model: 'openai/gpt-5.6-sol', systemPrompt: 'SYS' }));

      const anthropicBody = JSON.parse(requests[0].body ?? '{}');
      expect(anthropicBody.messages[0]).toEqual({
        role: 'system',
        content: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]
      });
      expect(anthropicBody.messages[1]).toEqual({ role: 'user', content: 'hi' });

      const openaiBody = JSON.parse(requests[1].body ?? '{}');
      expect(openaiBody.messages[0]).toEqual({ role: 'system', content: 'SYS' });
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
