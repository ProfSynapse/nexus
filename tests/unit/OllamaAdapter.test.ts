/**
 * OllamaAdapter characterization tests.
 *
 * Covers the native /api/chat integration: non-streaming + streaming
 * generation, native tool calling (object arguments -> ToolCall), structured
 * output via the `format` parameter, OpenAI->native message normalization for
 * tool continuations, and /api/tags model discovery.
 *
 * Mocks at the requestUrl seam and forces ProviderHttpClient.requestStream onto
 * its buffered requestUrl fallback by mocking hasNodeRuntime to false.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { OllamaAdapter } from '../../src/services/llm/adapters/ollama/OllamaAdapter';
import { Tool } from '../../src/services/llm/adapters/types';
import {
  jsonResponse,
  collect,
  concatContent,
  CapturedRequest
} from './helpers/llmAdapterTestHarness';

const URL = 'http://127.0.0.1:11434';

/** Build a newline-delimited JSON (NDJSON) HTTP response, as Ollama streams. */
function ndjsonResponse(...objs: unknown[]) {
  return {
    status: 200,
    headers: {},
    text: objs.map(o => JSON.stringify(o)).join('\n') + '\n',
    json: null,
    arrayBuffer: new ArrayBuffer(0)
  };
}

const WEATHER_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the weather in a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city']
    }
  }
};

describe('OllamaAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('non-streaming generate', () => {
    it('parses message.content, usage, and posts to /api/chat', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          model: 'llama3.1',
          message: { role: 'assistant', content: 'Hi there' },
          done: true,
          prompt_eval_count: 7,
          eval_count: 3
        });
      });

      const adapter = new OllamaAdapter(URL, 'llama3.1');
      const result = await adapter.generateUncached('hi', { systemPrompt: 'Be brief' });

      expect(result.text).toBe('Hi there');
      expect(result.provider).toBe('ollama');
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toMatchObject({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });

      expect(requests[0].url).toBe(`${URL}/api/chat`);
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'hi' }
      ]);
    });

    it('sends native tool schemas and parses native tool_calls (object args -> stringified)', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          model: 'llama3.1',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Tokyo' } } }]
          },
          done: true,
          prompt_eval_count: 10,
          eval_count: 5
        });
      });

      const adapter = new OllamaAdapter(URL, 'llama3.1');
      const result = await adapter.generateUncached('weather in tokyo?', { tools: [WEATHER_TOOL] });

      // tools forwarded in native (== OpenAI) shape
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the weather in a city',
            parameters: WEATHER_TOOL.function!.parameters
          }
        }
      ]);

      // empty content + tool calls is valid and maps to finishReason tool_calls
      expect(result.finishReason).toBe('tool_calls');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].function.name).toBe('get_weather');
      expect(result.toolCalls![0].function.arguments).toBe('{"city":"Tokyo"}');
      expect(result.toolCalls![0].sourceFormat).toBe('native');
    });

    it('sets format=json for structured output when jsonMode is enabled', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          message: { role: 'assistant', content: '{"ok":true}' },
          done: true
        });
      });

      const adapter = new OllamaAdapter(URL, 'llama3.1');
      await adapter.generateUncached('give me json', { jsonMode: true });

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.format).toBe('json');
    });

    it('parses content-embedded <tool_call> format for fine-tuned models', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, {
        message: {
          role: 'assistant',
          content: '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>'
        },
        done: true
      }));

      const adapter = new OllamaAdapter(URL, 'nexus-tools-sft');
      const result = await adapter.generateUncached('weather?', { tools: [WEATHER_TOOL] });

      expect(result.finishReason).toBe('tool_calls');
      expect(result.toolCalls![0].function.name).toBe('get_weather');
    });
  });

  describe('message normalization (OpenAI -> native)', () => {
    it('converts assistant tool_calls string args to objects and tool results to tool_name', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, { message: { role: 'assistant', content: 'done' }, done: true });
      });

      const adapter = new OllamaAdapter(URL, 'llama3.1');
      await adapter.generateUncached('', {
        conversationHistory: [
          { role: 'user', content: 'weather in tokyo?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' }
            }]
          },
          { role: 'tool', tool_call_id: 'call_1', content: '11 degrees celsius' }
        ]
      });

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.messages[0]).toEqual({ role: 'user', content: 'weather in tokyo?' });
      // assistant tool_calls: arguments parsed to object, id dropped (native has none)
      expect(body.messages[1].tool_calls).toEqual([
        { function: { name: 'get_weather', arguments: { city: 'Tokyo' } } }
      ]);
      // tool result: keyed by tool_name resolved from the matching call id
      expect(body.messages[2]).toEqual({
        role: 'tool',
        content: '11 degrees celsius',
        tool_name: 'get_weather'
      });
    });
  });

  describe('streaming', () => {
    it('yields content deltas and final usage', async () => {
      __setRequestUrlMock(async () => ndjsonResponse(
        { message: { role: 'assistant', content: 'Hello' }, done: false },
        { message: { role: 'assistant', content: ' world' }, done: false },
        { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 7, eval_count: 2 }
      ));

      const adapter = new OllamaAdapter(URL, 'llama3.1');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      expect(concatContent(chunks)).toBe('Hello world');
      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.usage).toEqual({ promptTokens: 7, completionTokens: 2, totalTokens: 9 });
    });

    it('surfaces native tool_calls on the final chunk', async () => {
      __setRequestUrlMock(async () => ndjsonResponse(
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Tokyo' } } }]
          },
          done: false
        },
        { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 9, eval_count: 4 }
      ));

      const adapter = new OllamaAdapter(URL, 'llama3.1');
      const chunks = await collect(adapter.generateStreamAsync('weather?', { tools: [WEATHER_TOOL] }));

      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.toolCallsReady).toBe(true);
      expect(final.toolCalls).toHaveLength(1);
      expect(final.toolCalls![0].function).toEqual({ name: 'get_weather', arguments: '{"city":"Tokyo"}' });
    });
  });

  describe('model discovery', () => {
    it('lists installed models from /api/tags with capability detection', async () => {
      __setRequestUrlMock(async (request) => {
        expect(request.url).toBe(`${URL}/api/tags`);
        return jsonResponse(200, {
          models: [
            { name: 'llama3.2:latest', model: 'llama3.2:latest' },
            { name: 'qwen2.5:7b', model: 'qwen2.5:7b' },
            { name: 'llava:13b', model: 'llava:13b' }
          ]
        });
      });

      const adapter = new OllamaAdapter(URL, 'llama3.1');
      const models = await adapter.listModels();

      expect(models.map(m => m.id)).toEqual(['llama3.2:latest', 'qwen2.5:7b', 'llava:13b']);
      expect(models[0].supportsFunctions).toBe(true); // llama3.2
      expect(models[0].supportsJSON).toBe(true);
      expect(models[2].supportsImages).toBe(true);    // llava
    });

    it('falls back to the configured model when /api/tags is unreachable', async () => {
      __setRequestUrlMock(async () => { throw new Error('ECONNREFUSED'); });

      const adapter = new OllamaAdapter(URL, 'llama3.1');
      const models = await adapter.listModels();

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('llama3.1');
    });
  });

  describe('capabilities', () => {
    it('advertises native function calling and JSON mode', () => {
      const caps = new OllamaAdapter(URL, 'llama3.1').getCapabilities();
      expect(caps.supportsFunctions).toBe(true);
      expect(caps.supportsJSON).toBe(true);
      expect(caps.supportedFeatures).toEqual(
        expect.arrayContaining(['function_calling', 'json_mode'])
      );
    });
  });
});
