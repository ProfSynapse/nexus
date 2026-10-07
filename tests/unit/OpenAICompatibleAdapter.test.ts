/** Regressions: malformed/truncated streams must never authorize calls or report success.
 * Transport fixtures supply bytes; the real adapter/parser determines requests and outcomes.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';
jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'), hasNodeRuntime: () => false,
}));
import type { LLMProviderConfig } from '../../src/types';
import { OpenAICompatibleAdapter } from '../../src/services/llm/adapters/openai-compatible/OpenAICompatibleAdapter';
import { buildOpenAICompatibleModels, discoverOpenAICompatibleModels, normalizeOpenAICompatibleBaseUrl } from '../../src/services/llm/adapters/openai-compatible/OpenAICompatibleConfig';
import { processOpenAICompatibleStream } from '../../src/services/llm/adapters/openai-compatible/OpenAICompatibleResponse';
import { ProviderHttpClient } from '../../src/services/llm/adapters/shared/ProviderHttpClient';
import { collect, concatContent, jsonResponse, sseResponse, sse, type CapturedRequest } from './helpers/llmAdapterTestHarness';

function config(apiKey = ''): LLMProviderConfig {
  return { apiKey, enabled: true, driverKind: 'openai-compatible',
    openaiCompatible: { schemaVersion: 1, displayName: 'Test endpoint', baseUrl: 'https://example.test/proxy/v1/', models: { model: { source: 'manual' } } } };
}
const tools = [{ type: 'function' as const, function: { name: 'lookup', description: 'Find item', parameters: { type: 'object' } } }];
async function* bytes(text: string, step = 7) {
  const data = new TextEncoder().encode(text);
  for (let index = 0; index < data.length; index += step) yield data.slice(index, index + step);
}
describe('OpenAI-compatible configuration', () => {
  test('preserves proxy prefixes and permits only clean HTTPS or loopback HTTP', () => {
    expect(normalizeOpenAICompatibleBaseUrl(' https://example.test/proxy/v1/ ')).toBe('https://example.test/proxy/v1');
    expect(normalizeOpenAICompatibleBaseUrl('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080/v1');
    for (const invalid of ['http://192.168.1.2/v1', 'ftp://example.test', 'https://a:b@example.test/v1', 'https://example.test/v1?key=x', 'https://example.test/v1#fragment', 'https://example.test/v1/chat/completions', 'https://example.test/v1/completions', 'https://example.test/v1/models']) {
      expect(() => normalizeOpenAICompatibleBaseUrl(invalid)).toThrow();
    }
  });
  test('discovery sends only GET, deduplicates valid IDs and keeps exact identifiers', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => { requests.push(request); return jsonResponse(200, { data: [{ id: 'a/b:latest' }, { id: 'a/b:latest' }, { id: '' }, { id: 'bad\n' }, null, { id: 'manual' }] }); });
    expect(await discoverOpenAICompatibleModels('https://example.test/prefix/v1/', '')).toEqual(['a/b:latest', 'manual']);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'https://example.test/prefix/v1/models', method: 'GET' });
    expect(requests[0].body).toBeUndefined();
    expect(requests[0].headers).not.toHaveProperty('Authorization');
  });
  test('saved model visibility and conservative unknown pricing do not depend on discovery', () => {
    const value = config();
    value.models = { model: { enabled: false } };
    value.openaiCompatible!.models.second = { source: 'discovered' };
    expect(buildOpenAICompatibleModels(value)).toEqual([expect.objectContaining({ id: 'second', contextWindow: 4096, maxOutputTokens: 1024, pricing: null })]);
  });
});
describe('OpenAI-compatible generations', () => {
  test('minimal requests preserve history, restore system exactly once, and never cache', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => { requests.push(request); return jsonResponse(200, { choices: [{ message: { content: `reply${requests.length}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } }); });
    const adapter = new OpenAICompatibleAdapter(config(), 'endpoint-a');
    const options = { conversationHistory: [{ role: 'user', content: 'prior' }], systemPrompt: 'SYS' };
    expect(await adapter.generate('ignored', options)).toMatchObject({ text: 'reply1', provider: 'endpoint-a', usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 } });
    expect(await adapter.generate('ignored', options)).toMatchObject({ text: 'reply2' });
    expect(JSON.parse(requests[0].body!)).toEqual({ model: 'model', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'prior' }], stream: false });
    expect(requests[0].url).toBe('https://example.test/proxy/v1/chat/completions');
    expect(requests[0].headers).not.toHaveProperty('Authorization');
  });
  test('optional auth and supplied tools are standard function schemas without vendor flags', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => { requests.push(request); return jsonResponse(200, { choices: [{ message: { content: '', reasoning_content: 'thought', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }] }, finish_reason: 'tool_calls' }] }); });
    const result = await new OpenAICompatibleAdapter(config(' key '), 'endpoint').generateUncached('hi', { tools });
    expect(result.toolCalls).toMatchObject([{ id: 'call_a', function: { name: 'lookup', arguments: '{"id":1}' } }]);
    expect(result.metadata).toEqual({ reasoning: 'thought' });
    expect(requests[0].headers?.Authorization).toBe('Bearer key');
    expect(JSON.parse(requests[0].body!)).toEqual({ model: 'model', messages: [{ role: 'user', content: 'hi' }], stream: false, tools, tool_choice: 'auto' });
  });
  test('JSON response to stream:true uses the same POST and completes once', async () => {
    let count = 0;
    __setRequestUrlMock(async () => { count++; return jsonResponse(200, { choices: [{ message: { content: 'JSON reply' }, finish_reason: 'stop' }] }); });
    const chunks = await collect(new OpenAICompatibleAdapter(config(), 'endpoint').generateStreamAsync('hi'));
    expect(count).toBe(1);
    expect(concatContent(chunks)).toBe('JSON reply');
    expect(chunks.filter(chunk => chunk.complete)).toHaveLength(1);
  });
  test('unsolicited or disabled function calls cannot cross the driver boundary', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => { requests.push(request); return jsonResponse(200, { choices: [{ message: { content: '', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }] }); });
    const adapter = new OpenAICompatibleAdapter(config(), 'endpoint');
    await expect(adapter.generateUncached('hi')).rejects.toThrow(/did not offer/);
    await expect(collect(adapter.generateStreamAsync('hi', { tools, enableTools: false }))).rejects.toThrow(/did not offer/);
    expect(JSON.parse(requests[1].body!)).not.toHaveProperty('tools');
    expect(JSON.parse(requests[1].body!)).not.toHaveProperty('tool_choice');
  });
  test('mobile buffered SSE retains trailing usage and reasoning', async () => {
    __setRequestUrlMock(async () => sseResponse(sse(
      { choices: [{ delta: { reasoning: 'think' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } }, '[DONE]',
    )));
    const chunks = await collect(new OpenAICompatibleAdapter(config(), 'endpoint').generateStreamAsync('hi'));
    expect(chunks).toContainEqual({ content: '', complete: false, reasoning: 'think', reasoningComplete: false });
    expect(chunks.at(-1)).toMatchObject({ complete: true, reasoningComplete: true, usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11, cacheReadTokens: 4 } });
  });
  test('caller abort promptly settles buffered requests; late replies cannot revive them', async () => {
    let resolve!: (value: ReturnType<typeof jsonResponse>) => void;
    __setRequestUrlMock(() => new Promise(r => { resolve = r; }));
    const controller = new AbortController();
    const pending = collect(new OpenAICompatibleAdapter(config(), 'endpoint').generateStreamAsync('hi', { abortSignal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    resolve(jsonResponse(200, { choices: [{ message: { content: 'late' } }] }));
  });
  test('disposal aborts in-flight requests and prevents subsequent sends', async () => {
    __setRequestUrlMock(() => new Promise(() => {}));
    const adapter = new OpenAICompatibleAdapter(config(), 'endpoint');
    const pending = adapter.generateUncached('hi');
    adapter.dispose();
    await expect(pending).rejects.toThrow(/aborted/i);
    await expect(adapter.generateUncached('hi')).rejects.toThrow(/disposed/i);
  });
  test('pre-aborted buffered transport sends nothing', async () => {
    let count = 0;
    __setRequestUrlMock(async () => { count++; return jsonResponse(200, {}); });
    const controller = new AbortController(); controller.abort();
    await expect(ProviderHttpClient.request({ url: 'https://example.test', provider: 'test', operation: 'test', signal: controller.signal })).rejects.toThrow(/aborted/i);
    expect(count).toBe(0);
  });
  test('overall generation deadline settles a stalled mobile stream', async () => {
    jest.useFakeTimers();
    __setRequestUrlMock(() => new Promise(() => {}));
    try {
      const pending = collect(new OpenAICompatibleAdapter(config(), 'endpoint').generateStreamAsync('hi'));
      jest.advanceTimersByTime(600_000);
      await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    } finally { jest.useRealTimers(); }
  });
});
describe('wire stream normalization', () => {
  test('DONE completes and releases the body without waiting for another read', async () => {
    let released = false;
    async function* openBody() {
      try {
        yield sse({ choices: [{ delta: { content: 'finished' }, finish_reason: 'stop' }] });
        yield sse({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }, '[DONE]');
        throw new Error('Read beyond terminal frame');
      } finally { released = true; }
    }
    const chunks = await collect(processOpenAICompatibleStream(openBody(), 'endpoint'));
    expect(concatContent(chunks)).toBe('finished');
    expect(chunks.at(-1)).toMatchObject({ complete: true, usage: { promptTokens: 4, completionTokens: 2 } });
    expect(chunks.filter(chunk => chunk.complete)).toHaveLength(1);
    expect(released).toBe(true);
  });
  test('provider-owned named progress and approval events never become Nexus calls', async () => {
    const wire = 'event: hermes.tool.progress\ndata: {"tool":"lookup","arguments":"{}"}\n\n'
      + sse({ choices: [{ delta: { content: 'hello' } }] })
      + 'event: hermes.approval\ndata: arbitrary provider data\n\n'
      + sse({ choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] }, '[DONE]');
    const chunks = await collect(processOpenAICompatibleStream(bytes(wire), 'endpoint'));
    expect(concatContent(chunks)).toBe('hello world');
    expect(chunks.at(-1)?.toolCalls).toBeUndefined();
  });
  test('named error events still reject', async () => {
    await expect(collect(processOpenAICompatibleStream(bytes('event: error\ndata: {"message":"failure"}\n\n'), 'endpoint'))).rejects.toThrow(/streaming error/);
  });
  test('split Unicode, multiline SSE data and interleaved fragmented calls survive', async () => {
    const wire = 'data: {"choices":\n' + 'data: [{"delta":{"content":"café 🌍"}}]}\n\n' + sse(
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'lo', arguments: '{"id":' } }, { index: 0, id: 'call_a', type: 'function', function: { name: 'first', arguments: '{}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'okup', arguments: '1}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]',
    );
    const chunks = await collect(processOpenAICompatibleStream(bytes(wire, 1), 'endpoint'));
    expect(concatContent(chunks)).toBe('café 🌍');
    expect(chunks.at(-1)?.toolCalls).toMatchObject([{ id: 'call_a', function: { name: 'first', arguments: '{}' } }, { id: 'call_b', function: { name: 'lookup', arguments: '{"id":1}' } }]);
  });
  test('same omitted-ID call in consecutive responses has distinct valid IDs', async () => {
    const wire = sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]');
    const first = await collect(processOpenAICompatibleStream(bytes(wire), 'endpoint'));
    const second = await collect(processOpenAICompatibleStream(bytes(wire), 'endpoint'));
    expect(first.at(-1)?.toolCalls?.[0].id).toMatch(/^call_/);
    expect(first.at(-1)?.toolCalls?.[0].id).not.toBe(second.at(-1)?.toolCalls?.[0].id);
  });
  test.each([
    ['truncated', sse({ choices: [{ delta: { content: 'partial' } }] }), /terminal/],
    ['malformed JSON', 'data: {broken}\n\n', /Malformed JSON/],
    ['HTTP200 error after finish', sse({ choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }] }, { error: { message: 'backend failed' } }), /backend failed/],
    ['empty', sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'), /empty/],
    ['bad arguments', sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'lookup', arguments: '{broken' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]'), /malformed function arguments/],
  ])('rejects %s without completing', async (_name, wire, error) => {
    const chunks = [];
    await expect((async () => { for await (const chunk of processOpenAICompatibleStream(bytes(wire), 'endpoint')) chunks.push(chunk); })()).rejects.toThrow(error);
    expect(chunks.some(chunk => chunk.complete)).toBe(false);
  });
});
