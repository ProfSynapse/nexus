/**
 * Live provider acceptance of recursive tool history, beyond canned SSE fixtures.
 * Sends only synthetic prompts and in-memory receipt tools; never reads a vault.
 * Real desktop streaming transport; requestUrl is bridged to fetch for nonstreaming.
 * Supply GOOGLE_API_KEY and OPENROUTER_API_KEY in the environment.
 * RUN_PROVIDER_CONTINUATION_SMOKE=1 npx jest tests/debug/provider-continuation-live-smoke.test.ts --runInBand --no-coverage
 * Optional CONTINUATION_SMOKE_PROVIDER=google|openrouter selects one provider.
 * GOOGLE_CONTINUATION_MODEL / OPENROUTER_CONTINUATION_MODEL override model IDs.
 * Rejected-model cases are real HTTP rejections, not induced midstream failures.
 */
import { __setRequestUrlMock } from 'obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'), hasNodeRuntime: () => true, isDesktop: () => true,
}));
jest.mock('../../src/utils/desktopRequire', () => ({
  desktopRequire: (moduleName: string) => jest.requireActual(moduleName),
}));

import { GoogleAdapter } from '../../src/services/llm/adapters/google/GoogleAdapter';
import { OpenRouterAdapter } from '../../src/services/llm/adapters/openrouter/OpenRouterAdapter';
import type { IAdapterRegistry } from '../../src/services/llm/core/AdapterRegistry';
import type { IToolExecutor } from '../../src/services/llm/adapters/shared/ToolExecutionUtils';
import { StreamingOrchestrator } from '../../src/services/llm/core/StreamingOrchestrator';
import { ProviderHttpClient, ProviderHttpError } from '../../src/services/llm/adapters/shared/ProviderHttpClient';

const describeLive = process.env.RUN_PROVIDER_CONTINUATION_SMOKE === '1' ? describe : describe.skip;
const targets = [
  { provider: 'google', model: process.env.GOOGLE_CONTINUATION_MODEL || 'gemini-3.5-flash-lite', key: 'GOOGLE_API_KEY' },
  { provider: 'openrouter', model: process.env.OPENROUTER_CONTINUATION_MODEL || 'google/gemini-3.5-flash-lite', key: 'OPENROUTER_API_KEY' },
].filter(target => !process.env.CONTINUATION_SMOKE_PROVIDER || target.provider === process.env.CONTINUATION_SMOKE_PROVIDER);
jest.setTimeout(180_000);

describeLive.each(targets)('$provider continuation live smoke', ({ provider, model, key }) => {
  let adapter: GoogleAdapter | OpenRouterAdapter;
  let requestCount: number;
  let rejectedStatus: number | undefined;

  beforeEach(() => {
    const credential = process.env[key];
    if (!credential) throw new Error(`${key} is required for the selected live continuation smoke`);
    adapter = provider === 'google' ? new GoogleAdapter(credential, model) : new OpenRouterAdapter(credential);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    requestCount = 0;
    rejectedStatus = undefined;
    const realStream = ProviderHttpClient.requestStream.bind(ProviderHttpClient);
    jest.spyOn(ProviderHttpClient, 'requestStream').mockImplementation(config => {
      requestCount += 1;
      return realStream(config).catch(error => {
        if (error instanceof ProviderHttpError) rejectedStatus = error.response.status;
        throw error;
      });
    });
    __setRequestUrlMock(async request => {
      const response = await fetch(request.url || '', {
        method: request.method || 'GET', headers: request.headers,
        body: typeof request.body === 'string' ? request.body : undefined,
        signal: AbortSignal.timeout(120_000),
      });
      const arrayBuffer = await response.arrayBuffer();
      const text = new TextDecoder().decode(arrayBuffer);
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* Buffered SSE need not be JSON. */ }
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text, json, arrayBuffer };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns nonstreaming text and usage', async () => {
    const response = await adapter.generateUncached('Reply with ready.', { model, maxTokens: 512, enableThinking: false });
    expect(Boolean(response.text?.trim())).toBe(true);
    expect((response.usage?.totalTokens || 0) > 0).toBe(true);
  });

  it('surfaces a real rejected streaming model without reporting completion', async () => {
    let caught: unknown;
    let complete = false;
    try {
      for await (const chunk of adapter.generateStreamAsync('Reply ready.', { model: 'nexus-invalid-smoke-model', maxTokens: 32 })) {
        complete ||= Boolean(chunk.complete);
      }
    } catch (error) { caught = error; }
    expect(caught instanceof Error).toBe(true);
    expect([400, 404]).toContain(rejectedStatus);
    expect(complete).toBe(false);
  });

  it('finishes two sequential tools and one streamed turn through the real orchestrator', async () => {
    const executed: number[] = [];
    const executor: IToolExecutor = {
      async executeToolCalls(calls) {
        if (calls.length !== 1) throw new Error('Smoke requires sequential tool calls');
        return calls.map(call => {
          const args: unknown = JSON.parse(call.function.arguments);
          if (call.function.name !== 'smoke_echo' || typeof args !== 'object' || args === null || !('step' in args)) {
            throw new Error('Unexpected smoke tool call');
          }
          const step = args.step;
          if (step !== executed.length + 1 || (step !== 1 && step !== 2)) throw new Error('Unexpected smoke step');
          if (step === 2 && (!('receipt' in args) || args.receipt !== 'receipt-first')) throw new Error('First receipt missing');
          executed.push(step);
          return { id: call.id, name: call.function.name, success: true, result: { receipt: step === 1 ? 'receipt-first' : 'receipt-second' } };
        });
      },
    };
    const registry: IAdapterRegistry = {
      initialize: () => undefined, updateSettings: () => undefined, clear: () => undefined,
      getAdapter: name => name === provider ? adapter : undefined,
      getAvailableProviders: () => [provider], isProviderAvailable: name => name === provider,
    };
    const orchestrator = new StreamingOrchestrator(registry, { providers: {}, defaultModel: { provider, model } }, executor);
    const prompt = 'Call smoke_echo with step 1. Wait for its result, then call smoke_echo with step 2 and the receipt from step 1. '
      + 'Never call both together. After step 2 returns, reply with its receipt and stop.';
    let answer = '';
    let failure = '';
    let completed = 0;
    let responses = 0;
    for await (const event of orchestrator.generateResponseStream([{ role: 'user', content: prompt }], {
      provider, model, maxTokens: 1024, enableThinking: false,
      tools: [{ type: 'function', function: {
        name: 'smoke_echo', description: 'Return receipt for one step; step 2 requires the receipt from step 1.',
        parameters: { type: 'object', properties: { step: { type: 'integer', description: 'Step 1 or 2.' }, receipt: { type: 'string' } }, required: ['step'] },
      } }],
    })) {
      if (event.type === 'assistant.delta') answer += event.text;
      if (event.type === 'turn.failed') failure = event.error.message;
      if (event.type === 'turn.aborted') failure = event.reason;
      if (event.type === 'turn.completed') completed += 1;
      if (event.type === 'response.completed') responses += 1;
    }
    expect(failure.replaceAll(process.env[key] || 'unused-secret-placeholder', '[redacted]')).toBe('');
    expect(executed).toEqual([1, 2]);
    expect(answer.includes('receipt-second')).toBe(true);
    expect(completed).toBe(1);
    expect(responses).toBe(3);
    expect(requestCount).toBe(3);
  });
});
