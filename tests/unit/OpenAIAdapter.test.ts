/**
 * OpenAIAdapter characterization tests.
 *
 * Pin current behavior of the Responses API adapter (non-streaming generate,
 * SSE streaming, error mapping, API-key handling) ahead of shared-code
 * extraction. Mocks at the requestUrl seam; no live network calls.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { OpenAIAdapter } from '../../src/services/llm/adapters/openai/OpenAIAdapter';
import { LLMProviderError } from '../../src/services/llm/adapters/types';
import {
  jsonResponse,
  sseResponse,
  sse,
  collect,
  concatContent,
  captureError,
  CapturedRequest
} from './helpers/llmAdapterTestHarness';

describe('OpenAIAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('non-streaming generate', () => {
    it('parses Responses API output into text, usage, and responseId metadata', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          id: 'resp_123',
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: 'Hello' },
                { type: 'output_text', text: ' world' }
              ]
            }
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        });
      });

      const adapter = new OpenAIAdapter('sk-test');
      const result = await adapter.generateUncached('hi', { systemPrompt: 'Be brief' });

      expect(result.text).toBe('Hello world');
      expect(result.model).toBe('gpt-5.5');
      expect(result.provider).toBe('openai');
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
      expect(result.metadata?.responseId).toBe('resp_123');

      expect(requests[0].url).toBe('https://api.openai.com/v1/responses');
      expect(requests[0].headers?.['Authorization']).toBe('Bearer sk-test');
      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.input).toBe('hi');
      expect(body.instructions).toBe('Be brief');
      expect(body.stream).toBe(false);
    });

    it('throws when the Responses API returns no output items', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, { id: 'resp_1', output: [] }));

      const adapter = new OpenAIAdapter('sk-test');
      const error = await captureError(adapter.generateUncached('hi')) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe('UNKNOWN_ERROR');
      expect(error.message).toBe('generation failed: No output from OpenAI Responses API');
    });

    it('rejects tools on the non-streaming path', async () => {
      const adapter = new OpenAIAdapter('sk-test');
      const error = await captureError(adapter.generateUncached('hi', {
        tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: {} } }]
      })) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe('UNKNOWN_ERROR');
      expect(error.message).toBe('generation failed: Tool execution requires streaming. Use generateStreamAsync() instead.');
    });
  });

  describe('SSE streaming', () => {
    it('yields text deltas and a final chunk with usage, tool calls, and responseId', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { type: 'response.created', response: { id: 'resp_abc' } },
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: ' world' },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' }
        },
        {
          type: 'response.completed',
          response: { id: 'resp_abc', usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } }
        }
      )));

      const adapter = new OpenAIAdapter('sk-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      expect(concatContent(chunks)).toBe('Hello world');
      const final = chunks[chunks.length - 1];
      expect(final.complete).toBe(true);
      expect(final.usage).toEqual({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
      expect(final.toolCalls).toEqual([
        { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }
      ]);
      expect(final.toolCallsReady).toBe(true);
      expect(final.metadata).toEqual({ responseId: 'resp_abc' });
    });

    it('yields reasoning summary deltas with reasoningId and encrypted content', async () => {
      __setRequestUrlMock(async () => sseResponse(sse(
        { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } },
        { type: 'response.reasoning_summary_text.delta', delta: 'thinking...', item_id: 'rs_1' },
        { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc123' } },
        { type: 'response.completed', response: { id: 'resp_r' } }
      )));

      const adapter = new OpenAIAdapter('sk-test');
      const chunks = await collect(adapter.generateStreamAsync('hi'));

      const reasoningChunks = chunks.filter(chunk => chunk.reasoning !== undefined);
      expect(reasoningChunks[0]).toMatchObject({ reasoning: '', reasoningComplete: false, reasoningId: 'rs_1' });
      expect(reasoningChunks[1]).toMatchObject({ reasoning: 'thinking...', reasoningComplete: false, reasoningId: 'rs_1' });
      expect(reasoningChunks[2]).toMatchObject({
        reasoning: '',
        reasoningComplete: true,
        reasoningId: 'rs_1',
        reasoningEncryptedContent: 'enc123'
      });
    });

    it('converts Chat Completions tools to flat Responses API tools in the request body', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return sseResponse(sse({ type: 'response.completed', response: { id: 'resp_1' } }));
      });

      const adapter = new OpenAIAdapter('sk-test');
      await collect(adapter.generateStreamAsync('hi', {
        tools: [{
          type: 'function',
          function: { name: 'search', description: 'Search', parameters: { type: 'object', properties: {} } }
        }]
      }));

      const body = JSON.parse(requests[0].body ?? '{}');
      expect(body.stream).toBe(true);
      expect(body.tools).toEqual([{
        type: 'function',
        name: 'search',
        description: 'Search',
        parameters: { type: 'object', properties: {} },
        strict: null
      }]);
    });

    it('maps a streaming 401 to LLMProviderError AUTHENTICATION_ERROR', async () => {
      __setRequestUrlMock(async () => jsonResponse(401, { error: { message: 'Invalid API key' } }));

      const adapter = new OpenAIAdapter('sk-bad');
      const error = await captureError(collect(adapter.generateStreamAsync('hi'))) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe('AUTHENTICATION_ERROR');
      expect(error.provider).toBe('openai');
    });
  });

  describe('error mapping (non-streaming)', () => {
    it.each([
      [401, 'AUTHENTICATION_ERROR', 'Invalid API key'],
      [429, 'RATE_LIMIT_ERROR', 'Rate limit exceeded'],
      [500, 'SERVER_ERROR', 'Internal error']
    ])('maps HTTP %i to %s', async (status, code, providerMessage) => {
      __setRequestUrlMock(async () => jsonResponse(status, { error: { message: providerMessage } }));

      const adapter = new OpenAIAdapter('sk-test');
      const error = await captureError(adapter.generateUncached('hi')) as LLMProviderError;

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error.code).toBe(code);
      expect(error.provider).toBe('openai');
      expect(error.message).toBe(`generation failed: ${providerMessage}`);
    });
  });

  describe('config / API key handling', () => {
    it('masks the API key and reports NOT_SET when missing', () => {
      expect(new OpenAIAdapter('sk-test-1234').getApiKey()).toBe('***1234');
      expect(new OpenAIAdapter('').getApiKey()).toBe('NOT_SET');
    });

    it('isAvailable is false without an API key and true with one (registry-backed listModels)', async () => {
      await expect(new OpenAIAdapter('').isAvailable()).resolves.toBe(false);
      await expect(new OpenAIAdapter('sk-test').isAvailable()).resolves.toBe(true);
    });

    it('still sends requests with an empty Bearer token (no client-side key guard)', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(200, {
          id: 'resp_1',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]
        });
      });

      const adapter = new OpenAIAdapter('');
      await adapter.generateUncached('hi');

      expect(requests[0].headers?.['Authorization']).toBe('Bearer ');
    });
  });
});
