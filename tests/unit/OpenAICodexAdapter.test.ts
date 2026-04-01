import { __setRequestUrlMock } from '../mocks/obsidian';

// Force requestStream to use the buffered fallback (requestUrl mock) instead of real Node.js https
jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { OpenAICodexAdapter, CodexOAuthTokens } from '../../src/services/llm/adapters/openai-codex/OpenAICodexAdapter';

type RequestRecord = {
  url: string;
  headers: Record<string, string>;
  body?: string;
  method?: string;
};

function createTokens(overrides?: Partial<CodexOAuthTokens>): CodexOAuthTokens {
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3600_000,
    accountId: 'acct-test-123',
    ...overrides,
  };
}

describe('OpenAICodexAdapter', () => {
  beforeEach(() => {
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: 'data: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
      json: {},
      arrayBuffer: new ArrayBuffer(0)
    }));
  });

  it('refreshes expiring tokens before inference', async () => {
    const seenUrls: string[] = [];
    const refreshed: CodexOAuthTokens[] = [];
    const adapter = new OpenAICodexAdapter(
      createTokens({ expiresAt: Date.now() + 60_000 }),
      (tokens) => refreshed.push(tokens)
    );

    __setRequestUrlMock(async (request) => {
      seenUrls.push(request.url);

      if (request.url.includes('/oauth/token')) {
        return {
          status: 200,
          headers: {},
          text: '{"access_token":"refreshed-at","refresh_token":"rotated-rt","expires_in":3600}',
          json: {
            access_token: 'refreshed-at',
            refresh_token: 'rotated-rt',
            expires_in: 3600,
          },
          arrayBuffer: new ArrayBuffer(0)
        };
      }

      return {
        status: 200,
        headers: {},
        text: 'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
        json: {},
        arrayBuffer: new ArrayBuffer(0)
      };
    });

    for await (const chunk of adapter.generateStreamAsync('hello')) {
      void chunk;
    }

    expect(seenUrls.some((url) => url.includes('/oauth/token'))).toBe(true);
    expect(refreshed[0].accessToken).toBe('refreshed-at');
  });

  it('sends codex headers and request body through requestUrl', async () => {
    const requests: RequestRecord[] = [];
    const adapter = new OpenAICodexAdapter(createTokens());

    __setRequestUrlMock(async (request) => {
      requests.push(request);
      return {
        status: 200,
        headers: {},
        text: 'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
        json: {},
        arrayBuffer: new ArrayBuffer(0)
      };
    });

    for await (const chunk of adapter.generateStreamAsync('hello', {
      systemPrompt: 'System message',
      tools: [{
        type: 'function',
        function: {
          name: 'search',
          description: 'Search',
          parameters: { type: 'object', properties: {} }
        }
      }]
    })) {
      void chunk;
    }

    const request = requests[0];
    const body = JSON.parse(request.body ?? '{}');

    expect(request.headers.Authorization).toBe('Bearer test-access-token');
    expect(request.headers['ChatGPT-Account-Id']).toBe('acct-test-123');
    expect(body.model).toBe('gpt-5.4');
    expect(body.stream).toBe(true);
    expect(body.tool_choice).toBe('auto');
    expect(body.instructions).toContain('System message');
    expect(body.tools[0].name).toBe('search');
  });

  it('parses buffered SSE text into response chunks and tool calls', async () => {
    const adapter = new OpenAICodexAdapter(createTokens());
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: [
        'data: {"type":"response.output_text.delta","delta":"Hello "}\n\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"search","arguments":"{\\"q\\":\\"docs\\"}"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"world"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'
      ].join(''),
      json: {},
      arrayBuffer: new ArrayBuffer(0)
    }));

    const chunks = [];
    for await (const chunk of adapter.generateStreamAsync('hello')) {
      chunks.push(chunk);
    }

    expect(chunks.some((chunk) => chunk.content === 'Hello ')).toBe(true);
    expect(chunks.some((chunk) => chunk.content === 'world')).toBe(true);
    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.complete).toBe(true);
    expect(finalChunk.toolCalls?.[0]?.function?.name).toBe('search');
    expect(finalChunk.metadata?.responseId).toBe('resp_1');
  });

  it('maps authentication and rate limit failures to provider errors', async () => {
    const adapter = new OpenAICodexAdapter(createTokens());

    __setRequestUrlMock(async () => ({
      status: 429,
      headers: {},
      text: 'Too many requests',
      json: { error: { message: 'Too many requests' } },
      arrayBuffer: new ArrayBuffer(0)
    }));

    await expect(async () => {
      for await (const chunk of adapter.generateStreamAsync('hello')) {
        void chunk;
      }
    }).rejects.toMatchObject({
      name: 'LLMProviderError',
      code: 'RATE_LIMIT_ERROR',
      provider: 'openai-codex'
    });
  });

  it('isAvailable returns false when access token is empty', async () => {
    const adapter = new OpenAICodexAdapter(createTokens({ accessToken: '' }));
    expect(await adapter.isAvailable()).toBe(false);
  });

  it('isAvailable returns true with valid tokens', async () => {
    const adapter = new OpenAICodexAdapter(createTokens());
    expect(await adapter.isAvailable()).toBe(true);
  });

  it('maps 401 response to AUTHENTICATION_ERROR', async () => {
    const adapter = new OpenAICodexAdapter(createTokens());

    __setRequestUrlMock(async () => ({
      status: 401,
      headers: {},
      text: 'Unauthorized',
      json: { error: { message: 'Invalid token' } },
      arrayBuffer: new ArrayBuffer(0)
    }));

    await expect(async () => {
      for await (const chunk of adapter.generateStreamAsync('hello')) {
        void chunk;
      }
    }).rejects.toMatchObject({
      name: 'LLMProviderError',
      code: 'AUTHENTICATION_ERROR',
      provider: 'openai-codex'
    });
  });

  it('maps 500 response to SERVER_ERROR', async () => {
    const adapter = new OpenAICodexAdapter(createTokens());

    __setRequestUrlMock(async () => ({
      status: 500,
      headers: {},
      text: 'Internal Server Error',
      json: { error: { message: 'Internal server error' } },
      arrayBuffer: new ArrayBuffer(0)
    }));

    await expect(async () => {
      for await (const chunk of adapter.generateStreamAsync('hello')) {
        void chunk;
      }
    }).rejects.toMatchObject({
      name: 'LLMProviderError',
      code: 'SERVER_ERROR',
      provider: 'openai-codex'
    });
  });

  it('includes tool definitions in request body when tools provided', async () => {
    const requests: RequestRecord[] = [];
    const adapter = new OpenAICodexAdapter(createTokens());

    __setRequestUrlMock(async (request) => {
      requests.push(request);
      return {
        status: 200,
        headers: {},
        text: 'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
        json: {},
        arrayBuffer: new ArrayBuffer(0)
      };
    });

    const tools = [
      {
        type: 'function',
        function: {
          name: 'getWeather',
          description: 'Get weather data',
          parameters: { type: 'object', properties: { city: { type: 'string' } } }
        }
      },
      {
        type: 'function',
        function: {
          name: 'searchDocs',
          description: 'Search documentation',
          parameters: { type: 'object', properties: { query: { type: 'string' } } }
        }
      }
    ];

    for await (const chunk of adapter.generateStreamAsync('What is the weather?', { tools })) {
      void chunk;
    }

    const body = JSON.parse(requests[0].body);
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0].name).toBe('getWeather');
    expect(body.tools[1].name).toBe('searchDocs');
    expect(body.tool_choice).toBe('auto');
  });

  it('getCapabilities returns expected shape', () => {
    const adapter = new OpenAICodexAdapter(createTokens());
    const capabilities = adapter.getCapabilities();

    expect(capabilities.supportsStreaming).toBe(true);
    expect(capabilities.supportsFunctions).toBe(true);
    expect(capabilities.supportsImages).toBe(true);
    expect(capabilities.supportsThinking).toBe(true);
    expect(capabilities.maxContextWindow).toBe(1050000);
    expect(capabilities.supportedFeatures).toContain('tool_calling');
    expect(capabilities.supportedFeatures).toContain('thinking_models');
    expect(capabilities.supportedFeatures).toContain('oauth_required');
  });

  it('isAvailable returns false when accountId is empty', async () => {
    const adapter = new OpenAICodexAdapter(createTokens({ accountId: '' }));
    expect(await adapter.isAvailable()).toBe(false);
  });

  it('generateUncached collects streamed content into a single response', async () => {
    const adapter = new OpenAICodexAdapter(createTokens());
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: [
        'data: {"type":"response.output_text.delta","delta":"Hello "}\n\n',
        'data: {"type":"response.output_text.delta","delta":"world"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'
      ].join(''),
      json: {},
      arrayBuffer: new ArrayBuffer(0)
    }));

    const result = await adapter.generateUncached('test');
    expect(result.text).toBe('Hello world');
    expect(result.finishReason).toBe('stop');
  });
});
