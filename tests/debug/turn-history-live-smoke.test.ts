/**
 * Live turn-by-turn history smoke lane.
 *
 * What the mocks cannot cover: whether a real provider, handed the previous
 * turn's tool call and result as STRUCTURED history (not a text transcript in
 * the system prompt), can answer a follow-up question from that history — and
 * whether Anthropic actually serves the now-stable system prompt from cache.
 *
 * Per provider with a key in .env:
 *   Turn 1  user asks the model to call `lookup_secret`; a stub executor
 *           returns a distinctive value; the turn completes.
 *   Turn 2  the stored conversation is rebuilt through the real chat pipeline
 *           (ConversationContextBuilder → StreamingOrchestrator) with the SAME
 *           tool list (the catalog is constant across chat turns, and for
 *           Anthropic it is part of the cached prefix), and the user asks what
 *           the tool returned without calling it. The answer must contain the
 *           value, so it reached the model as a turn; the stub must not run again.
 *   Wire    the turn-2 request body is captured: no "Conversation History"
 *           transcript in the system prompt / instructions, and the tool round
 *           is present in the provider's structured form.
 *   Cache   Anthropic only: turn 2 reports cacheReadTokens > 0.
 *
 * Run:
 *   RUN_TURN_HISTORY_SMOKE=1 npx jest tests/debug/turn-history-live-smoke.test.ts --runInBand --no-coverage --verbose
 * One provider (also selects both OpenRouter lanes):
 *   RUN_TURN_HISTORY_SMOKE=1 TURN_HISTORY_PROVIDER=anthropic npx jest tests/debug/turn-history-live-smoke.test.ts --runInBand --no-coverage --verbose
 * Other knobs: TURN_HISTORY_MODEL overrides the model for every lane;
 * TURN_HISTORY_DEBUG=1 dumps turn 1's tool calls and turn 2's messages.
 *
 * Writes nothing: the stub tool touches no vault.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { __setRequestUrlMock } from 'obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { DEFAULT_MODELS } from '../../src/services/llm/adapters/ModelRegistry';
import { OpenAIAdapter } from '../../src/services/llm/adapters/openai/OpenAIAdapter';
import { OpenRouterAdapter } from '../../src/services/llm/adapters/openrouter/OpenRouterAdapter';
import { GoogleAdapter } from '../../src/services/llm/adapters/google/GoogleAdapter';
import { AnthropicAdapter } from '../../src/services/llm/adapters/anthropic/AnthropicAdapter';
import { GroqAdapter } from '../../src/services/llm/adapters/groq/GroqAdapter';
import { MistralAdapter } from '../../src/services/llm/adapters/mistral/MistralAdapter';
import { DeepSeekAdapter } from '../../src/services/llm/adapters/deepseek/DeepSeekAdapter';
import { RequestyAdapter } from '../../src/services/llm/adapters/requesty/RequestyAdapter';
import type { BaseAdapter } from '../../src/services/llm/adapters/BaseAdapter';
import type { Tool, ToolCall } from '../../src/services/llm/adapters/types';
import type { IToolExecutor, ToolResult } from '../../src/services/llm/adapters/shared/ToolExecutionUtils';
import { StreamingOrchestrator } from '../../src/services/llm/core/StreamingOrchestrator';
import type { ConversationMessage } from '../../src/services/llm/core/ProviderMessageBuilder';
import { ConversationContextBuilder } from '../../src/services/chat/ConversationContextBuilder';
import { createInitialChatTurnState, reduceChatTurn, type ChatTurnState } from '../../src/services/llm/runtime/ChatTurnReducer';
import type { ConversationData, LLMProviderSettings } from '../../src/types';
import { EvalAdapterRegistry } from '../eval/EvalAdapterRegistry';

jest.setTimeout(300_000);

type Provider = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'groq' | 'mistral' | 'deepseek' | 'requesty';
/** A lane is a provider plus an optional model override (label keeps ids unique). */
interface Lane { label: string; provider: Provider; model?: string }
const LANES: Lane[] = [
  { label: 'anthropic', provider: 'anthropic' },
  { label: 'openai', provider: 'openai' },
  // Google: the default (3.1 Pro, thinking) plus the newest flash and the lite
  // tier — thought_signature handling differs between thinking and non-thinking.
  { label: 'google', provider: 'google' },
  { label: 'google (3.8 flash)', provider: 'google', model: 'gemini-3.8-flash' },
  { label: 'google (3.5 flash-lite)', provider: 'google', model: 'gemini-3.5-flash-lite' },
  { label: 'openrouter', provider: 'openrouter' },
  // Gemini behind OpenRouter needs reasoning_details / thought_signature replayed
  // on the stored assistant turn, which the direct-OpenAI lane cannot prove.
  { label: 'openrouter (gemini 3.1 pro)', provider: 'openrouter', model: `google/${DEFAULT_MODELS.google}` },
  { label: 'openrouter (gemini 3.8 flash)', provider: 'openrouter', model: 'google/gemini-3.8-flash' },
  { label: 'openrouter (claude haiku 4.5)', provider: 'openrouter', model: 'anthropic/claude-haiku-4-5' },
  { label: 'openrouter (deepseek v4 pro)', provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813' },
  { label: 'openrouter (kimi k3)', provider: 'openrouter', model: 'moonshotai/kimi-k3' },
  { label: 'openrouter (glm 5.3)', provider: 'openrouter', model: 'z-ai/glm-5.3' },
  // Other chat-completions providers, at their registry defaults.
  { label: 'groq', provider: 'groq' },
  { label: 'mistral', provider: 'mistral' },
  { label: 'deepseek', provider: 'deepseek' },
  { label: 'requesty', provider: 'requesty' },
  { label: 'requesty (gemini 3.1 pro)', provider: 'requesty', model: 'google/gemini-3.1-pro-preview' },
];
const RUN_LIVE = process.env.RUN_TURN_HISTORY_SMOKE === '1';
const SECRET = 'QUOKKA-7741';
const TRANSCRIPT_MARKER = 'Conversation History';

// ---------------------------------------------------------------------------
// env / http
// ---------------------------------------------------------------------------

function readDotEnv(): Map<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  const values = new Map<string, string>();
  if (!fs.existsSync(envPath)) return values;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !line.trim().startsWith('#')) values.set(m[1], m[2].replace(/^['"]|['"]$/g, ''));
  }
  return values;
}
const DOT_ENV = readDotEnv();
const getEnv = (name: string): string | undefined => process.env[name] || DOT_ENV.get(name);

const KEY_NAMES: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  requesty: 'REQUESTY_API_KEY',
};

interface HttpCapture { url: string; body: Record<string, unknown> }

function setRequestUrlToRealFetch(captures: HttpCapture[]): void {
  __setRequestUrlMock(async (request) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers || {})) headers[k] = String(v);
    if (typeof request.body === 'string') {
      try { captures.push({ url: request.url ?? '', body: JSON.parse(request.body) }); } catch { /* not JSON */ }
    }
    const response = await fetch(request.url ?? '', {
      method: request.method || 'GET',
      headers,
      body: typeof request.body === 'string' ? request.body : undefined,
    });
    const arrayBuffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    if (response.status >= 400) {
      // eslint-disable-next-line no-console
      console.log(`[turn-history] ${response.status} ${request.url}\n${text.slice(0, 1500)}\nrequest: ${String(request.body).slice(0, 3000)}`);
    }
    let json: unknown = {};
    try { json = JSON.parse(text); } catch { /* SSE */ }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text, json, arrayBuffer };
  });
}

function createAdapter(provider: Provider, apiKey: string): BaseAdapter {
  switch (provider) {
    case 'anthropic': return new AnthropicAdapter(apiKey);
    case 'openai': return new OpenAIAdapter(apiKey);
    case 'google': return new GoogleAdapter(apiKey);
    case 'openrouter': return new OpenRouterAdapter(apiKey);
    case 'groq': return new GroqAdapter(apiKey);
    case 'mistral': return new MistralAdapter(apiKey);
    case 'deepseek': return new DeepSeekAdapter(apiKey);
    case 'requesty': return new RequestyAdapter(apiKey);
  }
}

function modelFor(provider: Provider, laneModel?: string): string {
  const override = getEnv('TURN_HISTORY_MODEL');
  const model = override || laneModel || DEFAULT_MODELS[provider];
  if (provider === 'openrouter' && !model.includes('/')) return `openai/${model}`;
  return model;
}

// ---------------------------------------------------------------------------
// stub tool
// ---------------------------------------------------------------------------

const LOOKUP_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'lookup_secret',
    description: 'Look up a secret value by key. Always call this when asked for a secret.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'The key to look up' } },
      required: ['key'],
    },
  },
};

class StubExecutor implements IToolExecutor {
  calls: ToolCall[] = [];
  async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    this.calls.push(...toolCalls);
    return toolCalls.map(tc => ({
      id: tc.id,
      name: tc.function?.name || '',
      success: true,
      result: { key: 'alpha', value: SECRET },
    }));
  }
}

// Pad the system prompt past Anthropic's minimum cacheable prefix so a cache
// hit is observable on turn 2. Haiku 4.5 (the default) needs > 2115 tokens —
// a 60-entry filler probed at 2115 tokens created no cache; 160 entries
// (~5.6k tokens) wrote 5606 tokens on call 1 and read them back on call 2.
const SYSTEM_PROMPT = [
  'You are a terse assistant in a test harness. Answer with the fewest words possible.',
  'When asked for a secret, call the lookup_secret tool. When asked what a tool returned, quote the value exactly.',
  '',
  '<reference_filler>',
  ...Array.from({ length: 160 }, (_, i) =>
    `Entry ${i + 1}: The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly; pack my box with five dozen liquor jugs.`),
  '</reference_filler>',
].join('\n');

// ---------------------------------------------------------------------------
// run one turn through the real orchestrator
// ---------------------------------------------------------------------------

async function runTurn(
  orchestrator: StreamingOrchestrator,
  provider: Provider,
  model: string,
  messages: ConversationMessage[],
  tools: Tool[],
): Promise<ChatTurnState> {
  let state = createInitialChatTurnState();
  for await (const event of orchestrator.generateResponseStream(messages, {
    provider,
    model,
    tools,
    toolChoice: tools.length > 0 ? 'auto' : undefined,
    // No maxTokens: the chat pipeline sends none either, and a cap starves
    // thinking models (Gemini 3.1 Pro via OpenRouter spent a 512 budget on
    // reasoning and returned an empty turn with no tool call).
    conversationId: `turn-history-${provider}`,
  } as Parameters<StreamingOrchestrator['generateResponseStream']>[1])) {
    state = reduceChatTurn(state, event);
    if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.aborted') break;
  }
  if (state.phase !== 'complete') {
    throw new Error(`Turn did not complete: ${state.phase} ${JSON.stringify(state.error)}`);
  }
  return state;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('turn-by-turn history — live', () => {
  const captures: HttpCapture[] = [];
  beforeAll(() => setRequestUrlToRealFetch(captures));
  beforeEach(() => { captures.length = 0; });

  const filter = getEnv('TURN_HISTORY_PROVIDER');
  const targets = LANES.filter(lane => !filter || lane.provider === filter);

  for (const lane of targets) {
    const { provider } = lane;
    const apiKey = getEnv(KEY_NAMES[provider]);
    const run = RUN_LIVE && apiKey ? it : it.skip;

    run(`${lane.label}: turn 2 answers from the structured tool history, with no transcript in the system prompt`, async () => {
      const model = modelFor(provider, lane.model);
      const adapter = createAdapter(provider, apiKey!);
      const executor = new StubExecutor();
      const settings: LLMProviderSettings = {
        providers: { [provider]: { apiKey: apiKey!, enabled: true } },
        defaultModel: { provider, model },
      } as LLMProviderSettings;
      const orchestrator = new StreamingOrchestrator(new EvalAdapterRegistry([[provider, adapter]]), settings, executor);

      // ---- turn 1: the model calls the stub tool ----
      const turn1User = 'Fetch the secret for key "alpha" using lookup_secret, then reply with just "done".';
      // Whether the model chooses to call the tool is its decision, not the
      // pipeline's; one retry keeps a rare "answered without calling" from
      // masquerading as a history failure.
      let turn1 = await runTurn(orchestrator, provider, model, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: turn1User },
      ], [LOOKUP_TOOL]);
      if (turn1.toolCalls.length === 0) {
        console.log(`[turn-history] ${lane.label}: no tool call on turn 1 (${JSON.stringify({ content: turn1.content, finishReason: turn1.finishReason, usage: turn1.usage, metadata: turn1.metadata })}), retrying once`);
        turn1 = await runTurn(orchestrator, provider, model, [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: turn1User },
        ], [LOOKUP_TOOL]);
      }

      expect(executor.calls.map(c => c.function?.name)).toContain('lookup_secret');
      expect(turn1.toolCalls.length).toBeGreaterThan(0);
      expect(turn1.toolCalls.every(tc => tc.result !== undefined)).toBe(true);

      // ---- turn 2: rebuild from "storage" exactly as the chat does ----
      const conversation = {
        id: `conv-${provider}`,
        title: 'live',
        created: Date.now(),
        updated: Date.now(),
        messages: [
          { id: 'u1', role: 'user', content: turn1User, timestamp: 1, conversationId: 'c' },
          {
            id: 'a1', role: 'assistant', content: turn1.content, timestamp: 2, conversationId: 'c',
            toolCalls: turn1.toolCalls, state: 'complete',
          },
          { id: 'u2', role: 'user', content: 'Without calling any tool: what exact value did lookup_secret return earlier? Reply with the value only.', timestamp: 3, conversationId: 'c' },
        ],
      } as unknown as ConversationData;

      const turn2Messages = ConversationContextBuilder.buildContextForProvider(
        conversation, provider, SYSTEM_PROMPT
      ) as ConversationMessage[];

      // Same tool list as turn 1: in the real chat the tool catalog is constant
      // across turns, and for Anthropic it is part of the cached prefix.
      captures.length = 0;
      const callsBeforeTurn2 = executor.calls.length;
      if (getEnv('TURN_HISTORY_DEBUG')) {
        console.log(`[turn-history] ${lane.label} turn1.toolCalls`, JSON.stringify(turn1.toolCalls, null, 2));
        console.log(`[turn-history] ${lane.label} turn2Messages`, JSON.stringify(turn2Messages.filter(m => m.role !== 'system'), null, 2));
      }
      const turn2 = await runTurn(orchestrator, provider, model, turn2Messages, [LOOKUP_TOOL]);
      expect(executor.calls.length).toBe(callsBeforeTurn2);

      // The model could only know this from the prior tool turn.
      expect(turn2.content).toContain(SECRET);

      // ---- wire assertions on the turn-2 request ----
      const req = captures.find(c => /messages|responses|generatecontent|chat\/completions/i.test(c.url));
      expect(req).toBeDefined();
      const body = req!.body;
      const wire = JSON.stringify(body);

      const systemText = JSON.stringify(body.system ?? body.instructions ?? body.systemInstruction ??
        (Array.isArray(body.messages) ? (body.messages as Array<{ role: string }>).filter(m => m.role === 'system') : ''));
      expect(systemText).not.toContain(TRANSCRIPT_MARKER);
      expect(systemText).not.toContain(SECRET);

      const structuralMarker: Record<Provider, string> = {
        anthropic: '"tool_result"',
        openai: '"function_call_output"',
        google: '"functionResponse"',
        openrouter: '"role":"tool"',
        groq: '"role":"tool"',
        mistral: '"role":"tool"',
        deepseek: '"role":"tool"',
        requesty: '"role":"tool"',
      };
      expect(wire).toContain(structuralMarker[provider]);
      expect(wire).toContain(SECRET);

      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ provider, model, usage1: turn1.usage, usage2: turn2.usage }, null, 2));

      if (provider === 'anthropic') {
        expect(body.system).toEqual([expect.objectContaining({ cache_control: { type: 'ephemeral' } })]);
        // The system prompt was written to cache on turn 1 and read back on turn 2.
        expect(turn2.usage?.cacheReadTokens ?? 0).toBeGreaterThan(0);
      }
      if (provider === 'openrouter' && model.startsWith('anthropic/')) {
        // OpenRouter forwards the breakpoint; without it Anthropic caches nothing.
        expect(wire).toContain('"cache_control":{"type":"ephemeral"}');
        expect(turn2.usage?.cacheReadTokens ?? 0).toBeGreaterThan(0);
      }
      if (provider === 'openrouter') {
        // The usage frame after finish_reason must reach the turn (tokens + price).
        expect(turn2.usage?.promptTokens ?? 0).toBeGreaterThan(0);
        expect(turn2.usage?.providerCost?.totalCost ?? 0).toBeGreaterThan(0);
      }
      if (provider === 'openai') {
        // Responses API auto-caches prefixes ≥ 1024 tokens; turn 2 repeats turn 1's prefix.
        expect(turn2.usage?.cacheReadTokens ?? 0).toBeGreaterThan(0);
      }

      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ provider, model, turn1: turn1.content, turn2: turn2.content, usage2: turn2.usage }, null, 2));
    });
  }
});
