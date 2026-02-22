/**
 * OpenAICodexAdapter Unit Tests
 *
 * Tests the LLM adapter for the Codex inference endpoint:
 * - Token management (fresh check, proactive refresh)
 * - Request construction (headers, body format)
 * - SSE stream parsing
 * - Error handling
 * - Token status diagnostics
 */

import { OpenAICodexAdapter, CodexOAuthTokens, TokenPersistCallback } from '../../src/services/llm/adapters/openai-codex/OpenAICodexAdapter';
import { EventEmitter } from 'events';

// --- https mock infrastructure ---

/**
 * Create a mock IncomingMessage (EventEmitter + async iterable of Buffers).
 * Simulates a Node.js http.IncomingMessage for SSE streaming.
 */
function createMockIncomingMessage(
  statusCode: number,
  chunks: string[]
): { message: any; emit: () => void } {
  const emitter = new EventEmitter();
  (emitter as any).statusCode = statusCode;

  // Make it async-iterable (Node.js IncomingMessage supports this)
  (emitter as any)[Symbol.asyncIterator] = async function* () {
    for (const chunk of chunks) {
      yield Buffer.from(chunk);
    }
  };

  const emitFn = () => {
    // Defer emission so the consumer has time to register event listeners.
    // The adapter sets up on('data')/on('end') after the Promise resolves,
    // which happens in the same microtask as callback(message). Using
    // setTimeout(0) pushes emission to the next macrotask.
    setTimeout(() => {
      for (const chunk of chunks) {
        emitter.emit('data', Buffer.from(chunk));
      }
      emitter.emit('end');
    }, 0);
  };

  return { message: emitter, emit: emitFn };
}

// Track all https.request calls for assertions
interface CapturedRequest {
  options: any;
  body: string;
}

let capturedRequests: CapturedRequest[] = [];
let requestMockImpl: ((options: any, body: string) => { statusCode: number; chunks: string[] }) | null = null;

// Mock the https module
jest.mock('https', () => ({
  request: jest.fn((options: any, callback: (res: any) => void) => {
    const reqEmitter = new EventEmitter();
    let writtenBody = '';

    (reqEmitter as any).write = (data: string) => { writtenBody += data; };
    (reqEmitter as any).setTimeout = jest.fn(); // Mock ClientRequest.setTimeout
    (reqEmitter as any).destroy = jest.fn();    // Mock ClientRequest.destroy
    (reqEmitter as any).end = () => {
      capturedRequests.push({ options, body: writtenBody });

      if (requestMockImpl) {
        const { statusCode, chunks } = requestMockImpl(options, writtenBody);
        const { message, emit } = createMockIncomingMessage(statusCode, chunks);
        callback(message);
        // Emit data/end events for all responses — the adapter uses event
        // listeners (not async iteration) to read both SSE streams and error bodies
        emit();
      }
    };

    return reqEmitter;
  }),
}));

// Mock ModelRegistry
jest.mock('../../src/services/llm/adapters/ModelRegistry', () => ({
  ModelRegistry: {
    getProviderModels: jest.fn(() => [
      {
        provider: 'openai-codex',
        name: 'GPT-5.3 Codex',
        apiName: 'gpt-5.3-codex',
        contextWindow: 400000,
        maxTokens: 128000,
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
      },
    ]),
    toModelInfo: jest.fn((model) => ({
      id: model.apiName,
      name: model.name,
      provider: model.provider,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
    })),
  },
}));

// Mock branding
jest.mock('../../../../src/constants/branding', () => ({
  BRAND_NAME: 'TestBrand',
}), { virtual: true });

// Helper: create valid tokens
function createTokens(overrides?: Partial<CodexOAuthTokens>): CodexOAuthTokens {
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3600_000, // 1 hour from now
    accountId: 'acct-test-123',
    ...overrides,
  };
}

// Helper: set up a mock for the Codex API endpoint returning SSE events
function mockCodexSSE(events: string[]) {
  const sseText = events.join('');
  requestMockImpl = (options) => {
    if (options.path === '/oauth/token') {
      // Should not reach here for non-refresh tests
      return { statusCode: 200, chunks: ['{}'] };
    }
    return { statusCode: 200, chunks: [sseText] };
  };
}

// Helper: set up a mock for error responses
function mockCodexError(statusCode: number, errorBody: string) {
  requestMockImpl = () => {
    return { statusCode, chunks: [errorBody] };
  };
}

describe('OpenAICodexAdapter', () => {
  let adapter: OpenAICodexAdapter;
  let tokens: CodexOAuthTokens;

  beforeEach(() => {
    tokens = createTokens();
    adapter = new OpenAICodexAdapter(tokens);
    capturedRequests = [];
    requestMockImpl = null;
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with provided tokens', () => {
      const status = adapter.getTokenStatus();
      expect(status.hasAccessToken).toBe(true);
      expect(status.hasRefreshToken).toBe(true);
      expect(status.hasAccountId).toBe(true);
      expect(status.isExpired).toBe(false);
    });

    it('should set adapter name to "openai-codex"', () => {
      expect(adapter.name).toBe('openai-codex');
    });
  });

  describe('isAvailable', () => {
    it('should return true when all required tokens are present', async () => {
      expect(await adapter.isAvailable()).toBe(true);
    });

    it('should return false when accessToken is empty', async () => {
      const emptyAdapter = new OpenAICodexAdapter(createTokens({ accessToken: '' }));
      expect(await emptyAdapter.isAvailable()).toBe(false);
    });

    it('should return false when refreshToken is empty', async () => {
      const emptyAdapter = new OpenAICodexAdapter(createTokens({ refreshToken: '' }));
      expect(await emptyAdapter.isAvailable()).toBe(false);
    });

    it('should return false when accountId is empty', async () => {
      const emptyAdapter = new OpenAICodexAdapter(createTokens({ accountId: '' }));
      expect(await emptyAdapter.isAvailable()).toBe(false);
    });
  });

  describe('getTokenStatus', () => {
    it('should report correct token status', () => {
      const status = adapter.getTokenStatus();
      expect(status.hasAccessToken).toBe(true);
      expect(status.hasRefreshToken).toBe(true);
      expect(status.hasAccountId).toBe(true);
      expect(status.isExpired).toBe(false);
      expect(status.needsRefresh).toBe(false);
    });

    it('should detect expired tokens', () => {
      const expiredAdapter = new OpenAICodexAdapter(
        createTokens({ expiresAt: Date.now() - 1000 })
      );
      const status = expiredAdapter.getTokenStatus();
      expect(status.isExpired).toBe(true);
      expect(status.needsRefresh).toBe(true);
    });

    it('should detect tokens needing refresh (within 5-minute threshold)', () => {
      const soonAdapter = new OpenAICodexAdapter(
        createTokens({ expiresAt: Date.now() + 60_000 }) // 1 minute from now
      );
      const status = soonAdapter.getTokenStatus();
      expect(status.isExpired).toBe(false);
      expect(status.needsRefresh).toBe(true);
    });
  });

  describe('updateTokens', () => {
    it('should update token state', () => {
      const newTokens = createTokens({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
        accountId: 'acct-new',
      });
      adapter.updateTokens(newTokens);

      const status = adapter.getTokenStatus();
      expect(status.hasAccessToken).toBe(true);
      expect(status.hasRefreshToken).toBe(true);
      expect(status.hasAccountId).toBe(true);
    });
  });

  describe('proactive token refresh', () => {
    it('should refresh token before API call when close to expiry', async () => {
      const nearExpiryTokens = createTokens({
        expiresAt: Date.now() + 60_000, // 1 minute (< 5 min threshold)
      });
      const onRefresh = jest.fn();
      const nearExpiryAdapter = new OpenAICodexAdapter(nearExpiryTokens, onRefresh);

      let refreshCalled = false;
      requestMockImpl = (options) => {
        if (options.path === '/oauth/token') {
          refreshCalled = true;
          return {
            statusCode: 200,
            chunks: [JSON.stringify({
              access_token: 'refreshed-at',
              refresh_token: 'rotated-rt',
              expires_in: 3600,
            })],
          };
        }
        // API call
        return {
          statusCode: 200,
          chunks: [
            'data: {"type":"response.output_text.delta","delta":{"text":"Hello"}}\n\n',
            'data: [DONE]\n\n',
          ],
        };
      };

      const chunks: string[] = [];
      for await (const chunk of nearExpiryAdapter.generateStreamAsync('test prompt')) {
        if (chunk.content) chunks.push(chunk.content);
      }

      // Refresh endpoint should have been called
      expect(refreshCalled).toBe(true);

      // Callback should have been invoked with refreshed tokens
      expect(onRefresh).toHaveBeenCalled();

      // Should have captured both refresh + API calls
      expect(capturedRequests.length).toBe(2);
      expect(capturedRequests[0].options.path).toBe('/oauth/token');
    });

    it('should not refresh token when far from expiry', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_text.delta","delta":{"text":"Hello"}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const chunks: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test prompt')) {
        if (chunk.content) chunks.push(chunk.content);
      }

      // Only the API call, no refresh call
      expect(capturedRequests.length).toBe(1);
      expect(capturedRequests[0].options.hostname).toBe('chatgpt.com');
    });
  });

  describe('generateStreamAsync request construction', () => {
    it('should send correct headers including Authorization and ChatGPT-Account-Id', async () => {
      mockCodexSSE(['data: [DONE]\n\n']);

      for await (const _ of adapter.generateStreamAsync('hello')) { /* no-op */ }

      const req = capturedRequests[0];
      expect(req.options.headers['Authorization']).toBe('Bearer test-access-token');
      expect(req.options.headers['ChatGPT-Account-Id']).toBe('acct-test-123');
      expect(req.options.headers['Content-Type']).toBe('application/json');
    });

    it('should construct correct request body', async () => {
      mockCodexSSE(['data: [DONE]\n\n']);

      for await (const _ of adapter.generateStreamAsync('hello', {
        model: 'gpt-5.2-codex',
        temperature: 0.7,
        maxTokens: 1000,
        systemPrompt: 'You are a helper.',
      })) { /* no-op */ }

      const body = JSON.parse(capturedRequests[0].body);
      expect(body.model).toBe('gpt-5.2-codex');
      expect(body.stream).toBe(true);
      expect(body.store).toBe(false);
      expect(body.temperature).toBe(0.7);
      expect(body.max_output_tokens).toBe(1000);
      expect(body.instructions).toBe('You are a helper.');
      expect(body.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'hello' }),
        ])
      );
    });

    it('should include system prompt in input array', async () => {
      mockCodexSSE(['data: [DONE]\n\n']);

      for await (const _ of adapter.generateStreamAsync('hello', {
        systemPrompt: 'System message',
      })) { /* no-op */ }

      const body = JSON.parse(capturedRequests[0].body);
      expect(body.input[0]).toEqual({ role: 'system', content: 'System message' });
      expect(body.input[1]).toEqual({ role: 'user', content: 'hello' });
    });

    it('should use conversation history when provided', async () => {
      mockCodexSSE(['data: [DONE]\n\n']);

      const history = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'Follow up' },
      ];

      for await (const _ of adapter.generateStreamAsync('follow up', {
        conversationHistory: history,
      })) { /* no-op */ }

      const body = JSON.parse(capturedRequests[0].body);
      expect(body.input).toEqual(history);
    });
  });

  describe('SSE stream parsing', () => {
    it('should extract text from delta.text events', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_text.delta","delta":{"text":"Hello "}}\n\n',
        'data: {"type":"response.output_text.delta","delta":{"text":"world!"}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['Hello ', 'world!']);
    });

    it('should extract text from delta as plain string (Shape 1a)', async () => {
      // The Codex Responses API can send delta as a plain string instead of
      // a nested object. This was the fix for the production text rendering bug.
      mockCodexSSE([
        'data: {"type":"response.output_text.delta","delta":"Plain string delta"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Second chunk"}\n\n',
        'data: [DONE]\n\n',
      ]);

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['Plain string delta', 'Second chunk']);
    });

    it('should extract text from top-level content field (Shape 3)', async () => {
      // Some Codex event variants place content at the top level
      mockCodexSSE([
        'data: {"type":"response.some_event","content":"top level content"}\n\n',
        'data: [DONE]\n\n',
      ]);

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['top level content']);
    });

    it('should handle delta.content variant', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_text.delta","delta":{"content":"content text"}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['content text']);
    });

    it('should skip output_text.done recap events', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_text.delta","delta":{"text":"Hello"}}\n\n',
        'data: {"type":"response.output_text.done","text":"Hello full text recap"}\n\n',
        'data: [DONE]\n\n',
      ]);

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      // Should only get delta, not the done recap
      expect(texts).toEqual(['Hello']);
    });

    it('should emit complete=true on [DONE]', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_text.delta","delta":{"text":"hi"}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const completeFlags: boolean[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        completeFlags.push(chunk.complete);
      }

      expect(completeFlags[completeFlags.length - 1]).toBe(true);
    });

    it('should emit complete=true on response.completed event', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_text.delta","delta":{"text":"hi"}}\n\n',
        'data: {"type":"response.completed","id":"resp-123"}\n\n',
      ]);

      const completeFlags: boolean[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        completeFlags.push(chunk.complete);
      }

      expect(completeFlags[completeFlags.length - 1]).toBe(true);
    });

    it('should handle malformed JSON lines gracefully (skip them)', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_text.delta","delta":{"text":"before"}}\n\n',
        'data: {malformed json\n\n',
        'data: {"type":"response.output_text.delta","delta":{"text":"after"}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['before', 'after']);
    });

    it('should handle SSE comments (lines starting with :)', async () => {
      mockCodexSSE([
        ': this is a comment\n\n',
        'data: {"type":"response.output_text.delta","delta":{"text":"text"}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['text']);
    });

    it('should handle empty lines gracefully', async () => {
      mockCodexSSE([
        '\n',
        'data: {"type":"response.output_text.delta","delta":{"text":"ok"}}\n\n',
        '\n',
        'data: [DONE]\n\n',
      ]);

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['ok']);
    });

    it('should correctly buffer and parse SSE data split across chunk boundaries', async () => {
      // Simulate a network scenario where a single SSE event arrives in two TCP chunks,
      // splitting mid-JSON. The async iterator yields two separate Buffer chunks.
      requestMockImpl = () => ({
        statusCode: 200,
        chunks: [
          'data: {"type":"response.output_text.delta","delta":{"tex',  // chunk 1: incomplete line
          't":"split across chunks"}}\n\ndata: [DONE]\n\n',           // chunk 2: rest of line + DONE
        ],
      });

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['split across chunks']);
    });
  });

  describe('HTTP error handling', () => {
    it('should throw AUTHENTICATION_ERROR on 401', async () => {
      mockCodexError(401, 'Unauthorized');

      await expect(async () => {
        for await (const _ of adapter.generateStreamAsync('test')) { /* no-op */ }
      }).rejects.toThrow('authentication failed');
    });

    it('should throw AUTHENTICATION_ERROR on 403', async () => {
      mockCodexError(403, 'Forbidden');

      await expect(async () => {
        for await (const _ of adapter.generateStreamAsync('test')) { /* no-op */ }
      }).rejects.toThrow('authentication failed');
    });

    it('should throw RATE_LIMIT_ERROR on 429', async () => {
      mockCodexError(429, 'Rate limit exceeded');

      try {
        for await (const _ of adapter.generateStreamAsync('test')) { /* no-op */ }
        fail('Expected error to be thrown');
      } catch (error: any) {
        expect(error.name).toBe('LLMProviderError');
        expect(error.code).toBe('RATE_LIMIT_ERROR');
        expect(error.provider).toBe('openai-codex');
        expect(error.message).toContain('rate limited');
        expect(error.message).toContain('429');
      }
    });

    it('should throw HTTP_ERROR on other status codes', async () => {
      mockCodexError(500, 'Internal Server Error');

      await expect(async () => {
        for await (const _ of adapter.generateStreamAsync('test')) { /* no-op */ }
      }).rejects.toThrow('Codex API error');
    });
  });

  describe('concurrent token refresh deduplication', () => {
    it('should make only one refresh call when two requests need refresh simultaneously', async () => {
      const nearExpiryTokens = createTokens({
        expiresAt: Date.now() + 60_000, // Within 5-min threshold
      });
      const onRefresh = jest.fn();
      const sharedAdapter = new OpenAICodexAdapter(nearExpiryTokens, onRefresh);

      let refreshCallCount = 0;
      requestMockImpl = (options) => {
        if (options.path === '/oauth/token') {
          refreshCallCount++;
          return {
            statusCode: 200,
            chunks: [JSON.stringify({
              access_token: 'refreshed-at',
              refresh_token: 'rotated-rt',
              expires_in: 3600,
            })],
          };
        }
        return {
          statusCode: 200,
          chunks: [
            'data: {"type":"response.output_text.delta","delta":{"text":"ok"}}\n\n',
            'data: [DONE]\n\n',
          ],
        };
      };

      // Fire two concurrent streaming requests
      const stream1 = (async () => {
        const texts: string[] = [];
        for await (const chunk of sharedAdapter.generateStreamAsync('prompt1')) {
          if (chunk.content) texts.push(chunk.content);
        }
        return texts;
      })();

      const stream2 = (async () => {
        const texts: string[] = [];
        for await (const chunk of sharedAdapter.generateStreamAsync('prompt2')) {
          if (chunk.content) texts.push(chunk.content);
        }
        return texts;
      })();

      const [result1, result2] = await Promise.all([stream1, stream2]);

      expect(result1).toEqual(['ok']);
      expect(result2).toEqual(['ok']);

      // Only 1 refresh call should be made (not 2)
      expect(refreshCallCount).toBe(1);
    });
  });

  describe('token refresh error handling', () => {
    it('should throw AUTHENTICATION_ERROR when token refresh fails', async () => {
      const nearExpiryAdapter = new OpenAICodexAdapter(
        createTokens({ expiresAt: Date.now() + 60_000 })
      );

      requestMockImpl = (options) => {
        if (options.path === '/oauth/token') {
          return { statusCode: 400, chunks: ['Invalid grant'] };
        }
        return { statusCode: 200, chunks: ['data: [DONE]\n\n'] };
      };

      await expect(async () => {
        for await (const _ of nearExpiryAdapter.generateStreamAsync('test')) { /* no-op */ }
      }).rejects.toThrow('Token refresh failed');
    });
  });

  describe('getCapabilities', () => {
    it('should report streaming support', () => {
      const caps = adapter.getCapabilities();
      expect(caps.supportsStreaming).toBe(true);
    });

    it('should report function calling support', () => {
      const caps = adapter.getCapabilities();
      expect(caps.supportsFunctions).toBe(true);
    });

    it('should include tool_calling in supported features', () => {
      const caps = adapter.getCapabilities();
      expect(caps.supportedFeatures).toContain('tool_calling');
    });

    it('should include oauth_required in supported features', () => {
      const caps = adapter.getCapabilities();
      expect(caps.supportedFeatures).toContain('oauth_required');
    });
  });

  describe('getModelPricing', () => {
    it('should return $0 pricing for known models', async () => {
      const pricing = await adapter.getModelPricing('gpt-5.3-codex');
      expect(pricing).not.toBeNull();
      expect(pricing!.rateInputPerMillion).toBe(0);
      expect(pricing!.rateOutputPerMillion).toBe(0);
    });

    it('should return null for unknown models', async () => {
      const pricing = await adapter.getModelPricing('unknown-model');
      expect(pricing).toBeNull();
    });
  });

  describe('listModels', () => {
    it('should return models from ModelRegistry', async () => {
      const models = await adapter.listModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models[0].id).toBe('gpt-5.3-codex');
    });
  });

  describe('tool call support', () => {
    it('should convert tools from Chat Completions format to Responses API format in request body', async () => {
      mockCodexSSE(['data: [DONE]\n\n']);

      const tools = [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ];

      for await (const _ of adapter.generateStreamAsync('What is the weather?', { tools })) { /* no-op */ }

      const body = JSON.parse(capturedRequests[0].body);
      expect(body.tools).toEqual([
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get current weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ]);

      // tool_choice must be 'auto' so the model actually selects tools
      expect(body.tool_choice).toBe('auto');

      // instructions should be prepended with tool preamble
      expect(body.instructions).toContain('tool access');
      expect(body.instructions).toContain('Call getTools first');
    });

    it('should pass through tools already in Responses API format', async () => {
      mockCodexSSE(['data: [DONE]\n\n']);

      const tools = [
        {
          type: 'function',
          name: 'search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ];

      for await (const _ of adapter.generateStreamAsync('Search for cats', { tools })) { /* no-op */ }

      const body = JSON.parse(capturedRequests[0].body);
      expect(body.tools[0].name).toBe('search');
    });

    it('should accumulate tool calls from response.output_item.done events', async () => {
      mockCodexSSE([
        'data: {"type":"response.function_call_arguments.delta","delta":"{\\"city\\":"}\n\n',
        'data: {"type":"response.function_call_arguments.delta","delta":"\\"NYC\\"}"}\n\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_abc","name":"get_weather","arguments":"{\\"city\\":\\"NYC\\"}"}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const chunks: Array<{ toolCalls?: any[]; toolCallsReady?: boolean }> = [];
      for await (const chunk of adapter.generateStreamAsync('weather in NYC')) {
        chunks.push({ toolCalls: chunk.toolCalls, toolCallsReady: chunk.toolCallsReady });
      }

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.toolCallsReady).toBe(true);
      expect(finalChunk.toolCalls).toHaveLength(1);
      expect(finalChunk.toolCalls![0]).toEqual({
        id: 'call_abc',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"city":"NYC"}',
        },
      });
    });

    it('should accumulate multiple tool calls', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\\"city\\":\\"NYC\\"}"}}\n\n',
        'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call_2","name":"get_time","arguments":"{\\"tz\\":\\"EST\\"}"}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const chunks: Array<{ toolCalls?: any[] }> = [];
      for await (const chunk of adapter.generateStreamAsync('weather and time')) {
        chunks.push({ toolCalls: chunk.toolCalls });
      }

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.toolCalls).toHaveLength(2);
      expect(finalChunk.toolCalls![0].function.name).toBe('get_weather');
      expect(finalChunk.toolCalls![1].function.name).toBe('get_time');
    });

    it('should include tool calls in completion event from response.completed', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_x","name":"search","arguments":"{\\"q\\":\\"cats\\"}"}}\n\n',
        'data: {"type":"response.completed","id":"resp-456"}\n\n',
      ]);

      const chunks: Array<{ toolCalls?: any[]; complete: boolean }> = [];
      for await (const chunk of adapter.generateStreamAsync('search cats')) {
        chunks.push({ toolCalls: chunk.toolCalls, complete: chunk.complete });
      }

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.complete).toBe(true);
      expect(finalChunk.toolCalls).toHaveLength(1);
      expect(finalChunk.toolCalls![0].id).toBe('call_x');
    });

    it('should not include toolCalls in final chunk when no function calls were made', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_text.delta","delta":{"text":"Hello"}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const chunks: Array<{ toolCalls?: any[]; toolCallsReady?: boolean }> = [];
      for await (const chunk of adapter.generateStreamAsync('hello')) {
        chunks.push({ toolCalls: chunk.toolCalls, toolCallsReady: chunk.toolCallsReady });
      }

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.toolCalls).toBeUndefined();
      expect(finalChunk.toolCallsReady).toBeUndefined();
    });

    it('should use item.id as fallback when call_id is not present', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"item_123","name":"test_fn","arguments":"{}"}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const chunks: Array<{ toolCalls?: any[] }> = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        chunks.push({ toolCalls: chunk.toolCalls });
      }

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.toolCalls![0].id).toBe('item_123');
    });
  });

  describe('network and stream errors', () => {
    it('should propagate error when https.request emits error event', async () => {
      // Override the mock to emit an error on the request object instead of
      // calling the response callback
      const https = require('https');
      (https.request as jest.Mock).mockImplementationOnce(
        (_options: any, _callback: (res: any) => void) => {
          const reqEmitter = new EventEmitter();
          (reqEmitter as any).write = () => {};
          (reqEmitter as any).setTimeout = jest.fn();
          (reqEmitter as any).destroy = jest.fn();
          (reqEmitter as any).end = () => {
            // Simulate a network-level failure (DNS, connection refused, etc.)
            setTimeout(() => {
              reqEmitter.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:443'));
            }, 0);
          };
          return reqEmitter;
        }
      );

      await expect(async () => {
        for await (const _ of adapter.generateStreamAsync('test')) { /* no-op */ }
      }).rejects.toThrow('ECONNREFUSED');
    });

    it('should propagate error when SSE stream emits error mid-stream', async () => {
      // Override the mock to emit data then an error on the response stream
      const https = require('https');
      (https.request as jest.Mock).mockImplementationOnce(
        (_options: any, callback: (res: any) => void) => {
          const reqEmitter = new EventEmitter();
          let writtenBody = '';
          (reqEmitter as any).write = (data: string) => { writtenBody += data; };
          (reqEmitter as any).setTimeout = jest.fn();
          (reqEmitter as any).destroy = jest.fn();
          (reqEmitter as any).end = () => {
            capturedRequests.push({ options: _options, body: writtenBody });

            const resEmitter = new EventEmitter();
            (resEmitter as any).statusCode = 200;
            callback(resEmitter);

            // Emit one good chunk, then an error
            setTimeout(() => {
              resEmitter.emit('data', Buffer.from(
                'data: {"type":"response.output_text.delta","delta":{"text":"partial"}}\n\n'
              ));
              resEmitter.emit('error', new Error('socket hang up'));
            }, 0);
          };
          return reqEmitter;
        }
      );

      await expect(async () => {
        for await (const _ of adapter.generateStreamAsync('test')) { /* no-op */ }
      }).rejects.toThrow('socket hang up');
    });

    it('should emit fallback completion when stream ends without [DONE]', async () => {
      // Stream sends a delta then ends abruptly — no [DONE] or response.completed
      const https = require('https');
      (https.request as jest.Mock).mockImplementationOnce(
        (_options: any, callback: (res: any) => void) => {
          const reqEmitter = new EventEmitter();
          let writtenBody = '';
          (reqEmitter as any).write = (data: string) => { writtenBody += data; };
          (reqEmitter as any).setTimeout = jest.fn();
          (reqEmitter as any).destroy = jest.fn();
          (reqEmitter as any).end = () => {
            capturedRequests.push({ options: _options, body: writtenBody });

            const resEmitter = new EventEmitter();
            (resEmitter as any).statusCode = 200;
            callback(resEmitter);

            setTimeout(() => {
              resEmitter.emit('data', Buffer.from(
                'data: {"type":"response.output_text.delta","delta":{"text":"truncated"}}\n\n'
              ));
              resEmitter.emit('end');
            }, 0);
          };
          return reqEmitter;
        }
      );

      const chunks: Array<{ content: string; complete: boolean }> = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        chunks.push({ content: chunk.content, complete: chunk.complete });
      }

      // Should get the text delta plus a fallback completion
      expect(chunks.some(c => c.content === 'truncated')).toBe(true);
      expect(chunks[chunks.length - 1].complete).toBe(true);
    });
  });

  describe('generateUncached', () => {
    it('should collect all stream chunks and return assembled response', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_text.delta","delta":{"text":"Hello "}}\n\n',
        'data: {"type":"response.output_text.delta","delta":{"text":"World!"}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const response = await adapter.generateUncached('test prompt');

      expect(response.text).toBe('Hello World!');
      expect(response.usage.totalTokens).toBe(0);
      expect(response.finishReason).toBe('stop');
    });

    it('should return tool_calls finishReason and toolCalls when function calls are present', async () => {
      mockCodexSSE([
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_uc1","name":"get_weather","arguments":"{\\"city\\":\\"SF\\"}"}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const response = await adapter.generateUncached('weather in SF');

      expect(response.finishReason).toBe('tool_calls');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0]).toEqual({
        id: 'call_uc1',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"city":"SF"}',
        },
      });
    });
  });
});
