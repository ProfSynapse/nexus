/**
 * Real Anthropic acceptance of thinking/tool continuation cannot be proved by
 * canned SSE: the server validates opaque thinking blocks and tool-result IDs.
 * No vault access; the only client tool returns deterministic in-memory receipts.
 *
 * ANTHROPIC_API_KEY must be supplied in the environment (never read from files).
 * RUN_ANTHROPIC_CONTINUATION_SMOKE=1 npx jest tests/debug/anthropic-continuation-live-smoke.test.ts --runInBand --no-coverage
 * Optional ANTHROPIC_CONTINUATION_MODEL overrides claude-opus-5-5.
 *
 * Streaming uses the real desktop Node transport; nonstreaming requestUrl is
 * bridged to real fetch because Obsidian itself is absent from this Jest lane.
 * Anthropic has no deliberate midstream-error switch. The explicitly labelled
 * error-frame case injects HTTP 200 SSE; HTTP rejection uses the real provider.
 * Assertions/logging never dump response text, reasoning, signatures or keys.
 */
import { __setRequestUrlMock } from 'obsidian';
import { Readable } from 'node:stream';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => true,
  isDesktop: () => true,
}));
jest.mock('../../src/utils/desktopRequire', () => ({
  desktopRequire: (moduleName: string) => jest.requireActual(moduleName),
}));

import { AnthropicAdapter } from '../../src/services/llm/adapters/anthropic/AnthropicAdapter';
import { ProviderHttpClient, ProviderHttpError } from '../../src/services/llm/adapters/shared/ProviderHttpClient';
import type { IToolExecutor } from '../../src/services/llm/adapters/shared/ToolExecutionUtils';
import type { GenerateOptions } from '../../src/services/llm/adapters/types';
import type { IAdapterRegistry } from '../../src/services/llm/core/AdapterRegistry';
import { StreamingOrchestrator } from '../../src/services/llm/core/StreamingOrchestrator';

const describeLive = process.env.RUN_ANTHROPIC_CONTINUATION_SMOKE === '1' ? describe : describe.skip;
const model = process.env.ANTHROPIC_CONTINUATION_MODEL || 'claude-opus-5-5';
const options: GenerateOptions = { model, maxTokens: 4096, enableThinking: true, thinkingEffort: 'low' };
jest.setTimeout(240_000);

function registry(adapter: AnthropicAdapter): IAdapterRegistry {
  return {
    initialize: () => undefined,
    updateSettings: () => undefined,
    getAdapter: provider => provider === 'anthropic' ? adapter : undefined,
    getAvailableProviders: () => ['anthropic'],
    isProviderAvailable: provider => provider === 'anthropic',
    clear: () => undefined,
  };
}

describeLive('Anthropic continuation live smoke', () => {
  let adapter: AnthropicAdapter;
  let errorLog: jest.SpyInstance;
  let streamRequest: jest.SpyInstance;
  let requests: Array<{
    thinking: boolean;
    webSearch: boolean;
    messages: Array<{ role: unknown; blocks: Array<Record<string, string>> }>;
  }>;

  function recordRequest(body: string | undefined): void {
    const params = JSON.parse(body || '{}') as {
      thinking?: { type?: string };
      tools?: Array<{ name?: string }>;
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    requests.push({
      thinking: params.thinking?.type === 'adaptive' || params.thinking?.type === 'enabled',
      webSearch: Boolean(params.tools?.some(tool => tool.name === 'web_search')),
      messages: (params.messages || []).map(message => ({
        role: message.role,
        blocks: (Array.isArray(message.content) ? message.content : []).map((block: unknown) => {
          const outline: Record<string, string> = {};
          if (typeof block !== 'object' || block === null) return outline;
          for (const key of ['type', 'id', 'tool_use_id']) {
            if (key in block && typeof (block as Record<string, unknown>)[key] === 'string') {
              outline[key] = (block as Record<string, string>)[key];
            }
          }
          return outline;
        }),
      })),
    });
  }

  beforeEach(() => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is required for the live continuation smoke');
    adapter = new AnthropicAdapter(key, model);
    requests = [];
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const realRequestStream = ProviderHttpClient.requestStream.bind(ProviderHttpClient);
    streamRequest = jest.spyOn(ProviderHttpClient, 'requestStream').mockImplementation(config => {
      recordRequest(config.body);
      return realRequestStream(config);
    });
    __setRequestUrlMock(async request => {
      const body = typeof request.body === 'string' ? request.body : undefined;
      recordRequest(body);
      const response = await fetch(request.url || '', {
        method: request.method || 'GET',
        headers: request.headers,
        body,
        signal: AbortSignal.timeout(180_000),
      });
      const arrayBuffer = await response.arrayBuffer();
      const text = new TextDecoder().decode(arrayBuffer);
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* SSE is not a JSON document. */ }
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text, json, arrayBuffer };
    });
  });

  afterEach(() => {
    errorLog?.mockRestore();
    streamRequest?.mockRestore();
  });

  it('returns nonstreaming text and usage from the real provider', async () => {
    const response = await adapter.generateUncached('Reply with the word ready.', options);
    expect(Boolean(response.text?.trim())).toBe(true);
    expect((response.usage?.totalTokens || 0) > 0).toBe(true);
    expect(requests.every(request => request.thinking)).toBe(true);
  });

  it('streams text, usage and one completion from the real provider', async () => {
    let textLength = 0;
    let completions = 0;
    let usage = false;
    for await (const chunk of adapter.generateStreamAsync('Reply with the word ready.', options)) {
      textLength += chunk.content.length;
      if (chunk.complete) completions += 1;
      usage ||= (chunk.usage?.totalTokens || 0) > 0;
    }
    expect(textLength > 0).toBe(true);
    expect(completions).toBe(1);
    expect(usage).toBe(true);
  });

  it('surfaces the real provider explanation for a rejected streaming request', async () => {
    let caught: unknown;
    try {
      for await (const _chunk of adapter.generateStreamAsync('Reply ready.', { ...options, maxTokens: -1 })) {
        // Invalid max_tokens must fail before a successful stream.
      }
    } catch (error) { caught = error; }
    expect(caught instanceof ProviderHttpError).toBe(true);
    if (!(caught instanceof ProviderHttpError)) return;
    expect(caught.response.status).toBe(400);
    expect(caught.message.length > 'streaming generation failed with HTTP 400'.length).toBe(true);
  });

  it.each([false, true])('finishes two sequential client tools with thinking and webSearch=%s', async webSearch => {
    const executed: number[] = [];
    const executor: IToolExecutor = {
      async executeToolCalls(calls) {
        if (calls.length !== 1) throw new Error('Smoke tool calls must be sequential');
        return calls.map(call => {
          const args: unknown = JSON.parse(call.function.arguments);
          if (call.function.name !== 'smoke_echo' || typeof args !== 'object' || args === null || !('step' in args)) {
            throw new Error('Unexpected smoke tool call');
          }
          const step = args.step;
          if (step !== executed.length + 1 || (step !== 1 && step !== 2)) throw new Error('Unexpected smoke step');
          if (step === 2 && (!('receipt' in args) || args.receipt !== 'receipt-first')) throw new Error('Missing first receipt');
          executed.push(step);
          return { id: call.id, name: call.function.name, success: true, result: { receipt: step === 1 ? 'receipt-first' : 'receipt-second' } };
        });
      },
    };
    const orchestrator = new StreamingOrchestrator(registry(adapter), {
      providers: {}, defaultModel: { provider: 'anthropic', model },
    }, executor);
    const prompt = `${webSearch ? 'First use web_search once to find Anthropic official Messages API documentation. Then ' : ''}`
      + 'Call smoke_echo with step 1. Wait for its result, then call smoke_echo with step 2 and the receipt returned by step 1. '
      + 'Never call both steps together. After receiving step 2, reply with its receipt and stop.';
    let responses = 0;
    let completed = 0;
    let failure = '';
    let answerHasReceipt = false;
    let answer = '';
    let nativeSearch = false;
    for await (const event of orchestrator.generateResponseStream([{ role: 'user', content: prompt }], {
      ...options,
      provider: 'anthropic',
      webSearch,
      tools: [{ type: 'function', function: {
        name: 'smoke_echo',
        description: 'Return a deterministic receipt. Step 2 requires the receipt returned by step 1.',
        parameters: { type: 'object', properties: { step: { type: 'integer', enum: [1, 2] }, receipt: { type: 'string' } }, required: ['step'], additionalProperties: false },
      } }],
    })) {
      if (event.type === 'response.completed') responses += 1;
      if (event.type === 'turn.completed') completed += 1;
      if (event.type === 'turn.failed') failure = event.error.message;
      if (event.type === 'turn.aborted') failure = event.reason;
      if (event.type === 'assistant.delta') {
        answer += event.text;
        answerHasReceipt ||= answer.includes('receipt-second');
      }
      if (event.type === 'response.metadata' && Array.isArray(event.metadata.anthropicResponseContent)) {
        nativeSearch ||= event.metadata.anthropicResponseContent.some((block: unknown) =>
          typeof block === 'object' && block !== null && 'type' in block && block.type === 'web_search_tool_result');
      }
    }
    expect(failure ? `${failure}\nOutgoing message outlines: ${JSON.stringify(requests.map(request => request.messages))}` : '').toBe('');
    expect(executed).toEqual([1, 2]);
    expect(responses).toBe(3);
    expect(completed).toBe(1);
    expect(answerHasReceipt).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests.every(request => request.thinking && request.webSearch === webSearch)).toBe(true);
    expect(nativeSearch).toBe(webSearch);
  });

  it('surfaces an injected midstream error after reasoning (fixture, not a live server failure)', async () => {
    const frames = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Synthetic reasoning' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Synthetic overload' } },
    ];
    streamRequest.mockResolvedValueOnce(Readable.from(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`)));
    let reasoning = false;
    let completed = false;
    let caught: unknown;
    try {
      for await (const chunk of adapter.generateStreamAsync('Synthetic failure probe.', options)) {
        reasoning ||= Boolean(chunk.reasoning);
        completed ||= chunk.complete;
      }
    } catch (error) { caught = error; }
    expect(reasoning).toBe(true);
    expect(completed).toBe(false);
    expect(caught instanceof Error && caught.message.includes('Synthetic overload')).toBe(true);
  });
});
