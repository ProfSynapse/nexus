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
import { LLMProviderError, StreamChunk } from '../../src/services/llm/adapters/types';
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

  it('streams server search sources without treating server JSON as a client tool call', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return sseResponse(sse(
        { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"news"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', content: [
          { type: 'web_search_result', title: 'Example', url: 'https://example.com/source', encrypted_content: 'opaque-token' }
        ] } },
        { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Answer' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: {
          type: 'web_search_result_location', title: 'Example', url: 'https://example.com/source', encrypted_index: 'cite-token'
        } } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5, server_tool_use: { web_search_requests: 1 } } },
        { type: 'message_stop' }
      ));
    });
    const chunks = await collect(new AnthropicAdapter('ak-test').generateStreamAsync('search', { webSearch: true }));
    expect(JSON.parse(requests[0].body ?? '{}').tools).toContainEqual(expect.objectContaining({ type: 'web_search_20250305' }));
    expect(chunks.at(-1)?.toolCalls).toBeUndefined();
    expect(chunks.at(-1)?.metadata?.webSearchResults).toEqual([
      { title: 'Example', url: 'https://example.com/source', date: undefined }
    ]);
    expect(chunks.at(-1)?.metadata?.anthropicResponseContent).toEqual([
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'news' } },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'Example',
        url: 'https://example.com/source', encrypted_content: 'opaque-token' }] },
      { type: 'text', text: 'Answer', citations: [{ type: 'web_search_result_location',
        title: 'Example', url: 'https://example.com/source', encrypted_index: 'cite-token' }] }
    ]);
  });

  it('keeps non-streaming server search citations and billed search count', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(200, { content: [
        { type: 'web_search_tool_result', content: [
          { type: 'web_search_result', title: 'Example', url: 'https://example.com/source', encrypted_content: 'opaque-token' }
        ] },
        { type: 'text', text: 'Answer', citations: [
          { type: 'web_search_result_location', title: 'Example', url: 'https://example.com/source' }
        ] }
      ], stop_reason: 'end_turn', usage: {
        input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 }
      } });
    });
    const response = await new AnthropicAdapter('ak-test').generateUncached('search', { webSearch: true });
    expect(JSON.parse(requests[0].body ?? '{}').tools).toContainEqual(expect.objectContaining({ type: 'web_search_20250305' }));
    expect(response.webSearchResults).toEqual([{ title: 'Example', url: 'https://example.com/source', date: undefined }]);
    expect(response.usage).toMatchObject({ webSearchRequests: 1, webSearchCost: 0.01 });
    expect(response.metadata?.anthropicResponseContent).toHaveLength(2);
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
      expect(result.metadata?.stopReason).toBe('end_turn');
      // totalTokens is derived as input + output (Anthropic sends no total)
      expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
      expect(result.metadata?.thinking).toBe('pondering');

      expect(requests[0].url).toBe('https://api.anthropic.com/v1/messages');
      expect(requests[0].headers?.['x-api-key']).toBe('ak-test');
      expect(requests[0].headers?.['anthropic-version']).toBe('2023-06-01');
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.system).toBe('Be brief');
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
      expect(body.max_tokens).toBe(64000);
    });

    it.each([
      ['claude-haiku-4-5-20251001', true, undefined, 64000, 'claude-haiku-4-5-20251001'],
      ['claude-haiku-5-5', true, undefined, 128000, 'claude-haiku-5-5'],
      ['claude-opus-4-8:1m', true, undefined, 128000, 'claude-opus-4-8'],
      ['claude-haiku-5-5', true, 2048, 2048, 'claude-haiku-5-5'],
      ['claude-haiku-5-5', false, 0, 0, 'claude-haiku-5-5'],
      ['unknown-claude-model', false, undefined, 4096, 'unknown-claude-model']
    ] as const)('uses the effective model cap for %s (thinking=%s, explicit=%s)', async (model, enableThinking, maxTokens, expected, expectedModel) => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return jsonResponse(200, { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' });
      });
      await new AnthropicAdapter('ak-test', model).generateUncached('hi', { model, enableThinking, maxTokens });
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.model).toBe(expectedModel);
      expect(body.max_tokens).toBe(expected);
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

    it('classifies a context-window stop as length while keeping its raw reason', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, {
        content: [{ type: 'text', text: 'partial' }],
        stop_reason: 'model_context_window_exceeded',
        stop_sequence: null
      }));
      const response = await new AnthropicAdapter('ak-test').generateUncached('hi');
      expect(response.finishReason).toBe('length');
      expect(response.metadata).toMatchObject({ stopReason: 'model_context_window_exceeded', stopSequence: null });
    });

    it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('explicitly disables Haiku 5.5 thinking with a safe %s effort on both request paths', async thinkingEffort => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        if (JSON.parse(request.body ?? '{}').stream) {
          return sseResponse(sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }));
        }
        return jsonResponse(200, { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' });
      });
      const adapter = new AnthropicAdapter('ak-test', 'claude-haiku-5-5');
      await adapter.generateUncached('hi', { enableThinking: false, thinkingEffort });
      await collect(adapter.generateStreamAsync('hi', { enableThinking: false, thinkingEffort }));
      for (const request of requests) {
        const body = JSON.parse(request.body ?? '{}');
        expect(body.thinking).toEqual({ type: 'disabled' });
        expect(body.output_config).toEqual({ effort: thinkingEffort === 'xhigh' || thinkingEffort === 'max' ? 'high' : thinkingEffort });
      }
      expect(requests).toHaveLength(2);
    });

    it('separates Haiku thinking modes in the actual generation cache', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return jsonResponse(200, { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' });
      });
      const adapter = new AnthropicAdapter('ak-test', 'claude-haiku-5-5');
      await adapter.generate('hi', { enableThinking: false, thinkingEffort: 'max' });
      await adapter.generate('hi', { enableThinking: true, thinkingEffort: 'max' });
      await adapter.generate('hi', { enableThinking: true, thinkingEffort: 'low' });
      expect(requests).toHaveLength(3);
      expect(JSON.parse(requests[0].body ?? '{}').thinking).toEqual({ type: 'disabled' });
      expect(JSON.parse(requests[1].body ?? '{}').output_config.effort).toBe('max');
      expect(JSON.parse(requests[2].body ?? '{}').output_config.effort).toBe('low');
    });

    it('uses adaptive summarized thinking and effort for Claude 4.6+', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn'
        });
      });

      await new AnthropicAdapter('ak-test', 'claude-sonnet-5').generateUncached('hi', {
        enableThinking: true,
        thinkingEffort: 'low',
        temperature: 0.2,
        maxTokens: 4096
      });

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body.output_config).toEqual({ effort: 'low' });
      expect(body).not.toHaveProperty('temperature');
      expect(body.max_tokens).toBe(4096);
    });

    it.each([
      ['claude-opus-4-8', 'xhigh', 'xhigh'],
      ['claude-opus-4-6', 'xhigh', 'high'],
      ['claude-haiku-5-5', 'max', 'max']
    ] as const)('maps %s requested %s to adaptive effort %s', async (model, requested, expected) => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return jsonResponse(200, { model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
      });
      await new AnthropicAdapter('ak-test', model).generateUncached('hi', {
        enableThinking: true, thinkingEffort: requested
      });
      expect(JSON.parse(requests[0].body ?? '{}').output_config).toEqual({ effort: expected });
    });

    // Models flagged supportsSamplingParams: false reject temperature even with
    // thinking off; chat always supplies one (default 0.5).
    it.each([
      ['claude-opus-5-5', false],
      ['claude-opus-5', false],
      ['claude-sonnet-5-5', false],
      ['claude-sonnet-5', false],
      ['claude-haiku-4-5-20251001', true],
      ['claude-sonnet-4-6', true]
    ])('sends temperature for %s with thinking off only if the registry allows it (expected=%s)', async (model, expected) => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, { model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
      });

      await new AnthropicAdapter('ak-test', model).generateUncached('hi', { temperature: 0.5 });

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body).not.toHaveProperty('thinking');
      if (expected) expect(body.temperature).toBe(0.5);
      else expect(body).not.toHaveProperty('temperature');
    });

    it('drops temperature on the streaming path for a model that rejects it', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse(
          { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'message_stop' }
        ));
      });

      await collect(new AnthropicAdapter('ak-test', 'claude-fable-5-1').generateStreamAsync('hi', { temperature: 0.5 }));

      expect(JSON.parse(requests[0].body ?? '{}')).not.toHaveProperty('temperature');
    });

    it('keeps manual token-budget thinking for Claude 4.5', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn'
        });
      });

      await new AnthropicAdapter('ak-test', 'claude-haiku-4-5-20251001').generateUncached('hi', {
        enableThinking: true,
        thinkingEffort: 'low',
        temperature: 0.2,
        maxTokens: 4096
      });

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
      expect(body).not.toHaveProperty('output_config');
      expect(body).not.toHaveProperty('temperature');
      expect(body.max_tokens).toBe(4096);
    });

    it.each([
      ['claude-haiku-4-5-20251001', 'xhigh', undefined, 64000, 62976, 'enabled'],
      ['claude-haiku-4-5-20251001', 'max', undefined, 64000, 62976, 'enabled'],
      ['claude-haiku-4-5-20251001', 'max', 4096, 4096, 3072, 'enabled'],
      ['claude-haiku-5-5', 'max', undefined, 128000, null, 'adaptive']
    ] as const)('uses manual thinking room for %s at %s with cap %s', async (model, effort, maxTokens, expectedMax, expectedBudget, mode) => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return jsonResponse(200, { model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
      });
      await new AnthropicAdapter('ak-test', model).generateUncached('hi', {
        enableThinking: true, thinkingEffort: effort, maxTokens
      });
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.max_tokens).toBe(expectedMax);
      expect(body.thinking.type).toBe(mode);
      if (expectedBudget === null) expect(body.thinking).not.toHaveProperty('budget_tokens');
      else expect(body.thinking.budget_tokens).toBe(expectedBudget);
    });

    it('rejects a tiny explicit cap for elevated manual thinking before sending a request', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return jsonResponse(200, {});
      });
      const error = await captureError(new AnthropicAdapter('ak-test', 'claude-haiku-4-5-20251001')
        .generateUncached('hi', { enableThinking: true, thinkingEffort: 'max', maxTokens: 1024 }));
      expect((error as Error).message).toContain('requires maxTokens of at least 2048');
      expect(requests).toHaveLength(0);
    });
  });

  describe('SSE streaming', () => {
    it.each([
      ['claude-haiku-4-5-20251001', 'max', undefined, 64000, 62976],
      ['claude-haiku-4-5-20251001', 'max', 4096, 4096, 3072],
      ['claude-haiku-5-5', 'max', undefined, 128000, null]
    ] as const)('sends %s max thinking within output cap %s', async (model, effort, maxTokens, expectedMax, expectedBudget) => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return sseResponse(sse({ type: 'message_stop' }));
      });
      await collect(new AnthropicAdapter('ak-test', model).generateStreamAsync('hi', {
        enableThinking: true, thinkingEffort: effort, maxTokens
      }));
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.max_tokens).toBe(expectedMax);
      if (expectedBudget === null) expect(body.thinking).not.toHaveProperty('budget_tokens');
      else expect(body.thinking.budget_tokens).toBe(expectedBudget);
    });

    it.each([
      ['claude-haiku-4-5-20251001', true, undefined, 64000, 'claude-haiku-4-5-20251001'],
      ['claude-haiku-5-5', true, undefined, 128000, 'claude-haiku-5-5'],
      ['claude-opus-4-8:1m', true, undefined, 128000, 'claude-opus-4-8'],
      ['claude-haiku-5-5', true, 2048, 2048, 'claude-haiku-5-5'],
      ['claude-haiku-5-5', false, 0, 0, 'claude-haiku-5-5'],
      ['unknown-claude-model', false, undefined, 4096, 'unknown-claude-model']
    ] as const)('uses the effective model cap for streaming %s (thinking=%s, explicit=%s)', async (model, enableThinking, maxTokens, expected, expectedModel) => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return sseResponse(sse({ type: 'message_stop' }));
      });
      await collect(new AnthropicAdapter('ak-test', model).generateStreamAsync('hi', { model, enableThinking, maxTokens }));
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.model).toBe(expectedModel);
      expect(body.max_tokens).toBe(expected);
    });

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
      // Anthropic streaming usage has no total_tokens; the normalizer derives it
      expect(final.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
      expect(final.toolCallsReady).toBe(true);
      // Current behavior: the synthetic id from input_json_delta overwrites
      // the real tool_use id supplied by content_block_start
      expect(final.toolCalls).toEqual([
        {
          id: 'anthropic-tool-2',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"x"}' },
          anthropic_thinking_blocks: [{ type: 'thinking', thinking: 'hmm', signature: '' }]
        }
      ]);
    });

    it('asks for prompt caching on the system block and the last tool, and sends structured history verbatim', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse(
          { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'message_delta', usage: { output_tokens: 2 } },
          { type: 'message_stop' }
        ));
      });

      const history = [
        { role: 'user', content: 'call the tool' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"hits":1}' }] },
        { role: 'user', content: 'what did it return?' }
      ];

      await collect(new AnthropicAdapter('ak-test').generateStreamAsync('what did it return?', {
        systemPrompt: 'Be brief',
        conversationHistory: history,
        tools: [
          { type: 'function', function: { name: 'search', description: 'Search', parameters: {} } },
          { type: 'function', function: { name: 'read', description: 'Read', parameters: {} } }
        ]
      }));

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.system).toEqual([{ type: 'text', text: 'Be brief', cache_control: { type: 'ephemeral' } }]);
      expect(body.tools[0].cache_control).toBeUndefined();
      expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
      // History is the messages array, content blocks intact — no transcript in `system`.
      expect(body.messages).toEqual(history);
    });

    it('merges message_start and message_delta usage and grosses up cache read/write tokens', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 1 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'message_delta', usage: { output_tokens: 40 } },
        { type: 'message_stop' }
      )));

      const chunks = await collect(new AnthropicAdapter('ak-test').generateStreamAsync('hi'));
      const final = chunks[chunks.length - 1];

      expect(final.usage).toEqual({
        promptTokens: 2312,          // 12 fresh + 2000 read + 300 written: gross input like every other provider
        completionTokens: 40,        // from message_delta, not the placeholder 1 in message_start
        totalTokens: 2352,
        cacheReadTokens: 2000,
        cachedTokens: 2000,
        cacheWriteTokens: 300
      });
    });

    it.each([
      ['max_tokens', 'length', null],
      ['model_context_window_exceeded', 'length', null],
      ['tool_use', 'tool_calls', null],
      ['end_turn', 'stop', null],
      ['pause_turn', 'stop', null],
      ['stop_sequence', 'stop', 'END'],
      ['refusal', 'content_filter', null]
    ] as const)('keeps raw %s and emits normalized %s only at message_stop', async (raw, normalized, sequence) => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'message_delta', delta: { stop_reason: raw, stop_sequence: sequence }, usage: { output_tokens: 4 } },
        { type: 'message_stop' }
      )));
      const chunks = await collect(new AnthropicAdapter('ak-test').generateStreamAsync('hi'));
      const completed = chunks.filter(chunk => chunk.complete);
      expect(completed).toHaveLength(1);
      expect(completed[0].finishReason).toBe(normalized);
      expect(completed[0].metadata).toMatchObject({ stopReason: raw, stopSequence: sequence });
      expect(completed[0].usage?.completionTokens).toBe(4);
    });

    it('does not invent a normalized finish reason if the stream disconnects after message_delta', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null } }
      )));
      const chunks = await collect(new AnthropicAdapter('ak-test').generateStreamAsync('hi'));
      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.finishReason).toBeUndefined();
      expect(final.metadata).toMatchObject({ stopReason: 'max_tokens', stopSequence: null });
    });

    it('emits stop metadata before a later provider error without a completion chunk', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null } },
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
      )));
      const chunks: StreamChunk[] = [];
      const error = await captureError((async () => {
        for await (const chunk of new AnthropicAdapter('ak-test').generateStreamAsync('hi')) chunks.push(chunk);
      })());
      expect(error).toMatchObject({ code: 'PROVIDER_STREAM_ERROR' });
      expect(chunks).toContainEqual({
        content: '', complete: false, metadata: { stopReason: 'max_tokens', stopSequence: null }
      });
      expect(chunks.some(chunk => chunk.complete)).toBe(false);
    });

    it('preserves signed and redacted thinking blocks on tool calls for exact replay', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'summary' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_opaque' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'redacted_opaque' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
        { type: 'message_stop' }
      )));

      const chunks = await collect(new AnthropicAdapter('ak-test').generateStreamAsync('hi', {
        enableThinking: true,
        tools: [{ type: 'function', function: { name: 'search', description: 'Search', parameters: {} } }]
      }));

      const final = chunks[chunks.length - 1];
      expect(final.toolCalls?.[0].anthropic_thinking_blocks).toEqual([
        { type: 'thinking', thinking: 'summary', signature: 'sig_opaque' },
        { type: 'redacted_thinking', data: 'redacted_opaque' }
      ]);
    });

    it('throws on an error event delivered over HTTP 200 instead of ending an empty stream', async () => {
      // Anthropic reports overload/invalid-request mid-stream as an `error` event
      // on an otherwise successful connection. This used to be raised from
      // extractFinishReason, where the processor's parse-error guard swallowed it,
      // so the user saw a blank bubble with nothing logged (issue #336).
      __setRequestUrlMock(async () => sseResponse(sse(
        { type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 0 } } },
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
      )));

      const adapter = new AnthropicAdapter('ak-test');
      const chunks: unknown[] = [];
      const error = await captureError((async () => {
        for await (const chunk of adapter.generateStreamAsync('hi')) {
          chunks.push(chunk);
        }
      })()) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe('PROVIDER_STREAM_ERROR');
      expect(error.provider).toBe('anthropic');
      expect(error.message).toContain('Overloaded');
      // A cumulative usage snapshot may precede a later provider error, but
      // the failed stream must never emit a successful completion chunk.
      expect(chunks).not.toContainEqual(expect.objectContaining({ complete: true }));
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
