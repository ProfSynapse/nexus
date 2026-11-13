import { __setRequestUrlMock } from '../mocks/obsidian';
jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));
import type {
  LLMProviderConfig,
  ResponsesCompatibleAuthMode,
  ResponsesCompatibleStateMode,
} from '../../src/types/llm/ProviderTypes';
import { ResponsesCompatibleAdapter } from '../../src/services/llm/adapters/responses-compatible/ResponsesCompatibleAdapter';
import {
  buildResponsesCompatibleModels,
  discoverResponsesCompatibleModels,
  resolveResponsesCompatibleUrls,
} from '../../src/services/llm/adapters/responses-compatible/ResponsesCompatibleConfig';
import { LLMProviderError, type StreamChunk, type Tool } from '../../src/services/llm/adapters/types';
import {
  resolveProviderWireFamily,
  resolveResponsesStateMode,
  syncCompatibleWireProtocols,
} from '../../src/services/llm/adapters/shared/CompatibleEndpointUtils';
import { getContextBuilder } from '../../src/services/chat/builders/ContextBuilderFactory';
import { ProviderMessageBuilder } from '../../src/services/llm/core/ProviderMessageBuilder';
import {
  captureError,
  collect,
  concatContent,
  jsonResponse,
  sse,
  sseResponse,
  type CapturedRequest,
} from './helpers/llmAdapterTestHarness';

function makeConfig(options?: {
  model?: string;
  baseUrl?: string;
  stateMode?: ResponsesCompatibleStateMode;
  authMode?: ResponsesCompatibleAuthMode;
  apiKey?: string;
}): LLMProviderConfig {
  const model = options?.model ?? 'gpt-5.4';
  return {
    apiKey: options?.apiKey ?? 'secret',
    enabled: true,
    driverKind: 'responses-compatible',
    responsesCompatible: {
      schemaVersion: 1,
      displayName: 'Responses Gateway',
      baseUrl: options?.baseUrl ?? 'https://api.example.com',
      ...(options?.stateMode ? { stateMode: options.stateMode } : {}),
      ...(options?.authMode ? { authMode: options.authMode } : {}),
      models: { [model]: { source: 'manual' } },
    },
  };
}

const sampleTools: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'lookup_note',
      description: 'Find a vault note',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
];

beforeEach(() => {
  __setRequestUrlMock(async () => jsonResponse(500, { error: { message: 'Unexpected requestUrl call' } }));
});

describe('Responses-compatible endpoint configuration', () => {
  it('resolves root, /v1, subpath, /backend-api/codex, and loopback HTTP URLs', () => {
    expect(resolveResponsesCompatibleUrls('https://api.example.com')).toEqual({
      baseUrl: 'https://api.example.com',
      apiBaseUrl: 'https://api.example.com/v1',
      responsesUrl: 'https://api.example.com/v1/responses',
      modelsUrls: ['https://api.example.com/v1/models', 'https://api.example.com/models'],
    });

    expect(resolveResponsesCompatibleUrls('https://api.example.com/v1/')).toEqual({
      baseUrl: 'https://api.example.com/v1',
      apiBaseUrl: 'https://api.example.com/v1',
      responsesUrl: 'https://api.example.com/v1/responses',
      modelsUrls: ['https://api.example.com/v1/models'],
    });

    expect(resolveResponsesCompatibleUrls('https://gw.example.com/backend-api/codex')).toEqual({
      baseUrl: 'https://gw.example.com/backend-api/codex',
      apiBaseUrl: 'https://gw.example.com/backend-api/codex',
      responsesUrl: 'https://gw.example.com/backend-api/codex/responses',
      modelsUrls: [
        'https://gw.example.com/backend-api/codex/models',
        'https://gw.example.com/backend-api/v1/models',
      ],
    });

    expect(resolveResponsesCompatibleUrls('https://gw.example.com/sub2api')).toEqual({
      baseUrl: 'https://gw.example.com/sub2api',
      apiBaseUrl: 'https://gw.example.com/sub2api/v1',
      responsesUrl: 'https://gw.example.com/sub2api/v1/responses',
      modelsUrls: [
        'https://gw.example.com/sub2api/v1/models',
        'https://gw.example.com/sub2api/models',
      ],
    });

    expect(resolveResponsesCompatibleUrls('http://127.0.0.1:3000').responsesUrl).toBe(
      'http://127.0.0.1:3000/v1/responses',
    );
  });

  it.each([
    'http://api.example.com',
    'http://192.168.1.10:3000',
    'https://api.example.com/v1/responses',
    'https://api.example.com/responses',
    'https://api.example.com/v1/models',
    'https://api.example.com/models',
    'https://api.example.com/v1?key=abc',
    'https://user:pass@api.example.com/v1',
  ])('rejects invalid base URL %s', base => {
    expect(() => resolveResponsesCompatibleUrls(base)).toThrow();
  });

  it('builds saved models with user/server/default context windows and disabled filtering', () => {
    const cfg = makeConfig({ model: 'custom-a' });
    cfg.responsesCompatible!.models = {
      'custom-a': { source: 'manual', contextWindow: 128_000, reportedContextWindow: 64_000 },
      'custom-b': { source: 'discovered', reportedContextWindow: 256_000 },
      'custom-c': { source: 'manual' },
      hidden: { source: 'manual' },
    };
    cfg.models = { hidden: { enabled: false } };

    expect(buildResponsesCompatibleModels(cfg)).toEqual([
      expect.objectContaining({ id: 'custom-a', contextWindow: 128_000, pricing: null }),
      expect.objectContaining({ id: 'custom-b', contextWindow: 256_000, pricing: null }),
      expect.objectContaining({ id: 'custom-c', contextWindow: 200_000, pricing: null }),
    ]);
  });

  it.each([
    [undefined, true, false],
    ['bearer', true, false],
    ['x-api-key', false, true],
    ['both', true, true],
  ] as const)(
    'discovers models using %s authentication',
    async (authMode: ResponsesCompatibleAuthMode | undefined, expectBearer, expectApiKeyHeader) => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return jsonResponse(200, {
          data: [
            { id: 'gpt-5.4', context_length: 1_050_000 },
            { id: 'claude-sonnet-4-6', max_input_tokens: 200_000 },
          ],
        });
      });

      const models = await discoverResponsesCompatibleModels('https://api.example.com', ' secret ', authMode);
      expect(models).toEqual([
        { id: 'gpt-5.4', contextWindow: 1_050_000 },
        { id: 'claude-sonnet-4-6', contextWindow: 200_000 },
      ]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: 'GET', url: 'https://api.example.com/v1/models' });
      expect(requests[0].headers?.Authorization).toBe(expectBearer ? 'Bearer secret' : undefined);
      expect(requests[0].headers?.['x-api-key']).toBe(expectApiKeyHeader ? 'secret' : undefined);
    },
  );

  it('omits authentication headers when API key is blank during discovery', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(200, { data: [{ id: 'local-model' }] });
    });

    expect(await discoverResponsesCompatibleModels('http://127.0.0.1:3000', '   ', 'both')).toEqual([
      { id: 'local-model' },
    ]);
    expect(requests[0].headers).not.toHaveProperty('Authorization');
    expect(requests[0].headers).not.toHaveProperty('x-api-key');
  });

  it('falls back from 404 /v1/models to /models and parses context_length and max_input_tokens', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      if (requests.length === 1) {
        return jsonResponse(404, { error: { message: 'Not found' } });
      }
      return jsonResponse(200, {
        data: [
          { id: 'proxy/gpt-5.4', context_length: 1_050_000 },
          { id: 'claude-opus-4-6', max_input_tokens: 200_000 },
          { id: 'plain-model' },
        ],
      });
    });

    const models = await discoverResponsesCompatibleModels('https://api.example.com', 'secret');
    expect(requests.map(r => r.url)).toEqual([
      'https://api.example.com/v1/models',
      'https://api.example.com/models',
    ]);
    expect(models).toEqual([
      { id: 'proxy/gpt-5.4', contextWindow: 1_050_000 },
      { id: 'claude-opus-4-6', contextWindow: 200_000 },
      { id: 'plain-model' },
    ]);
  });

  it('fails immediately on non-404 discovery error without fallback', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(401, { error: { message: 'Invalid API key' } });
    });

    await expect(discoverResponsesCompatibleModels('https://api.example.com', 'bad')).rejects.toThrow(/401|API key/i);
    expect(requests).toHaveLength(1);
  });
});

describe('ResponsesCompatibleAdapter requests, fallback, and SSE streaming', () => {
  it('sends stateless defaults: store:false, instructions, array input, flat tools, reasoning, and omits temperature when thinking is enabled', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return sseResponse(sse(
        { type: 'response.output_text.delta', delta: 'OK' },
        { type: 'response.completed', response: { id: 'resp_stateless', usage: { input_tokens: 5, output_tokens: 2 } } },
      ));
    });

    const adapter = new ResponsesCompatibleAdapter(makeConfig({ model: 'custom-proxy-model' }), 'responses-compatible-test');
    const chunks = await collect(adapter.generateStreamAsync('Inspect note', {
      systemPrompt: 'Be concise.',
      tools: sampleTools,
      enableThinking: true,
      thinkingEffort: 'high',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 4096,
    }));

    expect(concatContent(chunks)).toBe('OK');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.example.com/v1/responses',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
      },
    });

    const body = JSON.parse(requests[0].body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'custom-proxy-model',
      stream: true,
      store: false,
      instructions: 'Be concise.',
      input: [{ role: 'user', content: 'Inspect note' }],
      tools: [
        {
          type: 'function',
          name: 'lookup_note',
          description: 'Find a vault note',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
      tool_choice: 'auto',
      reasoning: { effort: 'high', summary: 'auto' },
      max_output_tokens: 4096,
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
  });

  it('includes temperature when thinking is disabled and supports stateful request fields', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return sseResponse(sse(
        { type: 'response.output_text.delta', delta: 'Stateful OK' },
        { type: 'response.completed', response: { id: 'resp_next' } },
      ));
    });

    const adapter = new ResponsesCompatibleAdapter(
      makeConfig({ model: 'custom-proxy-model', stateMode: 'stateful', authMode: 'x-api-key' }),
      'responses-compatible-stateful',
    );
    await collect(adapter.generateStreamAsync('Continue', {
      temperature: 0.3,
      previousResponseId: 'resp_prev',
    }));

    expect(requests[0].headers).toMatchObject({ 'x-api-key': 'secret' });
    expect(requests[0].headers).not.toHaveProperty('Authorization');

    const body = JSON.parse(requests[0].body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'custom-proxy-model',
      stream: true,
      input: 'Continue',
      previous_response_id: 'resp_prev',
      temperature: 0.3,
    });
    expect(body).not.toHaveProperty('store');
    expect(body).not.toHaveProperty('instructions');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('parses standard non-streaming JSON responses including reasoning summary, output text, and usage', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(200, {
        id: 'resp_json_1',
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [{ text: 'First step. ' }, { text: 'Second step.' }] },
          { type: 'message', content: [{ type: 'output_text', text: 'Final answer' }] },
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      });
    });

    const adapter = new ResponsesCompatibleAdapter(makeConfig(), 'responses-compatible-test');
    const result = await adapter.generateUncached('Explain');

    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].body!)).toMatchObject({
      model: 'gpt-5.4',
      stream: false,
      store: false,
      instructions: '',
      input: [{ role: 'user', content: 'Explain' }],
    });
    expect(result).toMatchObject({
      text: 'Final answer',
      provider: 'responses-compatible-test',
      model: 'gpt-5.4',
      finishReason: 'stop',
      usage: {
        promptTokens: 12,
        completionTokens: 8,
        totalTokens: 20,
        cacheReadTokens: 4,
        cachedTokens: 4,
        reasoningTokens: 3,
      },
      metadata: {
        responseId: 'resp_json_1',
        thinking: 'First step. Second step.',
      },
    });
  });

  it('falls back to streaming collection in generateUncached when gateway returns HTTP 400 stream must be set to true', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      if (requests.length === 1) {
        return jsonResponse(400, { error: { message: 'Stream must be set to true' } });
      }
      return sseResponse(sse(
        { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Codex thought' },
        { type: 'response.output_text.delta', output_index: 1, delta: 'Codex ' },
        { type: 'response.output_text.delta', output_index: 1, delta: 'answer' },
        {
          type: 'response.completed',
          response: {
            id: 'resp_codex_stream',
            usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
          },
        },
      ));
    });

    const adapter = new ResponsesCompatibleAdapter(
      makeConfig({ baseUrl: 'https://gw.example.com/backend-api/codex' }),
      'responses-compatible-codex',
    );
    const result = await adapter.generateUncached('Hello Codex');

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe('https://gw.example.com/backend-api/codex/responses');
    expect(JSON.parse(requests[0].body!).stream).toBe(false);
    expect(JSON.parse(requests[1].body!).stream).toBe(true);
    expect(result).toMatchObject({
      text: 'Codex answer',
      provider: 'responses-compatible-codex',
      finishReason: 'stop',
      usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 },
      metadata: { responseId: 'resp_codex_stream', thinking: 'Codex thought' },
    });
  });

  it('falls back to streaming collection in generateUncached when gateway returns HTTP 200 text/event-stream', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return {
        ...sseResponse(sse(
          { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Inspecting' },
          { type: 'response.output_text.delta', output_index: 1, delta: 'SSE over non-stream' },
          {
            type: 'response.completed',
            response: {
              id: 'resp_sse_fallback',
              usage: { input_tokens: 6, output_tokens: 3, total_tokens: 9 },
            },
          },
        )),
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      };
    });

    const adapter = new ResponsesCompatibleAdapter(makeConfig(), 'responses-compatible-test');
    const result = await adapter.generateUncached('Hello');

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({
      text: 'SSE over non-stream',
      finishReason: 'stop',
      usage: { promptTokens: 6, completionTokens: 3, totalTokens: 9 },
      metadata: { responseId: 'resp_sse_fallback', thinking: 'Inspecting' },
    });
  });

  it('does not fall back to streaming on non-stream HTTP 400 errors', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(400, { error: { message: 'Unknown model id' } });
    });

    const adapter = new ResponsesCompatibleAdapter(makeConfig(), 'responses-compatible-test');
    const err = await captureError(adapter.generateUncached('Hi'));

    expect(requests).toHaveLength(1);
    expect(err).toBeInstanceOf(LLMProviderError);
    expect(err).toMatchObject({ code: 'INVALID_REQUEST', httpStatus: 400 });
  });

  it('streams reasoning summary deltas, output text deltas, function_call items, and response.completed usage', async () => {
    __setRequestUrlMock(async () => sseResponse(sse(
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Checking ' },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'notes' },
      { type: 'response.reasoning_summary_text.done', item_id: 'rs_1', text: 'Checking notes' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.output_text.delta', output_index: 1, delta: 'Calling ' },
      { type: 'response.output_text.delta', output_index: 1, delta: 'tool' },
      {
        type: 'response.output_item.done',
        output_index: 2,
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup_note',
          arguments: '{"query":"roadmap"}',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_stream_1',
          usage: {
            input_tokens: 20,
            output_tokens: 11,
            total_tokens: 31,
            input_tokens_details: { cached_tokens: 8 },
            output_tokens_details: { reasoning_tokens: 5 },
          },
        },
      },
    )));

    const chunks = await collect(
      new ResponsesCompatibleAdapter(makeConfig(), 'responses-compatible-test').generateStreamAsync('Find roadmap', {
        tools: sampleTools,
        enableThinking: true,
      }),
    );

    expect(concatContent(chunks)).toBe('Calling tool');
    expect(chunks).toContainEqual({
      content: '',
      complete: false,
      reasoning: 'Checking ',
      reasoningComplete: false,
      reasoningId: 'rs_1',
    });
    expect(chunks).toContainEqual({
      content: '',
      complete: false,
      reasoning: 'notes',
      reasoningComplete: false,
      reasoningId: 'rs_1',
    });
    expect(chunks).toContainEqual({
      content: '',
      complete: false,
      reasoning: '',
      reasoningComplete: true,
      reasoningId: 'rs_1',
    });
    expect(chunks[chunks.length - 1]).toMatchObject({
      complete: true,
      finishReason: 'tool_calls',
      toolCallsReady: true,
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup_note', arguments: '{"query":"roadmap"}' },
        },
      ],
      usage: {
        promptTokens: 20,
        completionTokens: 11,
        totalTokens: 31,
        cacheReadTokens: 8,
        cachedTokens: 8,
        reasoningTokens: 5,
      },
      metadata: { responseId: 'resp_stream_1' },
    });
  });

  it.each([
    [
      'response.failed',
      { type: 'response.failed', response: { error: { message: 'Model capacity exceeded', code: 'rate_limit_exceeded' } } },
      429,
      'Model capacity exceeded',
    ],
    [
      'error event',
      { type: 'error', code: 'server_error', message: 'Upstream gateway failure' },
      500,
      'Upstream gateway failure',
    ],
  ])(
    'throws LLMProviderError on mid-stream %s over HTTP 200 without completing',
    async (_label, errorFrame, expectedStatus, expectedMessage) => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { type: 'response.output_text.delta', delta: 'partial' },
        errorFrame,
      )));

      const emitted: StreamChunk[] = [];
      const err = await captureError((async () => {
        for await (const chunk of new ResponsesCompatibleAdapter(makeConfig(), 'responses-compatible-test').generateStreamAsync('Hi')) {
          emitted.push(chunk);
        }
      })());

      expect(emitted.some(chunk => chunk.complete)).toBe(false);
      expect(err).toBeInstanceOf(LLMProviderError);
      expect(err).toMatchObject({
        code: 'PROVIDER_STREAM_ERROR',
        httpStatus: expectedStatus,
        technicalMessage: expectedMessage,
      });
    },
  );

  it('aborts in-flight work and blocks subsequent requests once disposed', async () => {
    __setRequestUrlMock(() => new Promise(() => {}));
    const adapter = new ResponsesCompatibleAdapter(makeConfig(), 'responses-compatible-test');
    const pending = adapter.generateUncached('Hi');

    adapter.dispose();

    const firstErr = await captureError(pending);
    expect(firstErr).toBeInstanceOf(LLMProviderError);
    expect(firstErr).toMatchObject({ code: 'ABORTED' });

    const secondErr = await captureError(adapter.generateUncached('Hi'));
    expect(secondErr).toBeInstanceOf(LLMProviderError);
    expect(secondErr).toMatchObject({ code: 'ABORTED' });
  });
});

describe('ProviderMessageBuilder and syncCompatibleWireProtocols for Responses-compatible endpoints', () => {
  afterEach(() => {
    syncCompatibleWireProtocols();
  });

  it('resolves responses wire family, openAI context builder, and synced state mode', () => {
    expect(resolveProviderWireFamily('responses-compatible-default', 'gpt-5.4')).toBe('responses');
    expect(resolveResponsesStateMode('responses-compatible-default')).toBe('stateless');
    expect(getContextBuilder('responses-compatible-default', 'gpt-5.4')).toBe(getContextBuilder('openai'));

    syncCompatibleWireProtocols({
      'responses-compatible-stateful': makeConfig({ stateMode: 'stateful' }),
    });
    expect(resolveResponsesStateMode('responses-compatible-stateful')).toBe('stateful');

    syncCompatibleWireProtocols({});
    expect(resolveResponsesStateMode('responses-compatible-stateful')).toBe('stateless');
  });

  it('builds toResponsesInputItems initially and appends function_call + function_call_output without previousResponseId in stateless mode', () => {
    syncCompatibleWireProtocols({
      'responses-compatible-stateless': makeConfig({ stateMode: 'stateless' }),
    });

    const builder = new ProviderMessageBuilder(new Map());
    const initial = builder.buildInitialOptions(
      'responses-compatible-stateless',
      'gpt-5.4',
      [
        { role: 'system', content: 'System instructions' },
        { role: 'user', content: 'Earlier question' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_prev', type: 'function', function: { name: 'lookup_note', arguments: '{"query":"a"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_prev', content: '{"found":true}' },
        { role: 'user', content: 'Follow up' },
      ],
      { tools: sampleTools },
    );

    expect(initial.userPrompt).toBe('Follow up');
    expect(initial.generateOptions.systemPrompt).toBe('System instructions');
    expect(initial.generateOptions.conversationHistory).toEqual([
      { role: 'user', content: 'Earlier question' },
      { type: 'function_call', call_id: 'call_prev', name: 'lookup_note', arguments: '{"query":"a"}' },
      { type: 'function_call_output', call_id: 'call_prev', output: '{"found":true}' },
      { role: 'user', content: 'Follow up' },
    ]);

    const continuation = builder.buildContinuationOptions(
      'responses-compatible-stateless',
      initial.userPrompt,
      [{ id: 'call_1', type: 'function', function: { name: 'lookup_note', arguments: '{"query":"b"}' } }],
      [{ id: 'call_1', name: 'lookup_note', success: true, result: { title: 'Note B' } }],
      [],
      initial.generateOptions,
      { conversationId: 'conv-stateless', responsesApiId: 'resp_ignored' },
    );

    expect(continuation.previousResponseId).toBeUndefined();
    expect(continuation.conversationHistory).toEqual([
      { role: 'user', content: 'Earlier question' },
      { type: 'function_call', call_id: 'call_prev', name: 'lookup_note', arguments: '{"query":"a"}' },
      { type: 'function_call_output', call_id: 'call_prev', output: '{"found":true}' },
      { role: 'user', content: 'Follow up' },
      { type: 'function_call', call_id: 'call_1', name: 'lookup_note', arguments: '{"query":"b"}' },
      { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ title: 'Note B' }) },
    ]);

    const synthContinuation = builder.buildContinuationOptions(
      'responses-compatible-stateless',
      initial.userPrompt,
      [{ id: '', type: 'function', function: { name: 'lookup_note', arguments: '{}' } }],
      [{ id: '', name: 'lookup_note', success: true, result: 'ok' }],
      [],
      initial.generateOptions,
    );
    const items = synthContinuation.conversationHistory as Array<Record<string, unknown>>;
    const synthCall = items[items.length - 2];
    const synthOutput = items[items.length - 1];
    expect(synthCall?.call_id).toMatch(/^call_synth_responses_/);
    expect(synthOutput?.call_id).toBe(synthCall?.call_id);
  });

  it('uses previousResponseId and function_call_output items on continuation in stateful mode', () => {
    syncCompatibleWireProtocols({
      'responses-compatible-stateful': makeConfig({ stateMode: 'stateful' }),
    });

    const builder = new ProviderMessageBuilder(new Map());
    const initial = builder.buildInitialOptions(
      'responses-compatible-stateful',
      'gpt-5.4',
      [
        { role: 'system', content: 'System instructions' },
        { role: 'user', content: 'Look up note' },
      ],
      { tools: sampleTools },
    );

    expect(initial.generateOptions.conversationHistory).toEqual([
      { role: 'user', content: 'Look up note' },
    ]);

    const firstContinuation = builder.buildContinuationOptions(
      'responses-compatible-stateful',
      initial.userPrompt,
      [{ id: 'call_1', type: 'function', function: { name: 'lookup_note', arguments: '{"query":"x"}' } }],
      [{ id: 'call_1', name: 'lookup_note', success: true, result: 'found' }],
      [],
      initial.generateOptions,
      { conversationId: 'conv-stateful', responsesApiId: 'resp_turn_1' },
    );

    expect(firstContinuation.previousResponseId).toBe('resp_turn_1');
    expect(firstContinuation.conversationHistory).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: '"found"' },
    ]);

    builder.updateResponseId('conv-stateful', 'resp_turn_2');
    const secondContinuation = builder.buildContinuationOptions(
      'responses-compatible-stateful',
      initial.userPrompt,
      [{ id: 'call_2', type: 'function', function: { name: 'lookup_note', arguments: '{"query":"y"}' } }],
      [{ id: 'call_2', name: 'lookup_note', success: false, error: 'Missing' }],
      [],
      firstContinuation,
      { conversationId: 'conv-stateful', responsesApiId: 'resp_turn_1' },
    );

    expect(secondContinuation.previousResponseId).toBe('resp_turn_2');
    expect(secondContinuation.conversationHistory).toEqual([
      { type: 'function_call_output', call_id: 'call_2', output: JSON.stringify({ error: 'Missing' }) },
    ]);
  });
});
