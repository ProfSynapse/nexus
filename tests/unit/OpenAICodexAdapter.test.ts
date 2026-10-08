import { __setRequestUrlMock } from '../mocks/obsidian';

// Force requestStream to use the buffered fallback (requestUrl mock) instead of real Node.js https
jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { OpenAICodexAdapter, CodexOAuthTokens } from '../../src/services/llm/adapters/openai-codex/OpenAICodexAdapter';
import { createBuiltinProviderDrivers } from '../../src/services/llm/providers/BuiltinProviderDrivers';
import { providerInstanceId } from '../../src/services/llm/providers/ProviderDriver';

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

  it.each(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])('omits temperature for %s on the subscription endpoint', async (model) => {
    const requests: RequestRecord[] = [];
    __setRequestUrlMock(async (request) => {
      requests.push(request);
      return {
        status: 200, headers: {}, json: {}, arrayBuffer: new ArrayBuffer(0),
        text: 'data: {"type":"response.completed","response":{"id":"resp_astra"}}\n\n'
      };
    });
    const adapter = new OpenAICodexAdapter(createTokens());
    for await (const chunk of adapter.generateStreamAsync('hi', { model, temperature: 0.7 })) {
      void chunk;
    }
    expect(JSON.parse(requests[0].body ?? '{}')).not.toHaveProperty('temperature');
  });

  it.each([
    ['gpt-6.1-sol', 'max', 'max'],
    ['gpt-5.6-sol', 'max', 'max'],
    ['gpt-5.2', 'max', 'xhigh']
  ] as const)('sends %s effort %s as %s through streaming and non-streaming calls', async (model, requested, expected) => {
    const requests: RequestRecord[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return {
        status: 200, headers: {}, json: {}, arrayBuffer: new ArrayBuffer(0),
        text: 'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'
      };
    });
    const adapter = new OpenAICodexAdapter(createTokens());
    for await (const chunk of adapter.generateStreamAsync('hi', {
      model, enableThinking: true, thinkingEffort: requested
    })) void chunk;
    await adapter.generateUncached('hi', { model, enableThinking: true, thinkingEffort: requested });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(JSON.parse(request.body ?? '{}').reasoning).toEqual({ effort: expected });
    }
  });

  it('omits reasoning when thinking is disabled', async () => {
    const requests: RequestRecord[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return { status: 200, headers: {}, json: {}, arrayBuffer: new ArrayBuffer(0),
        text: 'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n' };
    });
    for await (const chunk of new OpenAICodexAdapter(createTokens()).generateStreamAsync('hi', {
      model: 'gpt-6-sol', enableThinking: false, thinkingEffort: 'max'
    })) void chunk;
    expect(JSON.parse(requests[0].body ?? '{}')).not.toHaveProperty('reasoning');
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

  it('marks a rejected Codex refresh token for reconnection and persists the state', async () => {
    const config = {
      enabled: true,
      apiKey: 'test-access-token',
      oauth: {
        connected: true,
        providerId: 'openai-codex',
        connectedAt: Date.now(),
        refreshToken: 'test-refresh-token' as string | undefined,
        expiresAt: Date.now() - 1000 as number | undefined,
        metadata: { accountId: 'acct-test-123' },
        reconnectRequired: false,
      },
    };
    const onSettingsDirty = jest.fn();
    const registration = createBuiltinProviderDrivers().find(({ driver }) => driver.kind === 'openai-codex');
    expect(registration).toBeDefined();
    const instance = await registration!.driver.createInstance({
      instanceId: providerInstanceId('openai-codex'),
      displayName: 'OpenAI Codex',
      config,
      onSettingsDirty,
    });
    __setRequestUrlMock(async () => ({
      status: 401,
      headers: {},
      text: '{"error":{"code":"invalid_refresh_token"}}',
      json: { error: { code: 'invalid_refresh_token' } },
      arrayBuffer: new ArrayBuffer(0),
    }));

    await expect(async () => {
      for await (const chunk of instance.adapter.generateStreamAsync('hello')) void chunk;
    }).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });

    expect(config.apiKey).toBe('');
    expect(config.oauth).toMatchObject({ connected: false, reconnectRequired: true });
    expect(config.oauth.refreshToken).toBeUndefined();
    expect(onSettingsDirty).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });

  it('keeps the connection after a temporary refresh failure', async () => {
    const rejected = jest.fn();
    const adapter = new OpenAICodexAdapter(
      createTokens({ expiresAt: Date.now() - 1000 }),
      undefined,
      rejected,
    );
    __setRequestUrlMock(async () => ({
      status: 503,
      headers: {},
      text: 'Service unavailable',
      json: { error: { code: 'server_error' } },
      arrayBuffer: new ArrayBuffer(0),
    }));

    await expect(async () => {
      for await (const chunk of adapter.generateStreamAsync('hello')) void chunk;
    }).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });
    expect(rejected).not.toHaveBeenCalled();
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
    expect(body.model).toBe('gpt-5.6-sol');
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

  it('captures assistant text when Responses API finalizes it on message/content events', async () => {
    const adapter = new OpenAICodexAdapter(createTokens());
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: [
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}\n\n',
        'data: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
        'data: {"type":"response.output_text.done","item_id":"msg_1","output_index":0,"content_index":0,"text":"FINAL_TEXT"}\n\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"FINAL_TEXT","annotations":[]}]}}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'
      ].join(''),
      json: {},
      arrayBuffer: new ArrayBuffer(0)
    }));

    const chunks = [];
    for await (const chunk of adapter.generateStreamAsync('hello')) {
      chunks.push(chunk);
    }

    expect(chunks.some((chunk) => chunk.content === 'FINAL_TEXT')).toBe(true);
    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.complete).toBe(true);
    expect(finalChunk.metadata?.responseId).toBe('resp_1');
  });

  it('does not duplicate finalized text when deltas already streamed for the same output item', async () => {
    const adapter = new OpenAICodexAdapter(createTokens());
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: [
        'data: {"type":"response.output_text.delta","output_index":0,"delta":"FINAL"}\n\n',
        'data: {"type":"response.output_text.delta","output_index":0,"delta":"_TEXT"}\n\n',
        'data: {"type":"response.output_text.done","item_id":"msg_1","output_index":0,"text":"FINAL_TEXT"}\n\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"FINAL_TEXT","annotations":[]}]}}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'
      ].join(''),
      json: {},
      arrayBuffer: new ArrayBuffer(0)
    }));

    const textChunks: string[] = [];
    for await (const chunk of adapter.generateStreamAsync('hello')) {
      if (chunk.content) {
        textChunks.push(chunk.content);
      }
    }

    expect(textChunks).toEqual(['FINAL', '_TEXT']);
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
