/**
 * GoogleAdapter characterization tests.
 *
 * Pin current behavior of the Gemini generateContent adapter (non-streaming
 * generate, SSE streaming including thought parts and functionCall parts,
 * finish-reason mapping including blocked-response surfacing, withRetry-wrapped
 * error mapping, API-key handling) ahead of shared-code extraction.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { GoogleAdapter } from '../../src/services/llm/adapters/google/GoogleAdapter';
import { GOOGLE_DEFAULT_MODEL } from '../../src/services/llm/adapters/google/GoogleModels';
import { LLMProviderError } from '../../src/services/llm/adapters/types';
import { ProviderHttpError } from '../../src/services/llm/adapters/shared/ProviderHttpClient';
import { streamWithOverloadRetry, OVERLOAD_MAX_RETRIES } from '../../src/services/llm/adapters/shared/OverloadRetry';
import { loadEvalToolFixtures } from '../eval/fixtures/tools';
import {
  jsonResponse,
  sseResponse,
  sse,
  collect,
  concatContent,
  captureError,
  CapturedRequest
} from './helpers/llmAdapterTestHarness';

describe('GoogleAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    jest.useRealTimers();
  });

  it.each([false, true])('uses Google Search and keeps candidate grounding sources (stream=%s)', async stream => {
    const requests: CapturedRequest[] = [];
    const grounded = { candidates: [{ content: { parts: [{ text: 'Answer' }] }, finishReason: 'STOP',
      groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/source', title: 'Example' } }] } }] };
    __setRequestUrlMock(async request => {
      requests.push(request);
      return stream ? sseResponse(sse(grounded)) : jsonResponse(200, grounded);
    });
    const adapter = new GoogleAdapter('gk-test');
    const result = stream
      ? (await collect(adapter.generateStreamAsync('search', { webSearch: true }))).at(-1)?.metadata?.webSearchResults
      : (await adapter.generateUncached('search', { webSearch: true })).webSearchResults;
    expect(JSON.parse(requests[0].body ?? '{}').tools).toContainEqual({ googleSearch: {} });
    expect(result).toEqual([{ title: 'Example', url: 'https://example.com/source', date: undefined }]);
  });

  it.each([false, true])('includes Gemini thoughts and cache reads in usage (stream=%s)', async stream => {
    const response = { candidates: [{ content: { parts: [{ text: 'Answer' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2,
        cachedContentTokenCount: 4, totalTokenCount: 17 } };
    __setRequestUrlMock(async () => stream ? sseResponse(sse(response)) : jsonResponse(200, response));
    const adapter = new GoogleAdapter('gk-test');
    const usage = stream
      ? (await collect(adapter.generateStreamAsync('hi'))).at(-1)?.usage
      : (await adapter.generateUncached('hi')).usage;
    expect(usage).toMatchObject({ promptTokens: 10, completionTokens: 7, totalTokens: 17,
      cacheReadTokens: 4, reasoningTokens: 2 });
  });

  describe('non-streaming generate', () => {
    it('parses candidate parts, usageMetadata, and maps STOP', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          candidates: [{
            content: { parts: [{ text: 'Hi' }, { text: ' there' }] },
            finishReason: 'STOP'
          }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }
        });
      });

      const adapter = new GoogleAdapter('gk-test');
      const result = await adapter.generateUncached('hi', { systemPrompt: 'Be brief' });

      expect(result.text).toBe('Hi there');
      expect(result.model).toBe(GOOGLE_DEFAULT_MODEL);
      expect(result.provider).toBe('google');
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });

      expect(requests[0].url).toBe(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GOOGLE_DEFAULT_MODEL)}:generateContent`
      );
      expect(requests[0].headers?.['x-goog-api-key']).toBe('gk-test');
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
      expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief' }] });
    });

    it('keeps native thought parts out of answer text', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, {
        candidates: [{
          content: { parts: [{ text: 'private summary', thought: true }, { text: 'Answer' }] },
          finishReason: 'STOP'
        }]
      }));

      const result = await new GoogleAdapter('gk-test').generateUncached('hi');

      expect(result.text).toBe('Answer');
      expect(result.metadata?.thinking).toBe('private summary');
    });

    it('maps MAX_TOKENS to length and SAFETY to content_filter', async () => {
      const adapter = new GoogleAdapter('gk-test');

      __setRequestUrlMock(async () => jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }]
      }));
      expect((await adapter.generateUncached('hi')).finishReason).toBe('length');

      __setRequestUrlMock(async () => jsonResponse(200, {
        candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }]
      }));
      expect((await adapter.generateUncached('hi')).finishReason).toBe('content_filter');
    });

    it('omits deprecated sampling parameters for Gemini 3.5 Flash-Lite', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }]
        });
      });

      const adapter = new GoogleAdapter('gk-test', 'gemini-3.5-flash-lite');
      await adapter.generateUncached('hi', { temperature: 0.2 });

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.generationConfig).not.toHaveProperty('temperature');
      expect(body.generationConfig).not.toHaveProperty('topK');
      expect(body.generationConfig).not.toHaveProperty('topP');
    });

    it('omits deprecated sampling parameters for every Gemini 3 model, not just the newest', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }]
        });
      });

      const adapter = new GoogleAdapter('gk-test', 'gemini-3.1-pro-preview');
      await adapter.generateUncached('hi', { temperature: 0.2 });

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.generationConfig).not.toHaveProperty('temperature');
      expect(body.generationConfig).not.toHaveProperty('topK');
      expect(body.generationConfig).not.toHaveProperty('topP');
    });

    it('still sends sampling parameters for pre-Gemini 3 models', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }]
        });
      });

      const adapter = new GoogleAdapter('gk-test', 'gemini-2.5-flash');
      await adapter.generateUncached('hi', { temperature: 0.2 });

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.generationConfig).toEqual(expect.objectContaining({
        temperature: 0.2,
        topK: 40,
        topP: 0.95
      }));
    });
  });

  describe('SSE streaming', () => {
    it('sends the actual Nexus meta-tool schemas through parametersJsonSchema without stripping constraints', async () => {
      // The live endpoint rejected useTools.values.additionalProperties when it
      // was sent through the protobuf `parameters` field. Use the same released
      // catalog as the live eval, and inspect the production adapter's wire body.
      const tools = loadEvalToolFixtures().metaTools;
      const original = JSON.stringify(tools);
      let body = '';
      __setRequestUrlMock(async request => {
        body = request.body ?? '';
        return sseResponse(sse({ candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] }));
      });
      await collect(new GoogleAdapter('gk-test', 'gemini-4-argon').generateStreamAsync('hi', { tools, maxTokens: 128 }));
      const declarations = JSON.parse(body).tools[0].functionDeclarations;
      expect(declarations).toEqual(tools.map(tool => ({
        name: tool.function?.name,
        description: tool.function?.description,
        parametersJsonSchema: tool.function?.parameters
      })));
      const useTools = declarations.find((declaration: { name: string }) => declaration.name === 'useTools');
      expect(useTools.parametersJsonSchema.properties.values.additionalProperties).toEqual({ type: 'string' });
      expect(useTools.parametersJsonSchema.properties.operationId).toMatchObject({
        minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      });
      expect(JSON.stringify(tools)).toBe(original);
    });

    it('yields native thought parts as reasoning without leaking them into content', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse(
          { candidates: [{ content: { parts: [{ text: 'pondering', thought: true }] } }] },
          { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] },
          { candidates: [{ content: { parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }] } }] },
          {
            candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 }
          }
        ));
      });

      const adapter = new GoogleAdapter('gk-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      expect(requests[0].url).toContain(':streamGenerateContent?alt=sse');
      expect(concatContent(chunks)).toBe('Hello!');

      const reasoningChunk = chunks.find(chunk => chunk.reasoning !== undefined);
      expect(reasoningChunk).toMatchObject({ reasoning: 'pondering', reasoningComplete: false });

      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
      expect(final.toolCallsReady).toBe(true);
      expect(final.toolCalls).toEqual([
        { id: 'search_0', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }
      ]);
    });

    it('surfaces MALFORMED_FUNCTION_CALL as user-facing error content and completes the stream', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }
      )));

      const adapter = new GoogleAdapter('gk-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      expect(concatContent(chunks)).toContain('[Error: MALFORMED_FUNCTION_CALL');
      expect(chunks[chunks.length - 1].complete).toBe(true);
    });

    it('rethrows streaming HTTP errors as raw ProviderHttpError (not LLMProviderError)', async () => {
      __setRequestUrlMock(async () => jsonResponse(401, { error: { message: 'API key not valid' } }));

      const adapter = new GoogleAdapter('gk-bad');
      const error = await captureError(collect(adapter.generateStreamAsync('hi')));

      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as ProviderHttpError).response.status).toBe(401);
    });

    // #429 end to end on the mobile (buffered) path: the adapter raises a readable
    // error, and streamWithOverloadRetry -- what the chat runs it through -- backs off.
    describe('overloaded and quota errors on the mobile stream path (#429)', () => {
      const overloaded = () => jsonResponse(503, {
        error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' }
      });
      const chatStream = (adapter: GoogleAdapter, options?: { abortSignal?: AbortSignal }) =>
        collect(streamWithOverloadRetry(() => adapter.generateStreamAsync('hi', options), options?.abortSignal));

      beforeEach(() => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      });

      it('backs off and streams the eventual answer', async () => {
        jest.useFakeTimers();
        let calls = 0;
        __setRequestUrlMock(async () => ++calls <= 2
          ? overloaded()
          : sseResponse(sse({ candidates: [{ content: { parts: [{ text: 'G-ALIVE' }] }, finishReason: 'STOP' }] })));

        const pending = chatStream(new GoogleAdapter('gk-test'));
        await jest.advanceTimersByTimeAsync(20_000);

        expect(concatContent(await pending)).toBe('G-ALIVE');
        expect(calls).toBe(3);
      });

      it('gives up after the last retry with a readable error', async () => {
        jest.useFakeTimers();
        let calls = 0;
        __setRequestUrlMock(async () => { calls++; return overloaded(); });

        const pending = captureError(chatStream(new GoogleAdapter('gk-test')));
        await jest.advanceTimersByTimeAsync(60_000);
        const error = await pending;

        expect(calls).toBe(OVERLOAD_MAX_RETRIES + 1);
        expect((error as ProviderHttpError).response.status).toBe(503);
        expect((error as Error).message).toBe(
          'Google AI is overloaded right now. Wait a moment and try again, or switch to a different model. (HTTP 503)'
        );
      });

      it('does not retry a 429 quota rejection', async () => {
        let calls = 0;
        __setRequestUrlMock(async () => {
          calls++;
          return jsonResponse(429, { error: { code: 429, message: 'Quota exceeded. Please retry in 27s.', status: 'RESOURCE_EXHAUSTED' } });
        });

        const error = await captureError(chatStream(new GoogleAdapter('gk-test')));

        expect(calls).toBe(1);
        expect((error as Error).message).toBe(
          'Google AI says you have hit a rate limit or usage quota. Try again in 27 seconds. ' +
          'If this keeps happening, check your plan and usage limits with the provider. (HTTP 429)'
        );
      });

      it('stops waiting when the user aborts', async () => {
        jest.useFakeTimers();
        let calls = 0;
        __setRequestUrlMock(async () => { calls++; return overloaded(); });
        const controller = new AbortController();

        const pending = captureError(chatStream(new GoogleAdapter('gk-test'), { abortSignal: controller.signal }));
        await jest.advanceTimersByTimeAsync(100);
        controller.abort();
        const error = await pending;

        expect(calls).toBe(1);
        expect((error as Error).name).toBe('AbortError');
      });
    });

    it('uses thinkingLevel and omits deprecated sampling parameters for Gemini 3.6 Flash', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse({
          candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }]
        }));
      });

      const adapter = new GoogleAdapter('gk-test', 'gemini-3.6-flash');
      await collect(adapter.generateStreamAsync('hi', {
        enableThinking: true,
        thinkingEffort: 'high',
        temperature: 0.2
      }));

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.generationConfig).toEqual(expect.objectContaining({
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' }
      }));
      expect(body.generationConfig).not.toHaveProperty('temperature');
      expect(body.generationConfig).not.toHaveProperty('topK');
      expect(body.generationConfig).not.toHaveProperty('topP');
    });

    it('clamps max to high in the Gemini 3 thinkingLevel request', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return sseResponse(sse({ candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] }));
      });
      await collect(new GoogleAdapter('gk-test', 'gemini-3.6-flash').generateStreamAsync('hi', {
        enableThinking: true, thinkingEffort: 'max'
      }));
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'high' });
      expect(body.generationConfig).not.toHaveProperty('maxOutputTokens');
    });

    it('keeps an explicit output allowance when thinking is enabled', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return sseResponse(sse({ candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] }));
      });
      await collect(new GoogleAdapter('gk-test', 'gemini-3.6-flash').generateStreamAsync('hi', {
        enableThinking: true, thinkingEffort: 'max', maxTokens: 60000
      }));
      expect(JSON.parse(requests[0].body ?? '{}').generationConfig.maxOutputTokens).toBe(60000);
    });

    it('maps Gemini 3 Pro Preview medium to its supported high tier', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return sseResponse(sse({ candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] }));
      });
      await collect(new GoogleAdapter('gk-test', 'gemini-3-pro-preview').generateStreamAsync('hi', {
        enableThinking: true, thinkingEffort: 'medium'
      }));
      expect(JSON.parse(requests[0].body ?? '{}').generationConfig.thinkingConfig.thinkingLevel).toBe('high');
    });

    it('requests thought summaries on the legacy thinkingBudget path', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse({
          candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }]
        }));
      });

      const adapter = new GoogleAdapter('gk-test', 'gemini-2.5-pro');
      await collect(adapter.generateStreamAsync('hi', {
        enableThinking: true,
        thinkingEffort: 'high'
      }));

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.generationConfig.thinkingConfig).toEqual(expect.objectContaining({
        includeThoughts: true
      }));
      expect(body.generationConfig.thinkingConfig.thinkingBudget).toBeGreaterThan(0);
    });

    it('omits includeThoughts when thinking is only implied by tools', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse({
          candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }]
        }));
      });

      const adapter = new GoogleAdapter('gk-test', 'gemini-3.6-flash');
      await collect(adapter.generateStreamAsync('hi', {
        tools: [{
          type: 'function',
          function: { name: 'noop', description: 'noop', parameters: { type: 'object' } }
        }]
      }));

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'medium' });
    });
  });

  describe('error mapping (non-streaming, withRetry-wrapped)', () => {
    it('maps HTTP 401 to AUTHENTICATION_ERROR without retrying', async () => {
      let calls = 0;
      __setRequestUrlMock(async () => {
        calls++;
        return jsonResponse(401, { error: { message: 'API key not valid' } });
      });

      const adapter = new GoogleAdapter('gk-bad');
      const error = await captureError(adapter.generateUncached('hi')) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe('AUTHENTICATION_ERROR');
      expect(error.provider).toBe('google');
      expect(error.message).toBe('Google AI did not accept the API key. Check it in Nexus settings under Providers. (HTTP 401)');
      expect(error.technicalMessage).toBe('generation failed: API key not valid');
      expect(calls).toBe(1);
    });

    it.each([
      [429, 'RATE_LIMIT_ERROR', 'Resource has been exhausted'],
      [500, 'SERVER_ERROR', 'Internal error']
    ])('retries HTTP %i three times before failing with %s', async (status, code, providerMessage) => {
      jest.useFakeTimers();
      let calls = 0;
      __setRequestUrlMock(async () => {
        calls++;
        return jsonResponse(status, { error: { message: providerMessage } });
      });

      const adapter = new GoogleAdapter('gk-test');
      const settled = adapter.generateUncached('hi').then(
        () => null,
        (error: unknown) => error
      );
      await jest.runAllTimersAsync();
      const error = await settled as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe(code);
      // People see a readable sentence naming the provider; its own words stay for logs.
      expect(error.message).toMatch(new RegExp(`^Google AI.*\\(HTTP ${status}\\)$`));
      expect(error.technicalMessage).toBe(`generation failed: ${providerMessage}`);
      expect(calls).toBe(4);
    });
  });

  describe('config / API key handling', () => {
    it('masks the API key and reports NOT_SET when missing', () => {
      expect(new GoogleAdapter('gk-test-7777').getApiKey()).toBe('***7777');
      expect(new GoogleAdapter('').getApiKey()).toBe('NOT_SET');
    });

    it('isAvailable is false without an API key and true with one (static listModels)', async () => {
      await expect(new GoogleAdapter('').isAvailable()).resolves.toBe(false);
      await expect(new GoogleAdapter('gk-test').isAvailable()).resolves.toBe(true);
    });

    it('lists static models with capability-driven supportsThinking', async () => {
      const adapter = new GoogleAdapter('gk-test');
      const models = await adapter.listModels();

      expect(models.length).toBeGreaterThan(0);
      expect(models[0].pricing.currency).toBe('USD');
    });
  });

  // These tests inspect real adapter requests; the HTTP fixture only supplies
  // responses. They fail if Argon regresses to Gemini 2 budget/sampling rules,
  // loses explicit small output caps, or reports long decode as a full answer.
  describe('Gemini 4 Argon standard generation', () => {
    const model = 'gemini-4-argon';
    const completed = { candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] };

    it.each([false, true])('uses thinking levels without sampling parameters (stream=%s)', async stream => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return stream ? sseResponse(sse(completed)) : jsonResponse(200, completed);
      });
      const adapter = new GoogleAdapter('gk-test', model);
      for (const effort of ['low', 'medium', 'high', 'max'] as const) {
        const options = { enableThinking: true, thinkingEffort: effort, temperature: 0.2, maxTokens: 128 };
        if (stream) await collect(adapter.generateStreamAsync('hi', options));
        else await adapter.generateUncached('hi', options);
        const config = JSON.parse(requests.at(-1)?.body ?? '{}').generationConfig;
        expect(config).toEqual({
          maxOutputTokens: 128,
          thinkingConfig: { includeThoughts: true, thinkingLevel: effort === 'max' ? 'high' : effort }
        });
      }
    });

    it.each([false, true])('defaults to medium when thinking is enabled (stream=%s)', async stream => {
      let body = '';
      __setRequestUrlMock(async request => {
        body = request.body ?? '';
        return stream ? sseResponse(sse(completed)) : jsonResponse(200, completed);
      });
      const adapter = new GoogleAdapter('gk-test', model);
      if (stream) await collect(adapter.generateStreamAsync('hi', { enableThinking: true }));
      else await adapter.generateUncached('hi', { enableThinking: true });
      expect(JSON.parse(body).generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'medium' });
    });

    it.each([false, true])('preserves small caps and enforces the standard request ceiling (stream=%s)', async stream => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return stream ? sseResponse(sse(completed)) : jsonResponse(200, completed);
      });
      const adapter = new GoogleAdapter('gk-test', model);
      for (const maxTokens of [undefined, 128, 32768, 60000, 262144]) {
        if (stream) await collect(adapter.generateStreamAsync('hi', { maxTokens }));
        else await adapter.generateUncached('hi', { maxTokens });
      }
      expect(requests.map(request => JSON.parse(request.body ?? '{}').generationConfig.maxOutputTokens))
        .toEqual([32768, 128, 32768, stream ? 60000 : 32768, stream ? 65536 : 32768]);
    });

    it.each([false, true])('allows a response up to the 15-minute deadline (stream=%s)', async stream => {
      jest.useFakeTimers();
      let respond!: (response: ReturnType<typeof jsonResponse>) => void;
      let requestCount = 0;
      __setRequestUrlMock(() => {
        requestCount++;
        return new Promise(resolve => { respond = resolve; });
      });
      const adapter = new GoogleAdapter('gk-test', model);
      let settled = false;
      const pending = (stream ? collect(adapter.generateStreamAsync('hi')) : adapter.generateUncached('hi'))
        .then(result => { settled = true; return result; }, error => { settled = true; return error; });
      await jest.advanceTimersByTimeAsync(899_999);
      expect(settled).toBe(false);
      expect(requestCount).toBe(1);
      respond(stream ? sseResponse(sse(completed)) : jsonResponse(200, completed));
      expect(await pending).not.toBeInstanceOf(Error);
    });

    it('marks a buffered CONTINUATION response incomplete without retrying or modifying text', async () => {
      let calls = 0;
      __setRequestUrlMock(async () => {
        calls++;
        return jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: 'Partial answer' }] }, finishReason: 'CONTINUATION' }],
          continuationToken: 'opaque-token'
        });
      });
      const result = await new GoogleAdapter('gk-test', model).generateUncached('hi');
      expect(result.text).toBe('Partial answer');
      expect(result.finishReason).toBe('length');
      expect(result.metadata).toMatchObject({ continuationRequired: true });
      expect(calls).toBe(1);
    });

    it('throws a clear error for a streaming CONTINUATION instead of completing normally', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { candidates: [{ content: { parts: [{ text: 'Partial answer' }] } }] },
        { candidates: [{ finishReason: 'CONTINUATION' }], continuationToken: 'opaque-token' }
      )));
      await expect(collect(new GoogleAdapter('gk-test', model).generateStreamAsync('hi')))
        .rejects.toThrow(/incomplete.*continuation/i);
    });

    it('keeps buffered thinking choices distinct in the response cache', async () => {
      const efforts: unknown[] = [];
      __setRequestUrlMock(async request => {
        efforts.push(JSON.parse(request.body ?? '{}').generationConfig.thinkingConfig?.thinkingLevel);
        return jsonResponse(200, completed);
      });
      const adapter = new GoogleAdapter('gk-test', model);
      await adapter.clearCache();
      await adapter.generate('cached Argon prompt', { enableThinking: true, thinkingEffort: 'low' });
      await adapter.generate('cached Argon prompt', { enableThinking: true, thinkingEffort: 'high' });
      await adapter.generate('cached Argon prompt', { enableThinking: true, thinkingEffort: 'high' });
      expect(efforts).toEqual(['low', 'high']);
      await adapter.clearCache();
    });

    it('lists the verified standard model without changing the provider default', async () => {
      const adapter = new GoogleAdapter('gk-test');
      expect(await adapter.listModels()).toContainEqual(expect.objectContaining({
        id: model, name: 'Gemini 4 Argon', contextWindow: 1048576, maxOutputTokens: 32768,
        supportsThinking: true, supportsFunctions: true, supportsStreaming: true
      }));
      expect(await adapter.getModelPricing(model)).toMatchObject({
        rateInputPerMillion: 2, rateOutputPerMillion: 10, rateCacheReadPerMillion: 0.1
      });
      expect(GOOGLE_DEFAULT_MODEL).toBe('gemini-3.1-pro-preview');
    });
  });
});
