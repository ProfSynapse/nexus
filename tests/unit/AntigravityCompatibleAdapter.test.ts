import { __setRequestUrlMock } from '../mocks/obsidian';
jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'), hasNodeRuntime: () => false,
}));
import type { AntigravityCompatibleWireProtocol, LLMProviderConfig } from '../../src/types/llm/ProviderTypes';
import { AntigravityCompatibleAdapter } from '../../src/services/llm/adapters/antigravity-compatible/AntigravityCompatibleAdapter';
import { discoverAntigravityCompatibleModels, resolveAntigravityCompatibleUrls } from '../../src/services/llm/adapters/antigravity-compatible/AntigravityCompatibleConfig';
import { LLMProviderError } from '../../src/services/llm/adapters/types';
import { resolveProviderWireFamily, syncCompatibleWireProtocols } from '../../src/services/llm/adapters/shared/CompatibleEndpointUtils';
import { getContextBuilder } from '../../src/services/chat/builders/ContextBuilderFactory';
import { ProviderMessageBuilder } from '../../src/services/llm/core/ProviderMessageBuilder';
import { collect, concatContent, jsonResponse, sse, sseResponse, type CapturedRequest } from './helpers/llmAdapterTestHarness';

function config(wireProtocol: AntigravityCompatibleWireProtocol = 'auto'): LLMProviderConfig {
  return { apiKey: 'secret', enabled: true, driverKind: 'antigravity-compatible', antigravityCompatible: {
    schemaVersion: 1, displayName: 'Gateway', baseUrl: 'https://gw.example.com/antigravity', wireProtocol,
    models: { 'gemini-4-carbon': { source: 'manual' }, 'claude-opus-5-5': { source: 'manual' }, 'google/gemini-4-carbon': { source: 'manual' } },
  } };
}
const messagesResponse = sseResponse(sse(
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude answer' } },
  { type: 'message_stop' },
));
const googleResponse = sseResponse(sse(
  { candidates: [{ content: { parts: [{ text: 'ponder', thought: true }] } }] },
  { candidates: [{ content: { parts: [{ text: 'Gemini answer' }] } }] },
  { candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'opaque' }] }, finishReason: 'STOP' }] },
));
describe('Antigravity-compatible configuration', () => {
  it.each([
    ['https://gw.example.com/antigravity', 'https://gw.example.com/antigravity'],
    ['https://gw.example.com/antigravity/v1beta', 'https://gw.example.com/antigravity'],
    ['https://gw.example.com/antigravity/v1', 'https://gw.example.com/antigravity'],
    ['https://gw.example.com', 'https://gw.example.com'],
  ])('resolves both wire URLs from %s', (input, root) => {
    expect(resolveAntigravityCompatibleUrls(input)).toMatchObject({
      gatewayRootUrl: root, v1betaBaseUrl: `${root}/v1beta`, messagesUrl: `${root}/v1/messages`,
    });
  });
  it('merges model discovery across both protocols and excludes embeddings', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return request.url?.endsWith('/v1beta/models')
        ? jsonResponse(200, { models: [
          { name: 'models/gemini-4-carbon', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-only', supportedGenerationMethods: ['embedContent'] },
        ] })
        : jsonResponse(200, { data: [{ id: 'claude-opus-5-5', context_length: 1000000 }] });
    });
    expect(await discoverAntigravityCompatibleModels('https://gw.example.com/antigravity', 'secret', 'auto')).toEqual([
      { id: 'gemini-4-carbon', contextWindow: 1048576 }, { id: 'claude-opus-5-5', contextWindow: 1000000 },
    ]);
    expect(requests.map(request => request.url).sort()).toEqual([
      'https://gw.example.com/antigravity/v1/models', 'https://gw.example.com/antigravity/v1beta/models',
    ]);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });
});

describe('Antigravity-compatible streaming', () => {
  it('routes Gemini to v1beta in auto mode and retains thought and signed function call', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => { requests.push(request); return googleResponse; });
    const chunks = await collect(new AntigravityCompatibleAdapter(config(), 'antigravity-compatible-auto').generateStreamAsync('Hi', { model: 'gemini-4-carbon' }));
    expect(requests[0].url).toBe('https://gw.example.com/antigravity/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse');
    expect(concatContent(chunks)).toBe('Gemini answer');
    expect(chunks).toContainEqual(expect.objectContaining({ reasoning: 'ponder', reasoningComplete: false }));
    expect(chunks.at(-1)).toMatchObject({ complete: true, toolCallsReady: true, toolCalls: [{
      function: { name: 'lookup', arguments: '{"q":"x"}' }, thought_signature: 'opaque',
    }] });
  });
  it.each([
    ['auto', 'claude-opus-5-5'], ['messages', 'gemini-4-carbon'],
  ] as const)('routes %s mode model %s to Messages', async (mode, model) => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => { requests.push(request); return messagesResponse; });
    const chunks = await collect(new AntigravityCompatibleAdapter(config(mode), `antigravity-compatible-${mode}`).generateStreamAsync('Hi', { model }));
    expect(requests[0].url).toBe('https://gw.example.com/antigravity/v1/messages');
    expect(JSON.parse(requests[0].body!)).toMatchObject({ model });
    expect(concatContent(chunks)).toBe('Claude answer');
    expect(chunks.at(-1)).toMatchObject({ complete: true });
  });
  it.each(['claude-opus-5-5', 'google/gemini-4-carbon'])('routes %s to v1beta without losing model segments', async model => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => { requests.push(request); return googleResponse; });
    const chunks = await collect(new AntigravityCompatibleAdapter(config('v1beta'), 'antigravity-compatible-v1beta').generateStreamAsync('Hi', { model }));
    expect(requests[0].url).toBe(`https://gw.example.com/antigravity/v1beta/models/${model}:streamGenerateContent?alt=sse`);
    expect(concatContent(chunks)).toBe('Gemini answer');
  });
  it.each([
    ['v1beta', 'gemini-4-carbon', { error: { code: 400, message: 'Rejected', status: 'INVALID_ARGUMENT' } }],
    ['messages', 'claude-opus-5-5', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
  ] as const)('throws on a mid-stream %s error under HTTP 200', async (mode, model, frame) => {
    __setRequestUrlMock(async () => sseResponse(sse(frame)));
    await expect(collect(new AntigravityCompatibleAdapter(config(mode), `antigravity-compatible-${mode}`).generateStreamAsync('Hi', { model }))).rejects.toBeInstanceOf(LLMProviderError);
  });
});

describe('compatible wire-family message routing', () => {
  afterEach(() => syncCompatibleWireProtocols());
  it.each([
    ['anthropic-compatible-test', 'gemini-4-carbon', 'anthropic'],
    ['antigravity-compatible-auto', 'gemini-4-carbon', 'google'],
    ['antigravity-compatible-auto', 'claude/claude-opus-5-5', 'anthropic'],
    ['antigravity-compatible-v1beta', 'claude-opus-5-5', 'google'],
    ['antigravity-compatible-messages', 'gemini-4-carbon', 'anthropic'],
  ] as const)('routes %s / %s through %s history and continuation', (provider, model, family) => {
    syncCompatibleWireProtocols({
      'antigravity-compatible-auto': config('auto'),
      'antigravity-compatible-v1beta': config('v1beta'),
      'antigravity-compatible-messages': config('messages'),
    });
    expect(resolveProviderWireFamily(provider, model)).toBe(family);
    expect(getContextBuilder(provider, model)).toBe(getContextBuilder(family));
    const builder = new ProviderMessageBuilder(new Map());
    const initial = builder.buildInitialOptions(provider, model, [
      { role: 'system', content: 'Instructions' }, { role: 'user', content: 'Look up item' },
    ]);
    expect(initial.userPrompt).toBe('Look up item');
    expect(initial.generateOptions.systemPrompt).toBe('Instructions');
    expect(initial.generateOptions.conversationHistory).toEqual(family === 'google'
      ? [{ role: 'user', parts: [{ text: 'Look up item' }] }]
      : [{ role: 'user', content: 'Look up item' }]);
    const calls = [{ id: 'call_1', type: 'function' as const, function: { name: 'lookup', arguments: '{"q":"x"}' }, thought_signature: 'signed' }];
    const continuation = builder.buildContinuationOptions(provider, initial.userPrompt, calls,
      [{ id: 'call_1', name: 'lookup', success: true, result: 'found' }], [], initial.generateOptions);
    const history = continuation.conversationHistory as Array<Record<string, unknown>>;
    expect(history[0]).toEqual(initial.generateOptions.conversationHistory![0]);
    if (family === 'google') {
      expect(history[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'signed' }] });
      expect(history[2]).toMatchObject({ role: 'user', parts: [expect.objectContaining({ functionResponse: expect.objectContaining({ name: 'lookup' }) })] });
    } else {
      expect(history[1]).toMatchObject({ role: 'assistant' });
      expect(JSON.stringify(history)).toContain('call_1');
      expect(JSON.stringify(history)).toContain('found');
    }
  });
  it('clears saved overrides on resynchronization', () => {
    syncCompatibleWireProtocols({ 'antigravity-compatible-test': config('messages') });
    expect(resolveProviderWireFamily('antigravity-compatible-test', 'gemini-4-carbon')).toBe('anthropic');
    syncCompatibleWireProtocols({});
    expect(resolveProviderWireFamily('antigravity-compatible-test', 'gemini-4-carbon')).toBe('google');
  });
});
