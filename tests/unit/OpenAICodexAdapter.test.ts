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

    it('should report no function calling support', () => {
      const caps = adapter.getCapabilities();
      expect(caps.supportsFunctions).toBe(false);
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
    });
  });
});
