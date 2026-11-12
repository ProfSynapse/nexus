/**
 * Issue #439: OpenAI-compatible models were stuck at 4,096 tokens of context.
 * Covers where the context window comes from (user, server report, default),
 * that the chat limit can now reach it, and the opt-in Check request.
 *
 * Fake servers mimic each runtime's real wire shape, including the part that
 * matters: vLLM's refusal sentence, llama.cpp's error object with `n_ctx`, and
 * Ollama-style silent truncation. Their tokenizer deliberately differs from the
 * check's built-in assumption, so a passing "fits" proves calibration ran.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';
jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'), hasNodeRuntime: () => false,
}));
import type { LLMProviderConfig } from '../../src/types';
import type { OpenAICompatibleModelDefinition } from '../../src/types/llm/ProviderTypes';
import { OpenAICompatibleAdapter } from '../../src/services/llm/adapters/openai-compatible/OpenAICompatibleAdapter';
import {
  buildOpenAICompatibleModels, discoverOpenAICompatibleModels, readReportedContextWindow,
  releaseRaisedContextOverrides, resolveOpenAICompatibleContextWindow,
} from '../../src/services/llm/adapters/openai-compatible/OpenAICompatibleConfig';
import {
  checkOpenAICompatibleContextWindow, readContextLimitFromError,
} from '../../src/services/llm/adapters/openai-compatible/OpenAICompatibleContextCheck';
import { CompatibleEndpointConfig, OpenAICompatibleEditSession } from '../../src/components/openai-compatible/OpenAICompatibleEditSession';
import { describeContextCheck, describeContextWindow } from '../../src/components/openai-compatible/OpenAICompatibleModal';
import { getContextWindowOverrideKey, resolveContextWindowLimit } from '../../src/ui/chat/utils/ContextWindowSettings';
import { jsonResponse, type CapturedRequest } from './helpers/llmAdapterTestHarness';

function endpoint(models: Record<string, OpenAICompatibleModelDefinition>): CompatibleEndpointConfig {
  return {
    apiKey: '', enabled: true, driverKind: 'openai-compatible', models: {},
    openaiCompatible: { schemaVersion: 1, displayName: 'Gateway', baseUrl: 'https://gateway.example/v1', models },
  };
}

describe('context window source', () => {
  test('the user value wins, then the server report, then 4,096', () => {
    expect(resolveOpenAICompatibleContextWindow({ source: 'manual', contextWindow: 32_768, reportedContextWindow: 131_072 }))
      .toEqual({ contextWindow: 32_768, source: 'user' });
    expect(resolveOpenAICompatibleContextWindow({ source: 'discovered', reportedContextWindow: 131_072 }))
      .toEqual({ contextWindow: 131_072, source: 'server' });
    expect(resolveOpenAICompatibleContextWindow({ source: 'manual' })).toEqual({ contextWindow: 4096, source: 'default' });
    expect(resolveOpenAICompatibleContextWindow(undefined)).toEqual({ contextWindow: 4096, source: 'default' });
  });

  test('a corrupt saved value falls through instead of breaking the endpoint', () => {
    for (const bad of [0, -5, 1.5, Number.NaN, 10 ** 12, '131072' as unknown as number]) {
      expect(resolveOpenAICompatibleContextWindow({ source: 'manual', contextWindow: bad }).source).toBe('default');
    }
  });

  test('the reported #439 case: a 128k model can now be given a 100k chat limit', () => {
    const config = endpoint({ 'qwen-128k': { source: 'manual', contextWindow: 131_072 } });
    const [model] = buildOpenAICompatibleModels(config);
    expect(model.contextWindow).toBe(131_072);
    // The chat slider clamps overrides to the model's window; before the fix that was 4,096.
    expect(resolveContextWindowLimit(model.contextWindow, 100_000)).toBe(100_000);
  });

  test('the adapter advertises its largest saved model', () => {
    const config = endpoint({
      small: { source: 'manual' },
      large: { source: 'discovered', reportedContextWindow: 262_144 },
    }) as LLMProviderConfig;
    expect(new OpenAICompatibleAdapter(config, 'endpoint-a').getCapabilities().maxContextWindow).toBe(262_144);
  });
});

describe('chat overrides saved at the old ceiling', () => {
  const key = (model: string) => getContextWindowOverrideKey('endpoint-a', model);

  test('raising a window frees overrides pinned at the old maximum and keeps deliberate ones', () => {
    const before = endpoint({ pinned: { source: 'manual' }, chosen: { source: 'manual' }, other: { source: 'manual' } });
    const after = endpoint({
      pinned: { source: 'manual', contextWindow: 131_072 },
      chosen: { source: 'manual', contextWindow: 131_072 },
      other: { source: 'manual' },
    });
    // What ChatSettingsModal writes on save: the whole 4,096 window, or a smaller choice.
    const chat = { [key('pinned')]: 4096, [key('chosen')]: 2048, [key('other')]: 4096, [getContextWindowOverrideKey('anthropic', 'pinned')]: 4096 };
    const agent = { [key('pinned')]: 4096 };
    const released = releaseRaisedContextOverrides('endpoint-a', before, after, [chat, agent, undefined]);
    expect(chat).toEqual({ [key('chosen')]: 2048, [key('other')]: 4096, [getContextWindowOverrideKey('anthropic', 'pinned')]: 4096 });
    expect(agent).toEqual({});
    // A failed save restores exactly what was removed.
    for (const { map, key: entry, value } of released) map[entry] = value;
    expect(chat[key('pinned')]).toBe(4096);
    expect(agent[key('pinned')]).toBe(4096);
  });

  test('lowering a window or adding a model leaves overrides alone', () => {
    const before = endpoint({ a: { source: 'discovered', reportedContextWindow: 32_768 } });
    const after = endpoint({ a: { source: 'discovered', contextWindow: 16_384, reportedContextWindow: 32_768 }, b: { source: 'manual', contextWindow: 65_536 } });
    const chat = { [key('a')]: 32_768, [key('b')]: 4096 };
    expect(releaseRaisedContextOverrides('endpoint-a', before, after, [chat])).toEqual([]);
    expect(releaseRaisedContextOverrides('endpoint-a', undefined, after, [chat])).toEqual([]);
    expect(chat).toEqual({ [key('a')]: 32_768, [key('b')]: 4096 });
  });
});

describe('reading what servers report', () => {
  test.each([
    ['vLLM / SGLang', { id: 'm', max_model_len: 32_768 }, 32_768],
    ['OpenRouter / Together / Bifrost', { id: 'm', context_length: 131_072 }, 131_072],
    ['Groq / Bifrost OpenAI route', { id: 'm', context_window: 8192 }, 8192],
    ['Mistral / LM Studio', { id: 'm', max_context_length: 65_536 }, 65_536],
    ['OpenRouter top provider only', { id: 'm', top_provider: { context_length: 200_000 } }, 200_000],
    ['numeric string', { id: 'm', context_length: '40960' }, 40_960],
  ])('%s', (_name, entry, expected) => {
    expect(readReportedContextWindow(entry)).toBe(expected);
  });

  test('ignores the trained maximum, absent fields and nonsense', () => {
    expect(readReportedContextWindow({ id: 'm', meta: { n_ctx_train: 131_072 } })).toBeUndefined();
    expect(readReportedContextWindow({ id: 'm', object: 'model', owned_by: 'bifrost' })).toBeUndefined();
    expect(readReportedContextWindow({ id: 'm', max_model_len: 0, context_length: -1, context_window: 'big' })).toBeUndefined();
  });

  test('discovery keeps per-model reports and leaves a bare gateway list unreported', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(200, { data: [
        { id: 'vllm-model', object: 'model', max_model_len: 32_768 },
        { id: 'bare-model', object: 'model', owned_by: 'bifrost' },
      ] });
    });
    expect(await discoverOpenAICompatibleModels('https://gateway.example/v1', '')).toEqual([
      { id: 'vllm-model', contextWindow: 32_768 },
      { id: 'bare-model' },
    ]);
    expect(requests).toHaveLength(1);
  });

  test('a llama.cpp server is asked for its allocated context, not its trained maximum', async () => {
    const urls: string[] = [];
    __setRequestUrlMock(async request => {
      urls.push(request.url!);
      if (request.url!.endsWith('/v1/models')) {
        return jsonResponse(200, { object: 'list', data: [{ id: 'qwen.gguf', object: 'model', owned_by: 'llamacpp', meta: { n_ctx_train: 131_072, n_vocab: 151_936 } }] });
      }
      return jsonResponse(200, { default_generation_settings: { n_ctx: 16_384 }, total_slots: 1 });
    });
    expect(await discoverOpenAICompatibleModels('http://127.0.0.1:8080/v1', '')).toEqual([{ id: 'qwen.gguf', contextWindow: 16_384 }]);
    expect(urls).toEqual(['http://127.0.0.1:8080/v1/models', 'http://127.0.0.1:8080/props']);
  });

  test('a failing /props never fails discovery', async () => {
    __setRequestUrlMock(async request => request.url!.endsWith('/props')
      ? jsonResponse(404, { error: 'not found' })
      : jsonResponse(200, { data: [{ id: 'qwen.gguf', meta: { n_ctx_train: 131_072 } }] }));
    expect(await discoverOpenAICompatibleModels('http://127.0.0.1:8080/v1', '')).toEqual([{ id: 'qwen.gguf' }]);
  });
});

describe('editing the context window', () => {
  test('stores, clears and rejects values without touching other models', () => {
    const session = new OpenAICompatibleEditSession('id-1', endpoint({ a: { source: 'manual' }, b: { source: 'manual' } }), jest.fn());
    session.setContextWindow('a', 131_072);
    expect(session.draft.openaiCompatible.models).toEqual({ a: { source: 'manual', contextWindow: 131_072 }, b: { source: 'manual' } });
    session.setContextWindow('a', undefined);
    expect(session.draft.openaiCompatible.models.a).toEqual({ source: 'manual' });
    for (const bad of [0, 100, 1.5, Number.NaN, 10 ** 12]) expect(() => session.setContextWindow('a', bad)).toThrow('whole number');
    expect(() => session.setContextWindow('missing', 4096)).toThrow('not in the list');
  });

  test('Connect refreshes the server report but never overwrites the user value', async () => {
    const reports = [
      [{ id: 'a', contextWindow: 65_536 }, { id: 'b', contextWindow: 32_768 }],
      [{ id: 'a', contextWindow: 131_072 }, { id: 'b' }],
    ];
    const persist = jest.fn(async () => undefined);
    const session = new OpenAICompatibleEditSession('id-1', endpoint({ a: { source: 'manual', contextWindow: 16_384 } }), persist, async () => reports.shift()!);
    await session.connect();
    expect(session.draft.openaiCompatible.models).toEqual({
      a: { source: 'manual', contextWindow: 16_384, reportedContextWindow: 65_536 },
      b: { source: 'discovered', reportedContextWindow: 32_768 },
    });
    await session.connect();
    expect(session.draft.openaiCompatible.models).toEqual({
      a: { source: 'manual', contextWindow: 16_384, reportedContextWindow: 131_072 },
      b: { source: 'discovered' },
    });
    expect(persist).toHaveBeenLastCalledWith('id-1', expect.objectContaining({
      openaiCompatible: expect.objectContaining({ models: session.draft.openaiCompatible.models }),
    }));
  });

  test('Check uses the draft address, key and the size the model would actually get', async () => {
    const check = jest.fn(async () => ({ kind: 'fits-unmeasured' as const }));
    const config = endpoint({ a: { source: 'discovered', reportedContextWindow: 32_768 } });
    const session = new OpenAICompatibleEditSession('id-1', config, jest.fn(), jest.fn(), check);
    session.setApiKey('draft-key');
    await session.checkContextWindow('a');
    session.setContextWindow('a', 65_536);
    await session.checkContextWindow('a');
    expect(check.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ baseUrl: 'https://gateway.example/v1', apiKey: 'draft-key', model: 'a', contextWindow: 32_768 }),
      expect.objectContaining({ contextWindow: 65_536 }),
    ]);
  });
});

/**
 * A fake chat server. Its tokenizer spends 11 tokens per filler sentence plus a
 * 23-token chat template, so the check must measure rather than assume.
 */
type ServerReply = (promptTokens: number) => ReturnType<typeof jsonResponse>;
const SENTENCE = 'The quick brown fox jumps over the lazy dog. ';
function fakeServer(reply: ServerReply): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  __setRequestUrlMock(async request => {
    const body = JSON.parse(request.body!) as { messages: Array<{ content: string }> };
    bodies.push(body);
    const sentences = body.messages[0].content.split(SENTENCE).length - 1;
    return reply(23 + sentences * 11);
  });
  return { bodies };
}
const accepted = (promptTokens: number) => jsonResponse(200, {
  choices: [{ message: { content: 'x' }, finish_reason: 'length' }], usage: { prompt_tokens: promptTokens, completion_tokens: 1 },
});
const request = (contextWindow: number) => ({ baseUrl: 'https://gateway.example/v1', apiKey: '', model: 'm', contextWindow });

describe('Check: sending a prompt of the chosen size', () => {
  test('a prompt that fits is filled close to the window, with one output token', async () => {
    const { bodies } = fakeServer(accepted);
    const result = await checkOpenAICompatibleContextWindow(request(8192));
    expect(result.kind).toBe('fits');
    const sent = (result as { promptTokens: number }).promptTokens;
    expect(sent).toBeLessThanOrEqual(8192 - 1);
    expect(sent).toBeGreaterThan(8192 * 0.97);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toMatchObject({ model: 'm', stream: false, max_tokens: 1 });
  });

  test('vLLM-style refusal reports the limit from its sentence', async () => {
    fakeServer(tokens => tokens + 1 > 4096
      ? jsonResponse(400, { object: 'error', type: 'BadRequestError', code: 400,
        message: `This model's maximum context length is 4096 tokens. However, you requested ${tokens + 1} tokens (${tokens} in the messages, 1 in the completion). Please reduce the length of the messages or completion.` })
      : accepted(tokens));
    expect(await checkOpenAICompatibleContextWindow(request(131_072))).toEqual(expect.objectContaining({ kind: 'too-large', serverLimit: 4096 }));
  });

  test('llama.cpp-style refusal reports n_ctx from its error object', async () => {
    fakeServer(tokens => tokens >= 16_384
      // Captured from llama.cpp's server image, 2026-11-12.
      ? jsonResponse(400, { error: { code: 400, message: `request (${tokens} tokens) exceeds the available context size (16384 tokens), try increasing it`,
        type: 'exceed_context_size_error', n_prompt_tokens: tokens, n_ctx: 16_384 } })
      : accepted(tokens));
    expect(await checkOpenAICompatibleContextWindow(request(65_536))).toEqual(expect.objectContaining({ kind: 'too-large', serverLimit: 16_384 }));
  });

  test('a refusal without a number is still reported as too large', async () => {
    fakeServer(tokens => tokens > 2048 ? jsonResponse(400, { error: { message: 'Prompt is too long' } }) : accepted(tokens));
    expect(await checkOpenAICompatibleContextWindow(request(8192))).toEqual({ kind: 'too-large', serverLimit: undefined, message: 'Prompt is too long' });
  });

  test('a server that silently cuts the prompt is caught by its own token count', async () => {
    fakeServer(tokens => accepted(Math.min(tokens, 2048)));
    expect(await checkOpenAICompatibleContextWindow(request(32_768))).toEqual({ kind: 'truncated', promptTokens: 2048 });
  });

  test('a server with no token counts cannot be confirmed', async () => {
    fakeServer(() => jsonResponse(200, { choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }));
    expect(await checkOpenAICompatibleContextWindow(request(8192))).toEqual({ kind: 'fits-unmeasured' });
  });

  test('an unrelated error is a failure, not a size verdict', async () => {
    fakeServer(() => jsonResponse(401, { error: { message: 'Invalid API key' } }));
    expect(await checkOpenAICompatibleContextWindow(request(8192))).toEqual({ kind: 'failed', message: 'The server returned HTTP 401: Invalid API key' });
  });

  test('the limit survives a gateway that passes on only the message', () => {
    expect(readContextLimitFromError(null, 'request (6031 tokens) exceeds the available context size (2048 tokens), try increasing it', 8192)).toBe(2048);
  });

  test('a named limit at or above the tested size is not offered', () => {
    expect(readContextLimitFromError(null, "This model's maximum context length is 8192 tokens.", 8192)).toBeUndefined();
    expect(readContextLimitFromError(null, 'context length of 1,000,000 exceeded', 2_000_000)).toBe(1_000_000);
  });
});

describe('what the settings row says', () => {
  test('names where the number came from', () => {
    expect(describeContextWindow({ source: 'manual' })).toMatch(/4,096 tokens.*did not report/);
    expect(describeContextWindow({ source: 'discovered', reportedContextWindow: 131_072 })).toBe('Context window: 131,072 tokens, reported by your server.');
    expect(describeContextWindow({ source: 'discovered', contextWindow: 65_536, reportedContextWindow: 131_072 }))
      .toBe('Context window: 65,536 tokens, set by you. Your server reports 131,072.');
  });

  test('offers the size a failed check revealed', () => {
    expect(describeContextCheck({ kind: 'too-large', serverLimit: 4096, message: 'x' })).toMatchObject({ suggestion: 4096, warning: true });
    expect(describeContextCheck({ kind: 'truncated', promptTokens: 2048 })).toMatchObject({ suggestion: 2048, warning: true });
    expect(describeContextCheck({ kind: 'fits', promptTokens: 8100 })).toMatchObject({ warning: false });
    expect(describeContextCheck({ kind: 'too-large', message: 'Prompt is too long' }).suggestion).toBeUndefined();
  });
});
