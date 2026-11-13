import { __setRequestUrlMock } from '../mocks/obsidian';
jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'), hasNodeRuntime: () => false,
}));
import type { AnthropicCompatibleAuthMode, LLMProviderConfig } from '../../src/types/llm/ProviderTypes';
import { AnthropicCompatibleAdapter } from '../../src/services/llm/adapters/anthropic-compatible/AnthropicCompatibleAdapter';
import { discoverAnthropicCompatibleModels, resolveAnthropicCompatibleUrls } from '../../src/services/llm/adapters/anthropic-compatible/AnthropicCompatibleConfig';
import { LLMProviderError } from '../../src/services/llm/adapters/types';
import { collect, concatContent, jsonResponse, sse, sseResponse, type CapturedRequest } from './helpers/llmAdapterTestHarness';

function config(model = 'claude-opus-5-5'): LLMProviderConfig {
  return { apiKey: 'secret', enabled: true, driverKind: 'anthropic-compatible',
    anthropicCompatible: { schemaVersion: 1, displayName: 'Gateway', baseUrl: 'https://api.example.com', models: { [model]: { source: 'manual' } } } };
}

describe('Anthropic-compatible endpoint configuration', () => {
  it.each([
    ['https://api.example.com', 'https://api.example.com/v1/messages'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1/messages'],
    ['https://gw.example.com/antigravity', 'https://gw.example.com/antigravity/v1/messages'],
    ['http://localhost:8080', 'http://localhost:8080/v1/messages'],
  ])('resolves %s to %s', (base, messagesUrl) => {
    expect(resolveAnthropicCompatibleUrls(base).messagesUrl).toBe(messagesUrl);
  });
  it('retains the gateway prefix for both discovery paths', () => {
    expect(resolveAnthropicCompatibleUrls('https://gw.example.com/antigravity').modelsUrls).toEqual([
      'https://gw.example.com/antigravity/v1/models', 'https://gw.example.com/antigravity/models',
    ]);
    expect(resolveAnthropicCompatibleUrls('https://api.example.com/v1').modelsUrls).toEqual(['https://api.example.com/v1/models']);
  });
  it.each(['http://api.example.com', 'https://api.example.com/v1/messages', 'https://api.example.com/models'])('rejects invalid base %s', base => {
    expect(() => resolveAnthropicCompatibleUrls(base)).toThrow();
  });
  it.each([
    ['x-api-key', true, false], ['bearer', false, true], ['both', true, true],
  ] as const)('discovers models using %s authentication', async (mode: AnthropicCompatibleAuthMode, keyHeader, bearer) => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(200, { data: [
        { id: 'claude-a', context_length: 1000000 },
        { id: 'claude-b', max_input_tokens: 200000 },
      ] });
    });
    expect(await discoverAnthropicCompatibleModels('https://api.example.com', ' secret ', mode)).toEqual([
      { id: 'claude-a', contextWindow: 1000000 }, { id: 'claude-b', contextWindow: 200000 },
    ]);
    expect(requests[0]).toMatchObject({ method: 'GET', url: 'https://api.example.com/v1/models' });
    expect(requests[0].headers?.['x-api-key']).toBe(keyHeader ? 'secret' : undefined);
    expect(requests[0].headers?.Authorization).toBe(bearer ? 'Bearer secret' : undefined);
  });
  it('falls back to the unversioned models endpoint on 404', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return requests.length === 1 ? jsonResponse(404, {}) : jsonResponse(200, { data: [{ id: 'fallback' }] });
    });
    expect(await discoverAnthropicCompatibleModels('https://gw.example.com/antigravity', '')).toEqual([{ id: 'fallback' }]);
    expect(requests.map(request => request.url)).toEqual(['https://gw.example.com/antigravity/v1/models', 'https://gw.example.com/antigravity/models']);
  });
});

describe('Anthropic-compatible generation', () => {
  it('generates a non-streaming response through the configured endpoint', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(200, { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } });
    });
    const result = await new AnthropicCompatibleAdapter(config(), 'anthropic-compatible-test').generate('Hi');
    expect(result).toMatchObject({ text: 'Hello', provider: 'anthropic-compatible-test', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });
    expect(requests[0]).toMatchObject({ method: 'POST', url: 'https://api.example.com/v1/messages', headers: { 'x-api-key': 'secret' } });
    expect(JSON.parse(requests[0].body!)).toMatchObject({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'Hi' }] });
  });
  it('streams reasoning and text and accumulates signed tool arguments', async () => {
    __setRequestUrlMock(async () => sseResponse(sse(
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ponder' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"x"}' } },
      { type: 'message_delta', usage: { input_tokens: 10, output_tokens: 5 } },
      { type: 'message_stop' },
    )));
    const chunks = await collect(new AnthropicCompatibleAdapter(config(), 'anthropic-compatible-test').generateStreamAsync('Hi'));
    expect(concatContent(chunks)).toBe('Answer');
    expect(chunks).toContainEqual(expect.objectContaining({ reasoning: 'ponder', reasoningComplete: false }));
    expect(chunks.at(-1)).toMatchObject({ complete: true, toolCallsReady: true, toolCalls: [{
      id: 'toolu_1', function: { name: 'search', arguments: '{"q":"x"}' },
      anthropic_thinking_blocks: [{ type: 'thinking', thinking: 'ponder', signature: 'opaque' }],
    }] });
  });
  it.each(['claude-opus-5-5', 'claude/claude-opus-5-5'])('uses adaptive thinking for %s', async model => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => { requests.push(request); return jsonResponse(200, { model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }); });
    await new AnthropicCompatibleAdapter(config(model), 'anthropic-compatible-test').generate('Hi', { model, enableThinking: true, thinkingEffort: 'low' });
    expect(JSON.parse(requests[0].body!)).toMatchObject({ model, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' } });
  });
  it('throws a provider error for a mid-stream error despite HTTP 200', async () => {
    __setRequestUrlMock(async () => sseResponse(sse(
      { type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 0 } } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    )));
    await expect(collect(new AnthropicCompatibleAdapter(config(), 'anthropic-compatible-test').generateStreamAsync('Hi'))).rejects.toBeInstanceOf(LLMProviderError);
  });
});
