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
import { getContextBuilder } from '../../src/services/chat/builders/ContextBuilderFactory';
import { ConversationContextBuilder } from '../../src/services/chat/ConversationContextBuilder';
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

    it.each(['mistral-large-4', 'mistral-large-4-0'])('extracts %s reasoning and requests high effort', async (model) => {
      const requests: CapturedRequest[] = [];
      const assistantContent = [
        { type: 'thinking', thinking: [{ type: 'text', text: 'Consider the answer.' }] },
        { type: 'text', text: '42' }
      ];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, { choices: [{ message: { content: assistantContent }, finish_reason: 'stop' }] });
      });

      const adapter = new MistralAdapter('mk-test', model);
      const result = await adapter.generateUncached('question', { enableThinking: true, thinkingEffort: 'max' });

      expect(JSON.parse(requests[0].body ?? '{}')).toMatchObject({ model, reasoning_effort: 'high' });
      expect(result.text).toBe('42');
      expect(result.metadata).toMatchObject({ thinking: 'Consider the answer.', mistralAssistantContent: assistantContent });
    });

    it('disables Large 4 reasoning without an explicit opt-in and leaves max tokens unspecified', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, { choices: [{ message: { content: 'Direct answer' }, finish_reason: 'stop' }] });
      });

      const result = await new MistralAdapter('mk-test', 'mistral-large-4').generateUncached('question');
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.reasoning_effort).toBe('none');
      expect(body).not.toHaveProperty('max_tokens');
      expect(result.text).toBe('Direct answer');
      expect(result.metadata).toEqual({});
    });

    it('does not reuse a cached non-thinking Large 4 answer when thinking is enabled', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        const effort = JSON.parse(request.body ?? '{}').reasoning_effort;
        return jsonResponse(200, { choices: [{ message: { content: effort }, finish_reason: 'stop' }] });
      });

      const adapter = new MistralAdapter('mk-test', 'mistral-large-4');
      await adapter.clearCache();
      const withoutThinking = await adapter.generate('same prompt', { enableThinking: false });
      const withThinking = await adapter.generate('same prompt', { enableThinking: true, thinkingEffort: 'max' });

      expect(withoutThinking.text).toBe('none');
      expect(withThinking.text).toBe('high');
      expect(requests).toHaveLength(2);
    });

    it('shares the Large 4 high-effort cache entry across equivalent slider levels', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return jsonResponse(200, { choices: [{ message: { content: 'reasoned' }, finish_reason: 'stop' }] });
      });

      const adapter = new MistralAdapter('mk-test', 'mistral-large-4');
      await adapter.clearCache();
      await adapter.generate('same high prompt', { enableThinking: true, thinkingEffort: 'low' });
      await adapter.generate('same high prompt', { enableThinking: true, thinkingEffort: 'max' });

      expect(requests).toHaveLength(1);
    });

    it('does not send reasoning effort for earlier Mistral models', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, { choices: [{ message: { content: 'Old answer' }, finish_reason: 'stop' }] });
      });

      await new MistralAdapter('mk-test', MISTRAL_DEFAULT_MODEL).generateUncached('question', { enableThinking: true });
      expect(JSON.parse(requests[0].body ?? '{}')).not.toHaveProperty('reasoning_effort');
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

    it('streams Large 4 reasoning separately and retains typed assistant content for continuation', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse(
          { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Step one.' }] }] } }] },
          { choices: [{ delta: { content: [
            { type: 'thinking', thinking: [{ type: 'text', text: ' Step two.' }] },
            { type: 'text', text: 'Answer' }
          ] } }] },
          { choices: [{ delta: { content: ' complete' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          '[DONE]'
        ));
      });

      const adapter = new MistralAdapter('mk-test', 'mistral-large-4');
      const chunks = await collect(adapter.generateStreamAsync('question', { enableThinking: true, thinkingEffort: 'xhigh' }));
      const body = JSON.parse(requests[0].body ?? '{}');
      const final = chunks[chunks.length - 1];
      expect(body.reasoning_effort).toBe('high');
      expect(body).not.toHaveProperty('max_tokens');
      expect(concatContent(chunks)).toBe('Answer complete');
      expect(chunks.filter(chunk => chunk.reasoning).map(chunk => chunk.reasoning).join('')).toBe('Step one. Step two.');
      expect(chunks.some(chunk => chunk.reasoningComplete)).toBe(true);
      expect(final.metadata?.thinking).toBe('Step one. Step two.');
      expect(final.metadata?.mistralAssistantContent).toEqual([
        { type: 'thinking', thinking: [
          { type: 'text', text: 'Step one.' },
          { type: 'text', text: ' Step two.' }
        ] },
        { type: 'text', text: 'Answer complete' }
      ]);
    });

    it('passes typed assistant history and image input through the Large 4 streaming request', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'));
      });
      const assistantContent = [
        { type: 'thinking', thinking: [{ type: 'text', text: 'Earlier reasoning' }] },
        { type: 'text', text: 'Earlier answer' }
      ];
      const history = [
        { role: 'user', content: [{ type: 'text', text: 'What is in the image?' }, { type: 'image_url', image_url: 'https://example.org/image.png' }] },
        { role: 'assistant', content: assistantContent }
      ];
      await collect(new MistralAdapter('mk-test', 'mistral-large-4').generateStreamAsync('follow-up', {
        conversationHistory: history,
        enableThinking: true
      }));

      expect(JSON.parse(requests[0].body ?? '{}').messages).toEqual(history);
    });

    it('replays emitted thinking chunks with tool calls in the actual continuation request', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse(
          { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Use a tool.' }] }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_lookup', function: { name: 'lookup', arguments: '{}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          '[DONE]'
        ));
      });

      const adapter = new MistralAdapter('mk-test', 'mistral-large-4');
      const first = await collect(adapter.generateStreamAsync('question', { enableThinking: true }));
      const toolCalls = first[first.length - 1].toolCalls ?? [];
      expect(toolCalls[0].mistral_assistant_content).toEqual([
        { type: 'thinking', thinking: [{ type: 'text', text: 'Use a tool.' }] }
      ]);

      const history = ConversationContextBuilder.buildToolContinuation(
        'mistral', '', toolCalls,
        [{ id: 'call_lookup', success: true, result: { answer: 42 } }],
        [{ role: 'user', content: 'question' }]
      );
      await collect(adapter.generateStreamAsync('', { conversationHistory: history as unknown as Array<Record<string, unknown>>, enableThinking: true }));
      const second = JSON.parse(requests[1].body ?? '{}');
      expect(second.messages[1]).toMatchObject({
        role: 'assistant',
        content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Use a tool.' }] }],
        tool_calls: [{ id: 'call_lookup', function: { name: 'lookup', arguments: '{}' } }]
      });
      expect(second.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_lookup' });
    });

    it('replays persisted assistant chunks only through Mistral-compatible context builders', () => {
      const storedContent = [
        { type: 'thinking', thinking: [{ type: 'text', text: 'Stored thought' }] },
        { type: 'text', text: 'Stored answer' }
      ];
      const toolCall = {
        id: 'call_lookup',
        type: 'function' as const,
        function: { name: 'lookup', arguments: '{}' },
        mistral_assistant_content: storedContent
      };
      const result = [{ id: 'call_lookup', success: true, result: { ok: true } }];
      const prior = [{ role: 'user' as const, content: 'question' }];

      expect(getContextBuilder('requesty', 'mistral/mistral-large-4')
        .buildToolContinuation('', [toolCall], result, prior)[1]).toMatchObject({ content: storedContent });
      expect(getContextBuilder('requesty', 'openai/gpt-5')
        .buildToolContinuation('', [toolCall], result, prior)[1]).toMatchObject({ content: '' });
      expect(getContextBuilder('openai')
        .buildToolContinuation('', [toolCall], result, prior)[1]).toMatchObject({ content: '' });

      const conversation = {
        id: 'conversation', title: 'Question', created: 1, updated: 2,
        messages: [
          { id: 'user', conversationId: 'conversation', role: 'user' as const, content: 'question', timestamp: 1 },
          { id: 'assistant', conversationId: 'conversation', role: 'assistant' as const,
            content: 'Stored answer', timestamp: 2, metadata: { mistralAssistantContent: storedContent } }
        ]
      };
      expect(ConversationContextBuilder.buildContextForProvider(conversation, 'mistral')[1])
        .toMatchObject({ role: 'assistant', content: storedContent });
      expect(ConversationContextBuilder.buildContextForProvider(conversation, 'requesty', undefined, 'mistral/mistral-large-4')[1])
        .toMatchObject({ role: 'assistant', content: storedContent });
      expect(ConversationContextBuilder.buildContextForProvider(conversation, 'openai')[1])
        .toMatchObject({ role: 'assistant', content: 'Stored answer' });
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

    it('reports reasoning only for catalog models that support it', async () => {
      const adapter = new MistralAdapter('mk-test');
      const models = await adapter.listModels();

      expect(models.length).toBeGreaterThan(0);
      expect(models.find(model => model.id === 'mistral-large-4')?.supportsThinking).toBe(true);
      expect(models.find(model => model.id === 'magistral-medium-latest')?.supportsThinking).toBe(true);
      expect(models.find(model => model.id === 'mistral-large-latest')?.supportsThinking).toBe(false);
      expect(adapter.getCapabilities().supportsThinking).toBe(true);
    });
  });
});
