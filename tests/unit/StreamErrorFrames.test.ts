/**
 * Provider error frames delivered over HTTP 200 (issue #336).
 *
 * A provider can answer a streaming request with 200 and then push
 * `{"error": {...}}` instead of content. Before this was handled, every
 * processor simply reached the end of the stream and returned normally: blank
 * chat bubble, nothing logged. These tests pin the opposite behaviour on every
 * processor in the streaming layer -- the frame must surface as a thrown
 * LLMProviderError carrying PROVIDER_STREAM_ERROR, and no chunk may claim the
 * stream completed successfully.
 *
 * No network: streams are hand-built strings / async iterables.
 */
import { SSEStreamProcessor } from '../../src/services/llm/streaming/SSEStreamProcessor';
import { BufferedSSEStreamProcessor } from '../../src/services/llm/streaming/BufferedSSEStreamProcessor';
import {
  PROVIDER_STREAM_ERROR_CODE,
  extractStreamErrorMessage,
  extractResponsesApiStreamError
} from '../../src/services/llm/streaming/streamErrorFrames';
import { BaseAdapter } from '../../src/services/llm/adapters/BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  LLMProviderError
} from '../../src/services/llm/adapters/types';
import { SSEStreamOptions } from '../../src/services/llm/streaming/SSEStreamProcessor';
import { collect, captureError } from './helpers/llmAdapterTestHarness';

/** OpenAI-compatible extractor options; only extractError varies per test. */
const openAiCompatOptions: SSEStreamOptions = {
  debugLabel: 'Test',
  extractContent: (parsed) => {
    const choices = (parsed as { choices?: Array<{ delta?: { content?: string } }> }).choices;
    return choices?.[0]?.delta?.content || null;
  },
  extractToolCalls: () => null,
  extractFinishReason: (parsed) => {
    const choices = (parsed as { choices?: Array<{ finish_reason?: string }> }).choices;
    return choices?.[0]?.finish_reason || null;
  },
  extractError: (parsed) => extractStreamErrorMessage(parsed, 'Test streaming error')
};

function sseText(...frames: unknown[]): string {
  return frames
    .map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
    .join('');
}

/** A Response whose body streams `text` in one read, as processSSEStream expects. */
function responseFromText(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let delivered = false;
  return {
    body: {
      getReader: () => ({
        read: () => Promise.resolve(
          delivered
            ? { done: true, value: undefined }
            : ((delivered = true), { done: false, value: bytes })
        ),
        cancel: () => Promise.resolve()
      })
    }
  } as unknown as Response;
}

/** A Node-style readable that yields `text` in one chunk. */
function nodeStreamFromText(text: string): NodeJS.ReadableStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield text;
    }
  } as unknown as NodeJS.ReadableStream;
}

/** Minimal concrete adapter so the protected processors can be exercised directly. */
class TestAdapter extends BaseAdapter {
  readonly name = 'test-provider';
  readonly baseUrl = 'https://example.invalid';

  constructor() {
    super('key', 'test-model');
    this.initializeCache();
  }

  generateUncached(): Promise<LLMResponse> {
    throw new Error('not used');
  }

  // eslint-disable-next-line require-yield
  async *generateStreamAsync(_prompt: string, _options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    throw new Error('not used');
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: false,
      supportsImages: false,
      supportsFunctions: false,
      supportsThinking: false,
      maxContextWindow: 1000,
      supportedFeatures: []
    };
  }

  getModelPricing(): Promise<ModelPricing | null> {
    return Promise.resolve(null);
  }

  runNodeStream(text: string, options: SSEStreamOptions): AsyncGenerator<StreamChunk, void, unknown> {
    return this.processNodeStream(nodeStreamFromText(text), options);
  }

  runBufferedSSEText(text: string, options: SSEStreamOptions): AsyncGenerator<StreamChunk, void, unknown> {
    return this.processBufferedSSEText(text, options);
  }

  runSSEResponse(text: string, options: SSEStreamOptions): AsyncGenerator<StreamChunk, void, unknown> {
    return this.processSSEStream(responseFromText(text), options);
  }

  runNdjson(lines: string): AsyncGenerator<StreamChunk, void, unknown> {
    return this.processNodeStreamJsonLines(nodeStreamFromText(lines), {
      extractChunk: (parsed) => {
        const content = (parsed as { content?: string }).content;
        return content ? { content, complete: false } : null;
      },
      extractDone: (parsed) => !!(parsed as { done?: boolean }).done,
      extractError: (parsed) => extractStreamErrorMessage(parsed, 'Test streaming error')
    });
  }

  runSdkStream(chunks: unknown[]): AsyncGenerator<StreamChunk, void, unknown> {
    async function* iterate(): AsyncIterable<unknown> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    return this.processStream(iterate() as AsyncIterable<unknown>, {
      extractContent: (chunk) => {
        const choices = (chunk as { choices?: Array<{ delta?: { content?: string } }> }).choices;
        return choices?.[0]?.delta?.content || null;
      },
      extractToolCalls: () => null,
      extractFinishReason: () => null,
      extractError: (chunk) => extractStreamErrorMessage(chunk, 'Test streaming error')
    });
  }
}

const ERROR_FRAME = { error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 429 } };

describe('extractStreamErrorMessage', () => {
  it('reads the message out of a top-level error object', () => {
    expect(extractStreamErrorMessage(ERROR_FRAME)).toBe('Rate limit exceeded');
  });

  it('accepts a plain-string error member', () => {
    expect(extractStreamErrorMessage({ error: 'model not found' })).toBe('model not found');
  });

  it("recognises Mistral's {object: 'error'} body shape", () => {
    expect(extractStreamErrorMessage({ object: 'error', message: 'Service unavailable' }))
      .toBe('Service unavailable');
  });

  it('falls back to type/code when the frame carries no message', () => {
    expect(extractStreamErrorMessage({ error: { type: 'overloaded_error' } }, 'boom'))
      .toBe('boom: overloaded_error');
    expect(extractStreamErrorMessage({ error: { code: 503 } }, 'boom')).toBe('boom: 503');
    expect(extractStreamErrorMessage({ error: true }, 'boom')).toBe('boom');
  });

  it('never fires on an ordinary content frame', () => {
    expect(extractStreamErrorMessage({ choices: [{ delta: { content: 'hi' } }] })).toBeNull();
    expect(extractStreamErrorMessage({ error: null })).toBeNull();
    expect(extractStreamErrorMessage({ choices: [], error: undefined })).toBeNull();
    expect(extractStreamErrorMessage('not an object')).toBeNull();
    expect(extractStreamErrorMessage(null)).toBeNull();
  });
});

describe('extractResponsesApiStreamError', () => {
  it('reads a stream-level error event', () => {
    expect(extractResponsesApiStreamError({ type: 'error', code: 'server_error', message: 'Boom' }))
      .toBe('Boom');
  });

  it('reads response.failed', () => {
    expect(extractResponsesApiStreamError({
      type: 'response.failed',
      response: { id: 'resp_1', error: { message: 'The model produced an invalid response' } }
    })).toBe('The model produced an invalid response');
  });

  it('leaves ordinary Responses events and truncation alone', () => {
    expect(extractResponsesApiStreamError({ type: 'response.output_text.delta', delta: 'hi' })).toBeNull();
    expect(extractResponsesApiStreamError({
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' } }
    })).toBeNull();
  });
});

describe.each([
  ['processNodeStream', (adapter: TestAdapter, text: string, options: SSEStreamOptions) => adapter.runNodeStream(text, options)],
  ['processBufferedSSEText', (adapter: TestAdapter, text: string, options: SSEStreamOptions) => adapter.runBufferedSSEText(text, options)],
  ['processSSEStream', (adapter: TestAdapter, text: string, options: SSEStreamOptions) => adapter.runSSEResponse(text, options)]
])('%s honours extractError', (_name, run) => {
  it('throws a provider stream error instead of ending an empty stream', async () => {
    const adapter = new TestAdapter();
    const error = await captureError(
      collect(run(adapter, sseText(ERROR_FRAME), openAiCompatOptions))
    ) as LLMProviderError;

    expect(error).toBeInstanceOf(LLMProviderError);
    expect(error.code).toBe(PROVIDER_STREAM_ERROR_CODE);
    expect(error.message).toBe('Rate limit exceeded');
    expect(error.provider).toBe('test-provider');
  });

  it('does not emit a successful completion chunk before throwing', async () => {
    const adapter = new TestAdapter();
    const seen: StreamChunk[] = [];
    const stream = run(adapter, sseText({ choices: [{ delta: { content: 'partial' } }] }, ERROR_FRAME), openAiCompatOptions);

    await expect((async () => {
      for await (const chunk of stream) {
        seen.push(chunk);
      }
    })()).rejects.toThrow('Rate limit exceeded');

    expect(seen.map(chunk => chunk.content).join('')).toBe('partial');
    expect(seen.some(chunk => chunk.complete)).toBe(false);
  });

  it('still completes normally when no error frame arrives', async () => {
    const adapter = new TestAdapter();
    const chunks = await collect(run(
      adapter,
      sseText({ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ finish_reason: 'stop' }] }, '[DONE]'),
      openAiCompatOptions
    ));

    expect(chunks.map(chunk => chunk.content).join('')).toBe('ok');
    expect(chunks[chunks.length - 1].complete).toBe(true);
  });

  it('is inert when the adapter supplies no extractError (unchanged legacy behaviour)', async () => {
    const adapter = new TestAdapter();
    const { extractError: _omitted, ...withoutExtractor } = openAiCompatOptions;
    const chunks = await collect(run(adapter, sseText(ERROR_FRAME), withoutExtractor));

    expect(chunks.every(chunk => !chunk.content)).toBe(true);
  });
});

describe('processNodeStreamJsonLines honours extractError', () => {
  it('throws on an NDJSON error line delivered over HTTP 200', async () => {
    const adapter = new TestAdapter();
    const error = await captureError(
      collect(adapter.runNdjson(`${JSON.stringify({ error: "model 'x' not found" })}\n`))
    ) as LLMProviderError;

    expect(error).toBeInstanceOf(LLMProviderError);
    expect(error.code).toBe(PROVIDER_STREAM_ERROR_CODE);
    expect(error.message).toBe("model 'x' not found");
  });

  it('does not emit a completion chunk when the stream errored', async () => {
    const adapter = new TestAdapter();
    const seen: StreamChunk[] = [];
    const stream = adapter.runNdjson(
      `${JSON.stringify({ content: 'partial' })}\n${JSON.stringify({ error: 'boom' })}\n`
    );

    await expect((async () => {
      for await (const chunk of stream) {
        seen.push(chunk);
      }
    })()).rejects.toThrow('boom');

    expect(seen.some(chunk => chunk.complete)).toBe(false);
  });

  it('completes normally without an error line', async () => {
    const adapter = new TestAdapter();
    const chunks = await collect(adapter.runNdjson(
      `${JSON.stringify({ content: 'hi' })}\n${JSON.stringify({ done: true })}\n`
    ));

    expect(chunks[chunks.length - 1].complete).toBe(true);
  });
});

describe('processStream honours extractError on the iterable branch', () => {
  it('throws when a chunk carries an error object', async () => {
    const adapter = new TestAdapter();
    const error = await captureError(collect(adapter.runSdkStream([
      { choices: [{ delta: { content: 'partial' } }] },
      ERROR_FRAME
    ]))) as LLMProviderError;

    expect(error).toBeInstanceOf(LLMProviderError);
    expect(error.code).toBe(PROVIDER_STREAM_ERROR_CODE);
    expect(error.message).toBe('Rate limit exceeded');
  });

  it('completes normally when every chunk is ordinary', async () => {
    const adapter = new TestAdapter();
    const chunks = await collect(adapter.runSdkStream([{ choices: [{ delta: { content: 'hi' } }] }]));

    expect(chunks.map(chunk => chunk.content).join('')).toBe('hi');
    expect(chunks[chunks.length - 1].complete).toBe(true);
  });
});

describe('the standalone processors name the provider from their options', () => {
  it('falls back to debugLabel when no providerName is supplied', async () => {
    const error = await captureError(collect(
      BufferedSSEStreamProcessor.processSSEText(sseText(ERROR_FRAME), openAiCompatOptions)
    )) as LLMProviderError;

    expect(error.provider).toBe('Test');
  });

  it('applies to processSSEStream as well', async () => {
    const error = await captureError(collect(
      SSEStreamProcessor.processSSEStream(responseFromText(sseText(ERROR_FRAME)), {
        ...openAiCompatOptions,
        providerName: 'explicit-provider'
      })
    )) as LLMProviderError;

    expect(error.provider).toBe('explicit-provider');
  });
});
