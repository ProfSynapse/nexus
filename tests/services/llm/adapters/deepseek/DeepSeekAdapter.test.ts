/**
 * DeepSeekAdapter Unit Tests
 *
 * Covers:
 *   - Streaming reasoning_content surfacing onto StreamChunk.reasoning
 *   - Non-streaming reasoning_content surfacing onto LLMResponse.metadata.reasoning
 *   - Thinking-mode request body (thinking: { type, reasoning_effort })
 *   - frequency_penalty / presence_penalty are NOT forwarded
 *   - -thinking model id triggers thinking even when options.thinking is unset
 */

import { DeepSeekAdapter } from '../../../../../src/services/llm/adapters/deepseek/DeepSeekAdapter';
import type { GenerateOptions, StreamChunk } from '../../../../../src/services/llm/adapters/types';
import { ThinkingEffortMapper } from '../../../../../src/services/llm/utils/ThinkingEffortMapper';

type AdapterPrototype = {
  // We override these on the instance via casting; they exist on BaseAdapter.
  requestStream: (config: { url: string; body?: string; headers?: Record<string, string>; method?: string }) => Promise<AsyncIterable<string>>;
  request: <T>(config: { url: string; body?: string; headers?: Record<string, string> }) => Promise<{ status: number; ok: boolean; json: T; text: string; headers: Record<string, string>; arrayBuffer: ArrayBuffer }>;
  assertOk: (response: unknown) => unknown;
};

/**
 * Build an async iterable that yields each provided string as a separate
 * "chunk" from the underlying Node stream. The SSE parser inside
 * processNodeStream will reassemble events from these.
 */
function makeSseStream(events: string[]): AsyncIterable<string> {
  const sseText = events.map(e => `data: ${e}\n\n`).join('') + 'data: [DONE]\n\n';
  return {
    async *[Symbol.asyncIterator]() {
      yield sseText;
    }
  };
}

async function collectStream(gen: AsyncGenerator<StreamChunk, void, unknown>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of gen) {
    out.push(chunk);
  }
  return out;
}

describe('DeepSeekAdapter', () => {
  let adapter: DeepSeekAdapter;
  let capturedRequests: Array<{ url: string; body: unknown; headers?: Record<string, string> }>;

  beforeEach(() => {
    adapter = new DeepSeekAdapter('sk-test-key');
    capturedRequests = [];
  });

  describe('streaming', () => {
    it('extracts delta.content into StreamChunk.content', async () => {
      const events = [
        JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
        JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
      ];

      (adapter as unknown as AdapterPrototype).requestStream = async (config) => {
        capturedRequests.push({ url: config.url, body: JSON.parse(config.body || '{}') as unknown });
        return makeSseStream(events);
      };

      const chunks = await collectStream(adapter.generateStreamAsync('hi'));
      const text = chunks.map(c => c.content).join('');
      expect(text).toContain('Hello world');

      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.usage?.totalTokens).toBe(7);
    });

    it('extracts delta.reasoning_content into StreamChunk.reasoning', async () => {
      const events = [
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'Let me think' } }] }),
        JSON.stringify({ choices: [{ delta: { reasoning_content: ' about this.' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Answer.' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      ];

      (adapter as unknown as AdapterPrototype).requestStream = async () => makeSseStream(events);

      const chunks = await collectStream(adapter.generateStreamAsync('hi'));
      const reasoningChunks = chunks.filter(c => c.reasoning);
      const reasoningText = reasoningChunks.map(c => c.reasoning).join('');
      expect(reasoningText).toBe('Let me think about this.');

      const contentChunks = chunks.filter(c => c.content && !c.complete);
      expect(contentChunks.map(c => c.content).join('')).toBe('Answer.');
    });

    it('does NOT yield reasoning chunks when reasoning_content is absent', async () => {
      const events = [
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      ];
      (adapter as unknown as AdapterPrototype).requestStream = async () => makeSseStream(events);

      const chunks = await collectStream(adapter.generateStreamAsync('hi'));
      expect(chunks.every(c => !c.reasoning)).toBe(true);
    });
  });

  describe('non-streaming', () => {
    it('surfaces message.reasoning_content on LLMResponse.metadata.reasoning', async () => {
      (adapter as unknown as AdapterPrototype).request = (async () => ({
        ok: true,
        status: 200,
        json: {
          choices: [{
            message: {
              content: 'Final answer.',
              reasoning_content: 'Working through the problem...'
            },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        },
        text: '',
        headers: {},
        arrayBuffer: new ArrayBuffer(0)
      })) as AdapterPrototype['request'];
      (adapter as unknown as AdapterPrototype).assertOk = (r: unknown) => r;

      const response = await adapter.generateUncached('test');
      expect(response.text).toBe('Final answer.');
      expect(response.metadata?.reasoning).toBe('Working through the problem...');
    });

    it('omits metadata.reasoning when reasoning_content is missing', async () => {
      (adapter as unknown as AdapterPrototype).request = (async () => ({
        ok: true,
        status: 200,
        json: {
          choices: [{ message: { content: 'plain answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        },
        text: '',
        headers: {},
        arrayBuffer: new ArrayBuffer(0)
      })) as AdapterPrototype['request'];
      (adapter as unknown as AdapterPrototype).assertOk = (r: unknown) => r;

      const response = await adapter.generateUncached('test');
      expect(response.metadata?.reasoning).toBeUndefined();
    });
  });

  describe('thinking-mode request body', () => {
    async function captureRequestBody(options: GenerateOptions): Promise<Record<string, unknown>> {
      let captured: Record<string, unknown> = {};
      (adapter as unknown as AdapterPrototype).requestStream = async (config) => {
        captured = JSON.parse(config.body || '{}') as Record<string, unknown>;
        return makeSseStream([
          JSON.stringify({ choices: [{ delta: { content: 'x' } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
        ]);
      };
      // Drain the stream so requestStream actually fires.
      for await (const _ of adapter.generateStreamAsync('hi', options)) { /* drain */ }
      return captured;
    }

    it('includes thinking param when options.enableThinking is true', async () => {
      const body = await captureRequestBody({ enableThinking: true, thinkingEffort: 'medium' });
      expect(body.thinking).toEqual({ type: 'enabled', reasoning_effort: 'high' });
    });

    it('maps thinkingEffort=high to reasoning_effort=max', async () => {
      const body = await captureRequestBody({ enableThinking: true, thinkingEffort: 'high' });
      expect(body.thinking).toEqual({ type: 'enabled', reasoning_effort: 'max' });
    });

    it('maps thinkingEffort=low to reasoning_effort=high (entry tier)', async () => {
      const body = await captureRequestBody({ enableThinking: true, thinkingEffort: 'low' });
      expect(body.thinking).toEqual({ type: 'enabled', reasoning_effort: 'high' });
    });

    it('omits thinking param when options.enableThinking is false', async () => {
      const body = await captureRequestBody({ enableThinking: false });
      expect(body.thinking).toBeUndefined();
    });

    it('triggers thinking when model id ends in -thinking even without enableThinking', async () => {
      const body = await captureRequestBody({ model: 'deepseek-v4-pro-thinking' });
      expect(body.thinking).toEqual({ type: 'enabled', reasoning_effort: 'high' });
      // And the wire model id should be the base, suffix stripped.
      expect(body.model).toBe('deepseek-v4-pro');
    });
  });

  describe('penalty stripping', () => {
    it('does NOT include frequency_penalty or presence_penalty in the request body', async () => {
      let captured: Record<string, unknown> = {};
      (adapter as unknown as AdapterPrototype).requestStream = async (config) => {
        captured = JSON.parse(config.body || '{}') as Record<string, unknown>;
        return makeSseStream([
          JSON.stringify({ choices: [{ delta: { content: 'x' } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
        ]);
      };

      for await (const _ of adapter.generateStreamAsync('hi', {
        frequencyPenalty: 0.5,
        presencePenalty: 0.5,
        temperature: 0.7
      })) { /* drain */ }

      expect(captured.frequency_penalty).toBeUndefined();
      expect(captured.presence_penalty).toBeUndefined();
      // Sanity: temperature still threads through.
      expect(captured.temperature).toBe(0.7);
    });
  });

  describe('ThinkingEffortMapper integration', () => {
    it('getDeepSeekParams returns null when disabled', () => {
      expect(ThinkingEffortMapper.getDeepSeekParams({ enabled: false, effort: 'medium' })).toBeNull();
    });

    it('getDeepSeekParams maps high -> max, low/medium -> high', () => {
      expect(ThinkingEffortMapper.getDeepSeekParams({ enabled: true, effort: 'high' }))
        .toEqual({ thinking: { type: 'enabled', reasoning_effort: 'max' } });
      expect(ThinkingEffortMapper.getDeepSeekParams({ enabled: true, effort: 'medium' }))
        .toEqual({ thinking: { type: 'enabled', reasoning_effort: 'high' } });
      expect(ThinkingEffortMapper.getDeepSeekParams({ enabled: true, effort: 'low' }))
        .toEqual({ thinking: { type: 'enabled', reasoning_effort: 'high' } });
    });

    it('getProviderConfig handles deepseek case', () => {
      const config = ThinkingEffortMapper.getProviderConfig('deepseek', { enabled: true, effort: 'high' });
      expect(config?.deepseek).toEqual({ thinking: { type: 'enabled', reasoning_effort: 'max' } });
    });

    it('providerSupportsThinking returns true for deepseek', () => {
      expect(ThinkingEffortMapper.providerSupportsThinking('deepseek')).toBe(true);
    });
  });

  describe('capabilities and listModels', () => {
    it('reports thinking + 1M context', () => {
      const caps = adapter.getCapabilities();
      expect(caps.supportsThinking).toBe(true);
      expect(caps.maxContextWindow).toBe(1_000_000);
      expect(caps.supportsImages).toBe(false);
      expect(caps.supportsFunctions).toBe(true);
    });

    it('lists 4 model entries (flash, flash-thinking, pro, pro-thinking)', async () => {
      const models = await adapter.listModels();
      expect(models.map(m => m.id).sort()).toEqual([
        'deepseek-v4-flash',
        'deepseek-v4-flash-thinking',
        'deepseek-v4-pro',
        'deepseek-v4-pro-thinking'
      ]);
    });

    it('returns pricing for each model', async () => {
      const flash = await adapter.getModelPricing('deepseek-v4-flash');
      expect(flash?.rateInputPerMillion).toBe(0.14);
      expect(flash?.rateOutputPerMillion).toBe(0.28);

      const pro = await adapter.getModelPricing('deepseek-v4-pro');
      expect(pro?.rateInputPerMillion).toBe(0.435);
      expect(pro?.rateOutputPerMillion).toBe(0.87);

      const unknown = await adapter.getModelPricing('does-not-exist');
      expect(unknown).toBeNull();
    });
  });
});
