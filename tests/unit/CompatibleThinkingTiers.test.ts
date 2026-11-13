/**
 * Discovery-driven and probe-driven thinking tier unlocking across all four
 * compatible protocols (`openai-compatible`, `responses-compatible`,
 * `anthropic-compatible`, `antigravity-compatible`).
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import type {
  LLMProviderConfig,
  OpenAICompatibleModelDefinition,
} from '../../src/types/llm/ProviderTypes';
import {
  describeThinkingCapability,
  readReportedThinkingMetadata,
} from '../../src/services/llm/adapters/shared/CompatibleThinkingProbe';
import { syncCompatibleWireProtocols } from '../../src/services/llm/adapters/shared/CompatibleEndpointUtils';
import { OpenAICompatibleAdapter } from '../../src/services/llm/adapters/openai-compatible/OpenAICompatibleAdapter';
import {
  buildOpenAICompatibleModels,
  discoverOpenAICompatibleModels,
  probeOpenAICompatibleModelThinking,
} from '../../src/services/llm/adapters/openai-compatible/OpenAICompatibleConfig';
import { ResponsesCompatibleAdapter } from '../../src/services/llm/adapters/responses-compatible/ResponsesCompatibleAdapter';
import {
  buildResponsesCompatibleModels,
  discoverResponsesCompatibleModels,
  probeResponsesCompatibleModelThinking,
} from '../../src/services/llm/adapters/responses-compatible/ResponsesCompatibleConfig';
import { AnthropicCompatibleAdapter } from '../../src/services/llm/adapters/anthropic-compatible/AnthropicCompatibleAdapter';
import {
  buildAnthropicCompatibleModels,
  discoverAnthropicCompatibleModels,
  probeAnthropicCompatibleModelThinking,
} from '../../src/services/llm/adapters/anthropic-compatible/AnthropicCompatibleConfig';
import { AntigravityCompatibleAdapter } from '../../src/services/llm/adapters/antigravity-compatible/AntigravityCompatibleAdapter';
import {
  buildAntigravityCompatibleModels,
  discoverAntigravityCompatibleModels,
  probeAntigravityCompatibleModelThinking,
} from '../../src/services/llm/adapters/antigravity-compatible/AntigravityCompatibleConfig';
import { getStaticModelCapabilities } from '../../src/components/shared/chatSettings/modelCapabilities';
import {
  getSupportedThinkingEfforts,
  normalizeThinkingEffortForModel,
} from '../../src/services/llm/utils/thinkingLevels';
import { ThinkingEffortMapper } from '../../src/services/llm/utils/ThinkingEffortMapper';
import { StaticModelsService } from '../../src/services/StaticModelsService';
import {
  collect,
  jsonResponse,
  sse,
  sseResponse,
  type CapturedRequest,
} from './helpers/llmAdapterTestHarness';

function parseBody(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(request.body ?? '{}') as Record<string, unknown>;
}

function readNested(root: unknown, ...keys: string[]): unknown {
  let cursor: unknown = root;
  for (const key of keys) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor) || !(key in cursor)) {
      return undefined;
    }
    cursor = Object.getOwnPropertyDescriptor(cursor, key)?.value;
  }
  return cursor;
}

function makeOpenAIConfig(
  models: Record<string, OpenAICompatibleModelDefinition>,
  baseUrl = 'https://api.example.com/v1',
): LLMProviderConfig {
  return {
    apiKey: 'secret',
    enabled: true,
    driverKind: 'openai-compatible',
    openaiCompatible: {
      schemaVersion: 1,
      displayName: 'OpenAI Compatible',
      baseUrl,
      models,
    },
  };
}

function makeResponsesConfig(
  models: Record<string, OpenAICompatibleModelDefinition>,
  baseUrl = 'https://api.example.com',
): LLMProviderConfig {
  return {
    apiKey: 'secret',
    enabled: true,
    driverKind: 'responses-compatible',
    responsesCompatible: {
      schemaVersion: 1,
      displayName: 'Responses Compatible',
      baseUrl,
      stateMode: 'stateless',
      authMode: 'bearer',
      models,
    },
  };
}

function makeAnthropicConfig(
  models: Record<string, OpenAICompatibleModelDefinition>,
  baseUrl = 'https://api.example.com',
): LLMProviderConfig {
  return {
    apiKey: 'secret',
    enabled: true,
    driverKind: 'anthropic-compatible',
    anthropicCompatible: {
      schemaVersion: 1,
      displayName: 'Anthropic Compatible',
      baseUrl,
      authMode: 'x-api-key',
      models,
    },
  };
}

function makeAntigravityConfig(
  models: Record<string, OpenAICompatibleModelDefinition>,
  wireProtocol: 'auto' | 'v1beta' | 'messages' = 'auto',
  baseUrl = 'https://gw.example.com/antigravity',
): LLMProviderConfig {
  return {
    apiKey: 'secret',
    enabled: true,
    driverKind: 'antigravity-compatible',
    antigravityCompatible: {
      schemaVersion: 1,
      displayName: 'Antigravity Compatible',
      baseUrl,
      wireProtocol,
      authMode: 'both',
      models,
    },
  };
}

beforeEach(() => {
  __setRequestUrlMock(async () => jsonResponse(500, { error: { message: 'Unexpected requestUrl call' } }));
  syncCompatibleWireProtocols();
});

afterEach(() => {
  syncCompatibleWireProtocols();
});

describe('Passive thinking metadata extraction and model discovery', () => {
  it('extracts CPA/LiteLLM reasoning levels, non-thinking flags, Gemini thinking flags, and bare models', () => {
    expect(readReportedThinkingMetadata({
      id: 'gpt-5.4',
      reasoning: true,
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'],
    })).toEqual({
      supportsThinking: true,
      thinkingEfforts: ['low', 'medium', 'high', 'xhigh'],
    });

    const disabledMeta = readReportedThinkingMetadata({
      id: 'text-only',
      reasoning: false,
      supported_reasoning_levels: ['high'],
    });
    expect(disabledMeta).toEqual({ supportsThinking: false });
    expect(disabledMeta).not.toHaveProperty('thinkingEfforts');

    expect(readReportedThinkingMetadata({
      name: 'models/gemini-4-carbon',
      thinking: true,
    })).toEqual({ supportsThinking: true });

    expect(readReportedThinkingMetadata({
      name: 'models/gemini-2.0-flash',
      thinking: false,
    })).toEqual({ supportsThinking: false });

    const bare = readReportedThinkingMetadata({ id: 'plain-model' });
    expect(bare).toEqual({});
    expect(Object.keys(bare)).toEqual([]);
  });

  it('normalizes synonym effort tokens and supported parameter lists', () => {
    expect(readReportedThinkingMetadata({
      id: 'alias-model',
      metadata: {
        thinking: {
          levels: ['extra-high', 'med', 'minimal', 'maximum', 'low'],
        },
      },
    })).toEqual({
      supportsThinking: true,
      thinkingEfforts: ['low', 'medium', 'xhigh', 'max'],
    });

    expect(readReportedThinkingMetadata({
      id: 'param-model',
      supported_openai_params: ['temperature', 'reasoning_effort'],
    })).toEqual({ supportsThinking: true });
  });

  it('discovers thinking metadata in OpenAI-compatible /models without adding extra keys to bare entries', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(200, {
        data: [
          {
            id: 'gpt-5.4',
            context_length: 1_050_000,
            reasoning: true,
            supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'],
          },
          {
            id: 'text-only',
            reasoning: false,
            supported_reasoning_levels: ['high'],
          },
          { id: 'plain-model' },
        ],
      });
    });

    const discovered = await discoverOpenAICompatibleModels('https://api.example.com/v1', 'secret');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'GET', url: 'https://api.example.com/v1/models' });
    expect(discovered).toEqual([
      {
        id: 'gpt-5.4',
        contextWindow: 1_050_000,
        supportsThinking: true,
        thinkingEfforts: ['low', 'medium', 'high', 'xhigh'],
      },
      {
        id: 'text-only',
        supportsThinking: false,
      },
      { id: 'plain-model' },
    ]);
    expect(Object.keys(discovered[1])).toEqual(['id', 'supportsThinking']);
    expect(Object.keys(discovered[2])).toEqual(['id']);
  });

  it('discovers thinking metadata across Responses-compatible and Anthropic-compatible endpoints', async () => {
    __setRequestUrlMock(async request => {
      if (request.url === 'https://responses.example.com/v1/models') {
        return jsonResponse(200, {
          data: [
            { id: 'gpt-5.4', reasoning: true, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'] },
            { id: 'text-only', reasoning: false },
            { id: 'plain-model' },
          ],
        });
      }
      return jsonResponse(200, {
        data: [
          { id: 'claude-custom', max_input_tokens: 200_000, thinking: { supported: true, efforts: ['low', 'high', 'max'] } },
          { id: 'plain-claude' },
        ],
      });
    });

    const responsesModels = await discoverResponsesCompatibleModels('https://responses.example.com', 'secret');
    expect(responsesModels).toEqual([
      { id: 'gpt-5.4', supportsThinking: true, thinkingEfforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'text-only', supportsThinking: false },
      { id: 'plain-model' },
    ]);
    expect(Object.keys(responsesModels[2])).toEqual(['id']);

    const anthropicModels = await discoverAnthropicCompatibleModels('https://anthropic.example.com', 'secret');
    expect(anthropicModels).toEqual([
      { id: 'claude-custom', contextWindow: 200_000, supportsThinking: true, thinkingEfforts: ['low', 'high', 'max'] },
      { id: 'plain-claude' },
    ]);
    expect(Object.keys(anthropicModels[1])).toEqual(['id']);
  });

  it('discovers Gemini /v1beta/models and merges thinking metadata across Antigravity routes', async () => {
    __setRequestUrlMock(async request => {
      if (request.url === 'https://gw.example.com/antigravity/v1beta/models') {
        return jsonResponse(200, {
          models: [
            { name: 'models/gemini-4-carbon', thinking: true, inputTokenLimit: 1_048_576 },
            { name: 'models/gemini-2.0-flash', thinking: false },
            { name: 'models/shared-model' },
          ],
        });
      }
      return jsonResponse(200, {
        data: [
          {
            id: 'shared-model',
            context_length: 200_000,
            reasoning: true,
            supported_reasoning_levels: ['low', 'high'],
          },
          { id: 'plain-model' },
        ],
      });
    });

    const discovered = await discoverAntigravityCompatibleModels('https://gw.example.com/antigravity', 'secret', 'auto');
    expect(discovered).toEqual([
      { id: 'gemini-4-carbon', contextWindow: 1_048_576, supportsThinking: true },
      { id: 'gemini-2.0-flash', supportsThinking: false },
      { id: 'shared-model', contextWindow: 200_000, supportsThinking: true, thinkingEfforts: ['low', 'high'] },
      { id: 'plain-model' },
    ]);
    expect(Object.keys(discovered[3])).toEqual(['id']);
  });

  it('describes server-reported and probed thinking capabilities cleanly', () => {
    expect(describeThinkingCapability(undefined)).toBeNull();
    expect(describeThinkingCapability({ source: 'manual' })).toBeNull();
    expect(describeThinkingCapability({ source: 'discovered', reportedSupportsThinking: false }))
      .toBe('Thinking: not supported (server reported).');
    expect(describeThinkingCapability({
      source: 'discovered',
      reportedSupportsThinking: true,
      reportedThinkingEfforts: ['low', 'medium', 'high'],
      probedSupportsThinking: true,
      probedThinkingEfforts: ['low', 'high'],
      probedThinkingMode: 'level',
    })).toBe('Thinking tiers: low, high (probed).');
  });
});

describe('Active thinking-tier probing across all 4 protocols', () => {
  describe('probeOpenAICompatibleModelThinking', () => {
    it('returns accepted effort tiers when sentinel rejects and xhigh/max reject', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        const effort = String(readNested(parseBody(request), 'reasoning_effort') ?? '');
        if (effort === '__nexus_probe_invalid__' || effort === 'xhigh' || effort === 'max') {
          return jsonResponse(400, { error: { message: `Invalid reasoning_effort: ${effort}` } });
        }
        return jsonResponse(200, { choices: [{ message: { content: 'OK' } }] });
      });

      const result = await probeOpenAICompatibleModelThinking({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret',
        model: 'custom-reasoner',
      });

      expect(result).toEqual({ kind: 'supported', efforts: ['low', 'medium', 'high'], mode: 'effort' });
      expect(requests).toHaveLength(6);
      expect(requests[0]).toMatchObject({
        method: 'POST',
        url: 'https://api.example.com/v1/chat/completions',
        headers: { Authorization: 'Bearer secret' },
      });
      expect(parseBody(requests[0])).toMatchObject({
        model: 'custom-reasoner',
        max_tokens: 16,
        stream: false,
        reasoning_effort: '__nexus_probe_invalid__',
      });
    });

    it('returns unsupported when a permissive server returns 200 on sentinel with no reasoning', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return jsonResponse(200, { choices: [{ message: { content: 'OK' } }] });
      });

      const result = await probeOpenAICompatibleModelThinking({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret',
        model: 'permissive-plain',
      });

      expect(result.kind).toBe('unsupported');
      expect(requests).toHaveLength(1);
    });

    it('returns medium effort when a permissive server returns 200 on sentinel with reasoning_content', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return jsonResponse(200, {
          choices: [{ message: { content: 'OK', reasoning_content: 'step 1' } }],
        });
      });

      const result = await probeOpenAICompatibleModelThinking({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret',
        model: 'permissive-thinker',
      });

      expect(result).toEqual({ kind: 'supported', efforts: ['medium'], mode: 'effort' });
      expect(requests).toHaveLength(1);
    });

    it('returns failed on non-validation HTTP errors', async () => {
      __setRequestUrlMock(async () => jsonResponse(500, { error: { message: 'Gateway down' } }));

      const result = await probeOpenAICompatibleModelThinking({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret',
        model: 'broken-model',
      });

      expect(result).toEqual({ kind: 'failed', message: 'HTTP 500: Gateway down' });
    });
  });

  describe('probeResponsesCompatibleModelThinking', () => {
    it('detects supported effort tiers when sentinel and max return 400', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        const effort = String(readNested(parseBody(request), 'reasoning', 'effort') ?? '');
        if (effort === '__nexus_probe_invalid__' || effort === 'max') {
          return jsonResponse(400, { error: { message: `Unsupported effort: ${effort}` } });
        }
        return jsonResponse(200, { id: 'resp_1', status: 'completed', output: [] });
      });

      const result = await probeResponsesCompatibleModelThinking({
        baseUrl: 'https://api.example.com',
        apiKey: 'secret',
        stateMode: 'stateless',
        authMode: 'bearer',
        model: 'gpt-5.4',
      });

      expect(result).toEqual({ kind: 'supported', efforts: ['low', 'medium', 'high', 'xhigh'], mode: 'effort' });
      expect(requests[0].url).toBe('https://api.example.com/v1/responses');
      expect(parseBody(requests[0])).toMatchObject({
        model: 'gpt-5.4',
        store: false,
        stream: false,
        reasoning: { effort: '__nexus_probe_invalid__', summary: 'auto' },
      });
    });

    it('falls back from stream:false 400 to stream:true SSE for Codex-style endpoints', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        const body = parseBody(request);
        if (body.stream === false) {
          return jsonResponse(400, { error: { message: 'Stream must be set to true' } });
        }
        const effort = String(readNested(parseBody(request), 'reasoning', 'effort') ?? '');
        if (effort === '__nexus_probe_invalid__') {
          return sseResponse(sse({
            type: 'response.failed',
            response: { error: { message: 'Invalid reasoning.effort' } },
          }));
        }
        if (effort === 'max') {
          return sseResponse(sse({
            type: 'error',
            message: 'Unsupported effort: max',
          }));
        }
        return sseResponse(sse({
          type: 'response.completed',
          response: { id: 'resp_sse', status: 'completed', output: [] },
        }));
      });

      const result = await probeResponsesCompatibleModelThinking({
        baseUrl: 'https://gw.example.com/backend-api/codex',
        apiKey: 'secret',
        stateMode: 'stateful',
        authMode: 'x-api-key',
        model: 'gpt-5.4',
      });

      expect(result).toEqual({ kind: 'supported', efforts: ['low', 'medium', 'high', 'xhigh'], mode: 'effort' });
      expect(requests.some(req => parseBody(req).stream === false)).toBe(true);
      expect(requests.some(req => parseBody(req).stream === true)).toBe(true);
      expect(requests[0].url).toBe('https://gw.example.com/backend-api/codex/responses');
      expect(requests[0].headers?.['x-api-key']).toBe('secret');
      expect(parseBody(requests[0])).not.toHaveProperty('store');
    });

    it('detects reasoning emitted on permissive Codex SSE sentinel responses', async () => {
      __setRequestUrlMock(async request => {
        const body = parseBody(request);
        if (body.stream === false) {
          return jsonResponse(400, { detail: 'stream must be true' });
        }
        return sseResponse(sse(
          { type: 'response.reasoning_summary_text.delta', delta: 'thinking...' },
          { type: 'response.completed', response: { id: 'resp_sse', status: 'completed', output: [] } },
        ));
      });

      const result = await probeResponsesCompatibleModelThinking({
        baseUrl: 'https://api.example.com',
        apiKey: 'secret',
        model: 'codex-permissive',
      });

      expect(result).toEqual({ kind: 'supported', efforts: ['medium'], mode: 'effort' });
    });
  });

  describe('probeAnthropicCompatibleModelThinking', () => {
    it('detects adaptive thinking tiers when xhigh and sentinel reject', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        const effort = String(readNested(parseBody(request), 'output_config', 'effort') ?? '');
        if (effort === '__nexus_probe_invalid__' || effort === 'xhigh') {
          return jsonResponse(400, { error: { message: `Unsupported effort: ${effort}` } });
        }
        return jsonResponse(200, { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' });
      });

      const result = await probeAnthropicCompatibleModelThinking({
        baseUrl: 'https://api.example.com',
        apiKey: 'secret',
        model: 'custom-claude-next',
      });

      expect(result).toEqual({
        kind: 'supported',
        efforts: ['low', 'medium', 'high', 'max'],
        mode: 'adaptive',
      });
      expect(requests[0].url).toBe('https://api.example.com/v1/messages');
      expect(parseBody(requests[0])).toMatchObject({
        model: 'custom-claude-next',
        max_tokens: 32,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      });
    });

    it('falls back to manual budget_tokens probing when adaptive thinking returns 400', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        const thinking = readNested(parseBody(request), 'thinking');
        if (readNested(thinking, 'type') === 'adaptive') {
          return jsonResponse(400, { error: { message: 'Adaptive thinking is not supported' } });
        }
        if (readNested(thinking, 'type') === 'enabled' && readNested(thinking, 'budget_tokens') === 1024) {
          return jsonResponse(200, { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' });
        }
        return jsonResponse(400, { error: { message: 'Unexpected probe body' } });
      });

      const result = await probeAnthropicCompatibleModelThinking({
        baseUrl: 'https://api.example.com',
        apiKey: 'secret',
        model: 'custom-claude-budget',
      });

      expect(result).toEqual({
        kind: 'supported',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        mode: 'budget',
      });
      expect(requests).toHaveLength(2);
      expect(parseBody(requests[1])).toMatchObject({
        max_tokens: 1056,
        thinking: { type: 'enabled', budget_tokens: 1024 },
      });
    });

    it('returns unsupported when both adaptive and manual budget probes return 400', async () => {
      __setRequestUrlMock(async () => jsonResponse(400, { error: { message: 'Thinking not supported' } }));

      const result = await probeAnthropicCompatibleModelThinking({
        baseUrl: 'https://api.example.com',
        apiKey: 'secret',
        model: 'plain-claude',
      });

      expect(result.kind).toBe('unsupported');
    });
  });

  describe('probeAntigravityCompatibleModelThinking', () => {
    it('detects Gemini v1beta thinkingLevel tiers when only low and high are accepted', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        const level = readNested(parseBody(request), 'generationConfig', 'thinkingConfig', 'thinkingLevel');
        if (level === 'low' || level === 'high') {
          return jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] });
        }
        return jsonResponse(400, { error: { message: `Unsupported thinkingLevel: ${level}` } });
      });

      const result = await probeAntigravityCompatibleModelThinking({
        baseUrl: 'https://gw.example.com/antigravity',
        apiKey: 'secret',
        wireProtocol: 'auto',
        model: 'gemini-3-pro-preview',
      });

      expect(result).toEqual({ kind: 'supported', efforts: ['low', 'high'], mode: 'level' });
      expect(requests[0].url).toBe('https://gw.example.com/antigravity/v1beta/models/gemini-3-pro-preview:generateContent');
    });

    it('falls back to Gemini thinkingBudget when thinkingLevel returns 400', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        const thinkingConfig = readNested(parseBody(request), 'generationConfig', 'thinkingConfig');
        if (readNested(thinkingConfig, 'thinkingLevel') !== undefined) {
          return jsonResponse(400, { error: { message: 'Unknown field thinkingLevel' } });
        }
        if (readNested(thinkingConfig, 'thinkingBudget') === 1024) {
          return jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] });
        }
        return jsonResponse(400, { error: { message: 'Unsupported' } });
      });

      const result = await probeAntigravityCompatibleModelThinking({
        baseUrl: 'https://gw.example.com/antigravity',
        apiKey: 'secret',
        wireProtocol: 'v1beta',
        model: 'gemini-2.5-pro',
      });

      expect(result).toEqual({ kind: 'supported', efforts: ['low', 'medium', 'high'], mode: 'budget' });
      expect(requests).toHaveLength(2);
      expect(parseBody(requests[1])).toMatchObject({
        generationConfig: {
          maxOutputTokens: 1056,
          thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
        },
      });
    });

    it('routes Claude models on Antigravity auto/messages to the /v1/messages probe', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        if (readNested(parseBody(request), 'output_config', 'effort') === '__nexus_probe_invalid__') {
          return jsonResponse(400, { error: { message: 'Invalid effort' } });
        }
        return jsonResponse(200, { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' });
      });

      const result = await probeAntigravityCompatibleModelThinking({
        baseUrl: 'https://gw.example.com/antigravity',
        apiKey: 'secret',
        wireProtocol: 'auto',
        model: 'claude-opus-5-5',
      });

      expect(result).toEqual({
        kind: 'supported',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        mode: 'adaptive',
      });
      expect(requests[0].url).toBe('https://gw.example.com/antigravity/v1/messages');
    });
  });
});

describe('Runtime UI capabilities, thinking levels, and adapter enforcement', () => {
  it('syncs discovered and probed capabilities into UI capabilities, supported levels, and clamping across all 4 protocols', () => {
    const registry = StaticModelsService.getInstance();

    syncCompatibleWireProtocols({
      'openai-compatible-1': makeOpenAIConfig({
        unprobed: { source: 'manual' },
        'reported-off': { source: 'discovered', reportedSupportsThinking: false },
        'probed-off-over-reported': {
          source: 'discovered',
          reportedSupportsThinking: true,
          reportedThinkingEfforts: ['low', 'high'],
          probedSupportsThinking: false,
        },
        'probed-lmh': {
          source: 'discovered',
          probedSupportsThinking: true,
          probedThinkingEfforts: ['low', 'medium', 'high'],
          probedThinkingMode: 'effort',
        },
      }),
      'responses-compatible-1': makeResponsesConfig({
        'gpt-5.4': {
          source: 'discovered',
          probedSupportsThinking: false,
        },
        'codex-probed': {
          source: 'discovered',
          probedSupportsThinking: true,
          probedThinkingEfforts: ['low', 'medium', 'high', 'xhigh'],
          probedThinkingMode: 'effort',
        },
        'custom-unprobed': { source: 'manual' },
      }),
      'anthropic-compatible-1': makeAnthropicConfig({
        'custom-claude-next': {
          source: 'discovered',
          probedSupportsThinking: true,
          probedThinkingEfforts: ['low', 'medium', 'high', 'max'],
          probedThinkingMode: 'adaptive',
        },
        'claude-no-think': {
          source: 'discovered',
          probedSupportsThinking: false,
        },
      }),
      'antigravity-compatible-1': makeAntigravityConfig({
        'gemini-4-carbon': {
          source: 'discovered',
          reportedSupportsThinking: false,
        },
        'gemini-lh': {
          source: 'discovered',
          probedSupportsThinking: true,
          probedThinkingEfforts: ['low', 'high'],
          probedThinkingMode: 'level',
        },
      }),
    });

    expect(ThinkingEffortMapper.providerSupportsThinking('openai-compatible-1')).toBe(true);

    // Unprobed OpenAI-compatible returns undefined so UI hides Thinking until discovered/probed.
    expect(getStaticModelCapabilities(registry, 'openai-compatible-1', 'unprobed')).toBeUndefined();
    expect(getStaticModelCapabilities(registry, 'openai-compatible-1', 'reported-off')).toMatchObject({ supportsThinking: false });
    expect(getStaticModelCapabilities(registry, 'openai-compatible-1', 'probed-off-over-reported')).toMatchObject({ supportsThinking: false });
    expect(getStaticModelCapabilities(registry, 'openai-compatible-1', 'probed-lmh')).toMatchObject({ supportsThinking: true });
    expect(getSupportedThinkingEfforts('openai-compatible-1', 'probed-lmh')).toEqual(['low', 'medium', 'high']);
    expect(normalizeThinkingEffortForModel('openai-compatible-1', 'probed-lmh', 'max')).toBe('high');

    // Responses-compatible: probed false hides Thinking even on a known registry ID.
    expect(getStaticModelCapabilities(registry, 'responses-compatible-1', 'gpt-5.4')).toMatchObject({ supportsThinking: false });
    expect(getStaticModelCapabilities(registry, 'responses-compatible-1', 'custom-unprobed')).toMatchObject({ supportsThinking: false });
    expect(getStaticModelCapabilities(registry, 'responses-compatible-1', 'codex-probed')).toMatchObject({ supportsThinking: true });
    expect(getSupportedThinkingEfforts('responses-compatible-1', 'codex-probed')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(normalizeThinkingEffortForModel('responses-compatible-1', 'codex-probed', 'max')).toBe('xhigh');

    // Anthropic-compatible: custom model unlocked with adaptive tiers.
    expect(getStaticModelCapabilities(registry, 'anthropic-compatible-1', 'claude-no-think')).toMatchObject({ supportsThinking: false });
    expect(getStaticModelCapabilities(registry, 'anthropic-compatible-1', 'custom-claude-next')).toMatchObject({ supportsThinking: true });
    expect(getSupportedThinkingEfforts('anthropic-compatible-1', 'custom-claude-next')).toEqual(['low', 'medium', 'high', 'max']);
    expect(normalizeThinkingEffortForModel('anthropic-compatible-1', 'custom-claude-next', 'xhigh')).toBe('high');

    // Antigravity-compatible: reported false hides Thinking; probed level tiers clamp intermediate/max levels.
    expect(getStaticModelCapabilities(registry, 'antigravity-compatible-1', 'gemini-4-carbon')).toMatchObject({ supportsThinking: false });
    expect(getStaticModelCapabilities(registry, 'antigravity-compatible-1', 'gemini-lh')).toMatchObject({ supportsThinking: true });
    expect(getSupportedThinkingEfforts('antigravity-compatible-1', 'gemini-lh')).toEqual(['low', 'high']);
    expect(normalizeThinkingEffortForModel('antigravity-compatible-1', 'gemini-lh', 'max')).toBe('high');
    expect(normalizeThinkingEffortForModel('antigravity-compatible-1', 'gemini-lh', 'medium')).toBe('low');

    // ModelInfo builders reflect resolved supportsThinking across all 4 protocols.
    expect(buildOpenAICompatibleModels(makeOpenAIConfig({
      a: { source: 'discovered', probedSupportsThinking: false },
      b: { source: 'discovered', probedSupportsThinking: true },
    })).map(m => [m.id, m.supportsThinking])).toEqual([['a', false], ['b', true]]);

    expect(buildResponsesCompatibleModels(makeResponsesConfig({
      a: { source: 'discovered', reportedSupportsThinking: false },
      b: { source: 'manual' },
    })).map(m => [m.id, m.supportsThinking])).toEqual([['a', false], ['b', true]]);

    expect(buildAnthropicCompatibleModels(makeAnthropicConfig({
      a: { source: 'discovered', probedSupportsThinking: false },
      b: { source: 'discovered', probedSupportsThinking: true },
    })).map(m => [m.id, m.supportsThinking])).toEqual([['a', false], ['b', true]]);

    expect(buildAntigravityCompatibleModels(makeAntigravityConfig({
      a: { source: 'discovered', reportedSupportsThinking: false },
      b: { source: 'discovered', probedSupportsThinking: true },
    })).map(m => [m.id, m.supportsThinking])).toEqual([['a', false], ['b', true]]);
  });

  it('OpenAICompatibleAdapter sends clamped reasoning_effort when enabled and omits it when disabled by probe/metadata', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      const body = parseBody(request);
      if (body.stream === true) {
        return sseResponse(sse(
          { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
          '[DONE]',
        ));
      }
      return jsonResponse(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    });

    const adapter = new OpenAICompatibleAdapter(
      makeOpenAIConfig({
        clamped: {
          source: 'discovered',
          probedSupportsThinking: true,
          probedThinkingEfforts: ['low', 'medium', 'high'],
          probedThinkingMode: 'effort',
        },
        'probed-off': {
          source: 'discovered',
          probedSupportsThinking: false,
        },
        'reported-off': {
          source: 'discovered',
          reportedSupportsThinking: false,
        },
      }),
      'openai-compatible-test',
    );

    await adapter.generateUncached('hi', { model: 'clamped', enableThinking: true, thinkingEffort: 'max' });
    await adapter.generateUncached('hi', { model: 'clamped', enableThinking: false, thinkingEffort: 'high' });
    await adapter.generateUncached('hi', { model: 'probed-off', enableThinking: true, thinkingEffort: 'high' });
    await adapter.generateUncached('hi', { model: 'reported-off', enableThinking: true, thinkingEffort: 'high' });
    await collect(adapter.generateStreamAsync('hi', { model: 'clamped', enableThinking: true, thinkingEffort: 'xhigh' }));
    await collect(adapter.generateStreamAsync('hi', { model: 'probed-off', enableThinking: true, thinkingEffort: 'high' }));

    expect(parseBody(requests[0]).reasoning_effort).toBe('high');
    expect(parseBody(requests[1])).not.toHaveProperty('reasoning_effort');
    expect(parseBody(requests[2])).not.toHaveProperty('reasoning_effort');
    expect(parseBody(requests[3])).not.toHaveProperty('reasoning_effort');
    expect(parseBody(requests[4]).reasoning_effort).toBe('high');
    expect(parseBody(requests[5])).not.toHaveProperty('reasoning_effort');
  });

  it('AnthropicCompatibleAdapter honors probedThinkingMode adaptive and budget on custom and registry models', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(200, {
        model: parseBody(request).model,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      });
    });

    const adapter = new AnthropicCompatibleAdapter(
      makeAnthropicConfig({
        'custom-claude-next': {
          source: 'discovered',
          probedSupportsThinking: true,
          probedThinkingEfforts: ['low', 'medium', 'high', 'max'],
          probedThinkingMode: 'adaptive',
        },
        'custom-budget-claude': {
          source: 'discovered',
          probedSupportsThinking: true,
          probedThinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          probedThinkingMode: 'budget',
        },
        'claude-opus-4-6': {
          source: 'discovered',
          probedSupportsThinking: true,
          probedThinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          probedThinkingMode: 'budget',
        },
        'disabled-claude': {
          source: 'discovered',
          probedSupportsThinking: false,
        },
      }),
      'anthropic-compatible-test',
    );

    // Custom model ID probed as adaptive sends adaptive + clamped output_config.effort.
    await adapter.generateUncached('hi', {
      model: 'custom-claude-next',
      enableThinking: true,
      thinkingEffort: 'xhigh',
      temperature: 0.7,
    });
    const adaptiveReq = parseBody(requests[0]);
    expect(adaptiveReq.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(adaptiveReq.output_config).toEqual({ effort: 'high' });
    expect(adaptiveReq).not.toHaveProperty('temperature');

    // Custom model ID probed as budget sends manual budget_tokens.
    await adapter.generateUncached('hi', {
      model: 'custom-budget-claude',
      enableThinking: true,
      thinkingEffort: 'high',
    });
    const customBudgetReq = parseBody(requests[1]);
    expect(customBudgetReq.thinking).toEqual({ type: 'enabled', budget_tokens: 32_000 });
    expect(customBudgetReq).not.toHaveProperty('output_config');
    expect(customBudgetReq.max_tokens).toBe(33_024);

    // Known adaptive model ID overridden to budget when probed as manual budget.
    await adapter.generateUncached('hi', {
      model: 'claude-opus-4-6',
      enableThinking: true,
      thinkingEffort: 'high',
    });
    const overriddenBudgetReq = parseBody(requests[2]);
    expect(overriddenBudgetReq.thinking).toEqual({ type: 'enabled', budget_tokens: 32_000 });
    expect(overriddenBudgetReq).not.toHaveProperty('output_config');

    // Probed-false model omits thinking completely.
    await adapter.generateUncached('hi', {
      model: 'disabled-claude',
      enableThinking: true,
      thinkingEffort: 'high',
    });
    const disabledReq = parseBody(requests[3]);
    expect(disabledReq).not.toHaveProperty('thinking');
    expect(disabledReq).not.toHaveProperty('output_config');
  });

  it('ResponsesCompatibleAdapter and AntigravityCompatibleAdapter enforce probed tiers and disable flags on the wire', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      if (request.url?.includes('/responses')) {
        return jsonResponse(200, {
          id: 'resp_1',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        });
      }
      if (request.url?.includes(':streamGenerateContent')) {
        return sseResponse(sse({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        }));
      }
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });
    });

    const responsesAdapter = new ResponsesCompatibleAdapter(
      makeResponsesConfig({
        'gpt-5.4': {
          source: 'discovered',
          probedSupportsThinking: true,
          probedThinkingEfforts: ['low', 'medium', 'high', 'xhigh'],
          probedThinkingMode: 'effort',
        },
        'probed-off': {
          source: 'discovered',
          probedSupportsThinking: false,
        },
      }),
      'responses-compatible-test',
    );

    await responsesAdapter.generateUncached('hi', { model: 'gpt-5.4', enableThinking: true, thinkingEffort: 'max' });
    await responsesAdapter.generateUncached('hi', { model: 'probed-off', enableThinking: true, thinkingEffort: 'high' });

    expect(parseBody(requests[0]).reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
    expect(parseBody(requests[1])).not.toHaveProperty('reasoning');

    const antigravityAdapter = new AntigravityCompatibleAdapter(
      makeAntigravityConfig({
        'custom-gemini-next': {
          source: 'discovered',
          probedSupportsThinking: true,
          probedThinkingEfforts: ['low', 'high'],
          probedThinkingMode: 'level',
        },
        'gemini-4-carbon': {
          source: 'discovered',
          probedSupportsThinking: true,
          probedThinkingEfforts: ['low', 'medium', 'high'],
          probedThinkingMode: 'budget',
        },
        'gemini-disabled': {
          source: 'discovered',
          probedSupportsThinking: false,
        },
      }, 'v1beta'),
      'antigravity-compatible-test',
    );

    await antigravityAdapter.generateUncached('hi', {
      model: 'custom-gemini-next',
      enableThinking: true,
      thinkingEffort: 'max',
    });
    expect(parseBody(requests[2])).toMatchObject({
      generationConfig: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
      },
    });

    await antigravityAdapter.generateUncached('hi', {
      model: 'gemini-4-carbon',
      enableThinking: true,
      thinkingEffort: 'max',
    });
    expect(parseBody(requests[3])).toMatchObject({
      generationConfig: {
        thinkingConfig: { includeThoughts: true, thinkingBudget: 24_576 },
      },
    });
    const budgetThinkingConfig = readNested(parseBody(requests[3]), 'generationConfig', 'thinkingConfig');
    expect(budgetThinkingConfig).toBeDefined();
    expect(budgetThinkingConfig).not.toHaveProperty('thinkingLevel');

    await collect(antigravityAdapter.generateStreamAsync('hi', {
      model: 'gemini-disabled',
      enableThinking: true,
      thinkingEffort: 'high',
    }));
    const disabledGenConfig = readNested(parseBody(requests[4]), 'generationConfig');
    expect(disabledGenConfig).toBeDefined();
    expect(disabledGenConfig).not.toHaveProperty('thinkingConfig');
  });
});
