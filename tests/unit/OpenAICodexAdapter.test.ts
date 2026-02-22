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

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

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

// Helper: create a mock ReadableStream from SSE text
function createSSEStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = events.map(e => encoder.encode(e));
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
}

// Helper: create a mock response with SSE stream
function createSSEResponse(events: string[]): Partial<Response> {
  return {
    ok: true,
    status: 200,
    body: createSSEStream(events),
  };
}

describe('OpenAICodexAdapter', () => {
  let adapter: OpenAICodexAdapter;
  let tokens: CodexOAuthTokens;

  beforeEach(() => {
    tokens = createTokens();
    adapter = new OpenAICodexAdapter(tokens);
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

      // Mock the refresh endpoint
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-at',
          refresh_token: 'rotated-rt',
          expires_in: 3600,
        }),
      });

      // Mock the actual API call
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_text.delta","delta":{"text":"Hello"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      // Consume the stream
      const chunks: string[] = [];
      for await (const chunk of nearExpiryAdapter.generateStreamAsync('test prompt')) {
        if (chunk.content) chunks.push(chunk.content);
      }

      // First call should be token refresh
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const refreshCall = mockFetch.mock.calls[0];
      expect(refreshCall[0]).toBe('https://auth.openai.com/oauth/token');

      // Callback should have been invoked
      expect(onRefresh).toHaveBeenCalled();
    });

    it('should not refresh token when far from expiry', async () => {
      // Token is valid for another hour -- no refresh needed
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_text.delta","delta":{"text":"Hello"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const chunks: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test prompt')) {
        if (chunk.content) chunks.push(chunk.content);
      }

      // Only the API call, no refresh call
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    });
  });

  describe('generateStreamAsync request construction', () => {
    it('should send correct headers including Authorization and ChatGPT-Account-Id', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse(['data: [DONE]\n\n'])
      );

      // Consume stream
      for await (const _ of adapter.generateStreamAsync('hello')) { /* no-op */ }

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer test-access-token');
      expect(headers['ChatGPT-Account-Id']).toBe('acct-test-123');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should construct correct request body', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse(['data: [DONE]\n\n'])
      );

      for await (const _ of adapter.generateStreamAsync('hello', {
        model: 'gpt-5.2-codex',
        temperature: 0.7,
        maxTokens: 1000,
        systemPrompt: 'You are a helper.',
      })) { /* no-op */ }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-5.2-codex');
      expect(body.stream).toBe(true);
      expect(body.store).toBe(false);
      expect(body.temperature).toBe(0.7);
      expect(body.max_output_tokens).toBe(1000);
      expect(body.instructions).toBe('You are a helper.');
      // Input should contain user prompt
      expect(body.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'hello' }),
        ])
      );
    });

    it('should include system prompt in input array', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse(['data: [DONE]\n\n'])
      );

      for await (const _ of adapter.generateStreamAsync('hello', {
        systemPrompt: 'System message',
      })) { /* no-op */ }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.input[0]).toEqual({ role: 'system', content: 'System message' });
      expect(body.input[1]).toEqual({ role: 'user', content: 'hello' });
    });

    it('should use conversation history when provided', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse(['data: [DONE]\n\n'])
      );

      const history = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'Follow up' },
      ];

      for await (const _ of adapter.generateStreamAsync('follow up', {
        conversationHistory: history,
      })) { /* no-op */ }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.input).toEqual(history);
    });
  });

  describe('SSE stream parsing', () => {
    it('should extract text from delta.text events', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_text.delta","delta":{"text":"Hello "}}\n\n',
          'data: {"type":"response.output_text.delta","delta":{"text":"world!"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['Hello ', 'world!']);
    });

    it('should handle delta.content variant', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_text.delta","delta":{"content":"content text"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['content text']);
    });

    it('should skip output_text.done recap events', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_text.delta","delta":{"text":"Hello"}}\n\n',
          'data: {"type":"response.output_text.done","text":"Hello full text recap"}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      // Should only get delta, not the done recap
      expect(texts).toEqual(['Hello']);
    });

    it('should emit complete=true on [DONE]', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_text.delta","delta":{"text":"hi"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const completeFlags: boolean[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        completeFlags.push(chunk.complete);
      }

      expect(completeFlags[completeFlags.length - 1]).toBe(true);
    });

    it('should emit complete=true on response.completed event', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_text.delta","delta":{"text":"hi"}}\n\n',
          'data: {"type":"response.completed","id":"resp-123"}\n\n',
        ])
      );

      const completeFlags: boolean[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        completeFlags.push(chunk.complete);
      }

      expect(completeFlags[completeFlags.length - 1]).toBe(true);
    });

    it('should handle malformed JSON lines gracefully (skip them)', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_text.delta","delta":{"text":"before"}}\n\n',
          'data: {malformed json\n\n',
          'data: {"type":"response.output_text.delta","delta":{"text":"after"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['before', 'after']);
    });

    it('should handle SSE comments (lines starting with :)', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          ': this is a comment\n\n',
          'data: {"type":"response.output_text.delta","delta":{"text":"text"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['text']);
    });

    it('should handle empty lines gracefully', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          '\n',
          'data: {"type":"response.output_text.delta","delta":{"text":"ok"}}\n\n',
          '\n',
          'data: [DONE]\n\n',
        ])
      );

      const texts: string[] = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        if (chunk.content) texts.push(chunk.content);
      }

      expect(texts).toEqual(['ok']);
    });

    it('should correctly buffer and parse SSE data split across chunk boundaries', async () => {
      // Simulate a network scenario where a single SSE event arrives in two TCP chunks,
      // splitting mid-JSON. The adapter's buffer logic must reassemble the line before parsing.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: createSSEStream([
          'data: {"type":"response.output_text.delta","delta":{"tex',  // chunk 1: incomplete line
          't":"split across chunks"}}\n\ndata: [DONE]\n\n',           // chunk 2: rest of line + DONE
        ]),
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
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(async () => {
        for await (const _ of adapter.generateStreamAsync('test')) { /* no-op */ }
      }).rejects.toThrow('authentication failed');
    });

    it('should throw AUTHENTICATION_ERROR on 403', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      await expect(async () => {
        for await (const _ of adapter.generateStreamAsync('test')) { /* no-op */ }
      }).rejects.toThrow('authentication failed');
    });

    it('should throw RATE_LIMIT_ERROR on 429', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      });

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
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(async () => {
        for await (const _ of adapter.generateStreamAsync('test')) { /* no-op */ }
      }).rejects.toThrow('Codex API error');
    });

    it('should throw when response body is null', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: null,
      });

      await expect(async () => {
        for await (const _ of adapter.generateStreamAsync('test')) { /* no-op */ }
      }).rejects.toThrow('Response body is null');
    });
  });

  describe('concurrent token refresh deduplication', () => {
    it('should make only one refresh call when two requests need refresh simultaneously', async () => {
      // Both adapters share the same near-expiry token state
      const nearExpiryTokens = createTokens({
        expiresAt: Date.now() + 60_000, // Within 5-min threshold
      });
      const onRefresh = jest.fn();
      const sharedAdapter = new OpenAICodexAdapter(nearExpiryTokens, onRefresh);

      // The refresh endpoint -- a single call that resolves after a tick
      let refreshCallCount = 0;
      mockFetch.mockImplementation(async (url: string) => {
        if (url === 'https://auth.openai.com/oauth/token') {
          refreshCallCount++;
          return {
            ok: true,
            json: async () => ({
              access_token: 'refreshed-at',
              refresh_token: 'rotated-rt',
              expires_in: 3600,
            }),
          };
        }
        // API call response
        return createSSEResponse([
          'data: {"type":"response.output_text.delta","delta":{"text":"ok"}}\n\n',
          'data: [DONE]\n\n',
        ]);
      });

      // Fire two concurrent streaming requests -- both should trigger ensureFreshToken
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

      // Both streams should produce output
      expect(result1).toEqual(['ok']);
      expect(result2).toEqual(['ok']);

      // The adapter deduplicates refresh via refreshInProgress promise lock.
      // Only 1 refresh call should be made (not 2).
      expect(refreshCallCount).toBe(1);
    });
  });

  describe('token refresh error handling', () => {
    it('should throw AUTHENTICATION_ERROR when token refresh fails', async () => {
      const nearExpiryAdapter = new OpenAICodexAdapter(
        createTokens({ expiresAt: Date.now() + 60_000 })
      );

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Invalid grant',
      });

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
      mockFetch.mockResolvedValueOnce(
        createSSEResponse(['data: [DONE]\n\n'])
      );

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

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tools).toEqual([
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get current weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          strict: null,
        },
      ]);
    });

    it('should pass through tools already in Responses API format', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse(['data: [DONE]\n\n'])
      );

      const tools = [
        {
          type: 'function',
          name: 'search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ];

      for await (const _ of adapter.generateStreamAsync('Search for cats', { tools })) { /* no-op */ }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Already flat format — passed through unchanged
      expect(body.tools[0].name).toBe('search');
    });

    it('should accumulate tool calls from response.output_item.done events', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.function_call_arguments.delta","delta":"{\\"city\\":"}\n\n',
          'data: {"type":"response.function_call_arguments.delta","delta":"\\"NYC\\"}"}\n\n',
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_abc","name":"get_weather","arguments":"{\\"city\\":\\"NYC\\"}"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const chunks: Array<{ toolCalls?: any[]; toolCallsReady?: boolean }> = [];
      for await (const chunk of adapter.generateStreamAsync('weather in NYC')) {
        chunks.push({ toolCalls: chunk.toolCalls, toolCallsReady: chunk.toolCallsReady });
      }

      // The final chunk (complete=true) should contain the tool call
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
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\\"city\\":\\"NYC\\"}"}}\n\n',
          'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call_2","name":"get_time","arguments":"{\\"tz\\":\\"EST\\"}"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

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
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_x","name":"search","arguments":"{\\"q\\":\\"cats\\"}"}}\n\n',
          'data: {"type":"response.completed","id":"resp-456"}\n\n',
        ])
      );

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
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_text.delta","delta":{"text":"Hello"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const chunks: Array<{ toolCalls?: any[]; toolCallsReady?: boolean }> = [];
      for await (const chunk of adapter.generateStreamAsync('hello')) {
        chunks.push({ toolCalls: chunk.toolCalls, toolCallsReady: chunk.toolCallsReady });
      }

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.toolCalls).toBeUndefined();
      expect(finalChunk.toolCallsReady).toBeUndefined();
    });

    it('should use item.id as fallback when call_id is not present', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"item_123","name":"test_fn","arguments":"{}"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const chunks: Array<{ toolCalls?: any[] }> = [];
      for await (const chunk of adapter.generateStreamAsync('test')) {
        chunks.push({ toolCalls: chunk.toolCalls });
      }

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.toolCalls![0].id).toBe('item_123');
    });
  });

  describe('generateUncached', () => {
    it('should collect all stream chunks and return assembled response', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_text.delta","delta":{"text":"Hello "}}\n\n',
          'data: {"type":"response.output_text.delta","delta":{"text":"World!"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const response = await adapter.generateUncached('test prompt');

      expect(response.text).toBe('Hello World!');
      expect(response.usage.totalTokens).toBe(0); // Codex doesn't report usage
      expect(response.finishReason).toBe('stop');
    });

    it('should return tool_calls finishReason and toolCalls when function calls are present', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_uc1","name":"get_weather","arguments":"{\\"city\\":\\"SF\\"}"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

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
