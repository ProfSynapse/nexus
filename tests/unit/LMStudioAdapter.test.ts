/**
 * LMStudioAdapter reasoning/thinking characterization tests.
 *
 * LM Studio's OpenAI-compatible API exposes reasoning-model thinking in a dedicated
 * `reasoning_content` field (delta when streaming, message when not) — the same shape
 * as DeepSeek. These tests pin that the adapter routes it to the shared reasoning
 * channel (StreamChunk.reasoning / metadata.reasoning) and keeps content clean.
 *
 * Mocks at the requestUrl seam and forces ProviderHttpClient.requestStream onto its
 * buffered requestUrl fallback by mocking hasNodeRuntime to false.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { LMStudioAdapter } from '../../src/services/llm/adapters/lmstudio/LMStudioAdapter';
import {
  jsonResponse,
  sseResponse,
  sse,
  collect,
  concatContent,
  CapturedRequest,
} from './helpers/llmAdapterTestHarness';

const URL = 'http://127.0.0.1:1234';

/**
 * Route the requestUrl mock by endpoint so ensureModelLoaded's GET /api/v1/models +
 * POST /api/v1/models/load + the chat completion all resolve. `loadedContext` controls
 * what the model's live loaded config reports (null = not loaded).
 */
function routeLoadMock(modelKey: string, loadedContext: number | null, loadedParallel?: number): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  __setRequestUrlMock(async (req) => {
    requests.push(req);
    if (req.url.endsWith('/api/v1/models')) {
      return jsonResponse(200, {
        models: [{
          key: modelKey,
          loaded_instances: loadedContext == null
            ? []
            : [{ config: { context_length: loadedContext, ...(loadedParallel !== undefined ? { parallel: loadedParallel } : {}) } }]
        }]
      });
    }
    if (req.url.endsWith('/api/v1/models/load')) {
      return jsonResponse(200, {});
    }
    return jsonResponse(200, {
      id: '1', model: modelKey,
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    });
  });
  return requests;
}

const loadCalls = (reqs: CapturedRequest[]) => reqs.filter(r => r.url.endsWith('/api/v1/models/load')).length;

describe('LMStudioAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('reasoning (non-streaming)', () => {
    it('surfaces message.reasoning_content as metadata.reasoning with clean content', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, {
        id: 'cmpl-1',
        model: 'qwen3-4b-thinking',
        choices: [{
          message: { content: 'four', reasoning_content: '2 plus 2 is 4' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 }
      }));

      const adapter = new LMStudioAdapter(URL);
      const result = await adapter.generateUncached('what is 2+2');

      expect(result.text).toBe('four');
      expect(result.metadata?.reasoning).toBe('2 plus 2 is 4');
    });
  });

  describe('reasoning (SSE streaming)', () => {
    it('yields reasoning_content deltas as reasoning and content deltas as text', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { choices: [{ delta: { reasoning_content: 'Okay,' } }] },
        { choices: [{ delta: { reasoning_content: ' the user' } }] },
        { choices: [{ delta: { content: 'Hi' } }] },
        { choices: [{ delta: { content: ' there' } }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
        },
        '[DONE]'
      )));

      const adapter = new LMStudioAdapter(URL);
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      const reasoning = chunks.filter(c => c.reasoning).map(c => c.reasoning).join('');
      expect(reasoning).toBe('Okay, the user');
      expect(concatContent(chunks)).toBe('Hi there');

      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
    });
  });

  describe('draft-model in-stream error fallback', () => {
    it('drops the draft and retries when LM Studio returns a fatal error frame over a 200 stream', async () => {
      // The real failure mode (esp. batched MLX): HTTP 200, then an {"error":{...}} SSE frame
      // and zero content. Without handling, the stream ends silently empty (blank bubble).
      const bodies: string[] = [];
      __setRequestUrlMock(async (req) => {
        bodies.push(req.body ?? '');
        if ((req.body ?? '').includes('"draft_model"')) {
          return sseResponse(sse(
            { error: { message: 'Failed to load draft model. SpeculativeDecodingNotSupportedError: Speculative decoding is not supported for batched MLX models.' } }
          ));
        }
        return sseResponse(sse(
          { choices: [{ delta: { content: 'Hello' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
          '[DONE]'
        ));
      });

      // No contextLength → ensureModelLoaded is a no-op, so the only calls are the chat streams.
      const adapter = new LMStudioAdapter(URL, { draftModel: 'qwen3-0.6b' });
      const chunks = await collect(adapter.generateStreamAsync('hi', { model: 'qwen3-thinking' }));

      // The retry (no draft) produced real output instead of a silent empty stream.
      expect(concatContent(chunks)).toBe('Hello');
      expect(bodies.some(b => b.includes('"draft_model"'))).toBe(true);
      expect(bodies.some(b => !b.includes('"draft_model"'))).toBe(true);
    });
  });

  describe('ensureModelLoaded (reload guard)', () => {
    it('does not reload when the model is already loaded at the configured context (no draft)', async () => {
      const reqs = routeLoadMock('m-noreload', 16384);
      const adapter = new LMStudioAdapter(URL, { contextLength: 16384 });
      await adapter.generateUncached('hi', { model: 'm-noreload' });
      expect(loadCalls(reqs)).toBe(0);
    });

    it('reloads when the loaded context differs from the configured one', async () => {
      const reqs = routeLoadMock('m-ctxchange', 8192); // loaded at 8K, want 16K
      const adapter = new LMStudioAdapter(URL, { contextLength: 16384 });
      await adapter.generateUncached('hi', { model: 'm-ctxchange' });
      expect(loadCalls(reqs)).toBe(1);
    });

    it('does not reload a draft-configured model already loaded NON-batched (parallel:1) at the right context', async () => {
      // Speculative decoding needs a non-batched instance; one already exists → skip.
      const reqs = routeLoadMock('m-draft', 16384, 1);
      const adapter = new LMStudioAdapter(URL, { contextLength: 16384, draftModel: 'd' });
      await adapter.generateUncached('hi', { model: 'm-draft' });
      expect(loadCalls(reqs)).toBe(0);
    });

    it('reloads a draft-configured model when the loaded instance is BATCHED, sending parallel:1', async () => {
      // Loaded batched (parallel:4) → speculative decoding can't attach → reload non-batched.
      const reqs = routeLoadMock('m-batched', 16384, 4);
      const adapter = new LMStudioAdapter(URL, { contextLength: 16384, draftModel: 'd' });
      await adapter.generateUncached('hi', { model: 'm-batched' });
      expect(loadCalls(reqs)).toBe(1);
      const loadBody = JSON.parse(reqs.find(r => r.url.endsWith('/api/v1/models/load'))!.body ?? '{}');
      expect(loadBody.parallel).toBe(1);
      expect(loadBody.context_length).toBe(16384);
    });

    it('does not send parallel for a no-draft load', async () => {
      const reqs = routeLoadMock('m-plain', 8192); // loaded at 8K, want 16K → reload, no draft
      const adapter = new LMStudioAdapter(URL, { contextLength: 16384 });
      await adapter.generateUncached('hi', { model: 'm-plain' });
      expect(loadCalls(reqs)).toBe(1);
      const loadBody = JSON.parse(reqs.find(r => r.url.endsWith('/api/v1/models/load'))!.body ?? '{}');
      expect(loadBody.parallel).toBeUndefined();
    });

    it('does not reload across an adapter rebuild when the live state already matches', async () => {
      // The live GET is self-sufficient: a rebuilt adapter (e.g. after a settings save) sees
      // the model already loaded at the right context and skips — no cross-instance state.
      const reqs1 = routeLoadMock('m-rebuild', 16384);
      const a1 = new LMStudioAdapter(URL, { contextLength: 16384 });
      await a1.generateUncached('hi', { model: 'm-rebuild' });
      expect(loadCalls(reqs1)).toBe(0);

      const reqs2 = routeLoadMock('m-rebuild', 16384);
      const a2 = new LMStudioAdapter(URL, { contextLength: 16384 });
      await a2.generateUncached('hi', { model: 'm-rebuild' });
      expect(loadCalls(reqs2)).toBe(0);
    });
  });

  describe('thinking capability detection', () => {
    it('flags reasoning models and not plain ones', () => {
      expect(LMStudioAdapter.detectThinkingSupport('qwen3-8b-mlx')).toBe(true);
      expect(LMStudioAdapter.detectThinkingSupport('deepseek-r1-distill')).toBe(true);
      expect(LMStudioAdapter.detectThinkingSupport('llama-3.1-8b')).toBe(false);
      expect(LMStudioAdapter.detectThinkingSupport('gemma-2-9b')).toBe(false);
    });
  });
});
