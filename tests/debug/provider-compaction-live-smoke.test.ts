/**
 * Exercise real context summarization through the orchestrator and adapters.
 * Unit fixtures cannot establish whether an endpoint rejects Nexus metadata.
 * Uses only a synthetic transcript, configured keys and small output caps.
 *
 * RUN_PROVIDER_COMPACTION_SMOKE=1 pnpm exec jest tests/debug/provider-compaction-live-smoke.test.ts --runInBand --no-coverage
 * Optional COMPACTION_SMOKE_PROVIDER selects one provider; COMPACTION_SMOKE_MODEL
 * overrides its model. COMPACTION_SMOKE_SETTINGS_FILE optionally supplies Nexus
 * plugin settings: explicit environment keys win, then saved keys, then .env.
 * Results contain envelope keys/statuses, never credentials.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { __setRequestUrlMock } from 'obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'), hasNodeRuntime: () => false,
}));

import { ContextPreservationService } from '../../src/services/chat/ContextPreservationService';
import { StreamingOrchestrator } from '../../src/services/llm/core/StreamingOrchestrator';
import type { IAdapterRegistry } from '../../src/services/llm/core/AdapterRegistry';
import type { BaseAdapter } from '../../src/services/llm/adapters/BaseAdapter';
import { AnthropicAdapter } from '../../src/services/llm/adapters/anthropic/AnthropicAdapter';
import { OpenAIAdapter } from '../../src/services/llm/adapters/openai/OpenAIAdapter';
import { OpenRouterAdapter } from '../../src/services/llm/adapters/openrouter/OpenRouterAdapter';
import { GoogleAdapter } from '../../src/services/llm/adapters/google/GoogleAdapter';

jest.setTimeout(90_000);
const enabled = process.env.RUN_PROVIDER_COMPACTION_SMOKE === '1';
const env = new Map<string, string>();
if (enabled && fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) env.set(match[1], match[2].replace(/^['"]|['"]$/g, ''));
  }
}
const savedKeys = new Map<string, string>();
if (enabled && process.env.COMPACTION_SMOKE_SETTINGS_FILE) {
  const settings = JSON.parse(fs.readFileSync(process.env.COMPACTION_SMOKE_SETTINGS_FILE, 'utf8')) as {
    llmProviders?: { providers?: Record<string, { apiKey?: string }> };
  };
  for (const [name, provider] of Object.entries({
    ANTHROPIC_API_KEY: 'anthropic', OPENAI_API_KEY: 'openai',
    GEMINI_API_KEY: 'google', OPENROUTER_API_KEY: 'openrouter',
  })) {
    const key = settings.llmProviders?.providers?.[provider]?.apiKey;
    if (key) savedKeys.set(name, key);
  }
}
const getKey = (name: string) => process.env[name] || savedKeys.get(name) || env.get(name) || '';
const targets = [
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', key: 'ANTHROPIC_API_KEY', create: (key: string): BaseAdapter => new AnthropicAdapter(key) },
  { provider: 'openai', model: 'gpt-5.4-nano', key: 'OPENAI_API_KEY', create: (key: string): BaseAdapter => new OpenAIAdapter(key) },
  { provider: 'google', model: 'gemini-3.5-flash-lite', key: 'GEMINI_API_KEY', create: (key: string): BaseAdapter => new GoogleAdapter(key) },
  { provider: 'openrouter', model: 'anthropic/claude-haiku-4-5', key: 'OPENROUTER_API_KEY', create: (key: string): BaseAdapter => new OpenRouterAdapter(key) },
  { provider: 'openrouter', model: 'openai/gpt-5.4-nano', key: 'OPENROUTER_API_KEY', create: (key: string): BaseAdapter => new OpenRouterAdapter(key) },
  { provider: 'openrouter', model: 'google/gemini-3.5-flash-lite', key: 'OPENROUTER_API_KEY', create: (key: string): BaseAdapter => new OpenRouterAdapter(key) },
].filter(target => !process.env.COMPACTION_SMOKE_PROVIDER || target.provider === process.env.COMPACTION_SMOKE_PROVIDER);

type Target = typeof targets[number];
type Mode = 'current' | 'clean' | 'reproduce-anthropic-bug';
interface Result {
  provider: string; model: string; mode: Mode; success: boolean;
  statuses: number[]; envelopeKeys: string[][]; summaryLength?: number; error?: string;
}
const results: Result[] = [];
const describeLive = enabled ? describe : describe.skip;

async function summarize(target: Target, mode: Mode): Promise<Result> {
  const model = process.env.COMPACTION_SMOKE_MODEL || target.model;
  const result: Result = { provider: target.provider, model, mode, success: false, statuses: [], envelopeKeys: [] };
  results.push(result);
  __setRequestUrlMock(async request => {
    const body = JSON.parse(typeof request.body === 'string' ? request.body : '{}');
    const messages: Array<Record<string, unknown>> = body.messages ?? body.contents ?? body.input ?? [];
    for (const message of messages) {
      if (mode === 'clean') {
        delete message.id;
        delete message.timestamp;
        delete message.conversationId;
      } else if (mode === 'reproduce-anthropic-bug') {
        message.id = 'handoff_summary_reproduction';
        message.timestamp = 1;
        message.conversationId = 'synthetic-compaction';
      }
      result.envelopeKeys.push(Object.keys(message).sort());
    }
    const response = await fetch(request.url ?? '', {
      method: request.method || 'GET', headers: request.headers,
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    result.statuses.push(response.status);
    const arrayBuffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* SSE is not a JSON document. */ }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), arrayBuffer, text, json };
  });
  const adapter = target.create(getKey(target.key));
  const registry: IAdapterRegistry = {
    initialize: () => undefined, updateSettings: () => undefined, clear: () => undefined,
    getAdapter: () => adapter, getAvailableProviders: () => [target.provider], isProviderAvailable: () => true,
  };
  const orchestrator = new StreamingOrchestrator(registry, {
    providers: {}, defaultModel: { provider: target.provider, model },
  });
  const preservation = new ContextPreservationService({
    llmService: { generateResponseStream: (messages, options) => orchestrator.generateResponseStream(messages, options) },
    getAgent: () => null, executeToolCalls: async () => [],
  });
  try {
    const summary = await preservation.summarizeForHandoff([
      { id: 'u1', role: 'user', content: 'Prepare a launch checklist for a fictional notes app. Keep it to three steps.', timestamp: 1, conversationId: 'synthetic-compaction' },
      { id: 'a1', role: 'assistant', content: 'Draft: test the app, write release notes, publish after approval. Publication is still pending.', timestamp: 2, conversationId: 'synthetic-compaction' },
    ], { provider: target.provider, model, maxTokens: 512, sourceContextWindow: 128_000 });
    result.success = summary.length > 0;
    result.summaryLength = summary.length;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    for (const entry of targets) {
      const key = getKey(entry.key);
      if (key) message = message.split(key).join('[redacted]');
    }
    result.error = message.slice(0, 1200);
  }
  return result;
}

describeLive('provider compaction live acceptance', () => {
  let errors: jest.SpyInstance;
  beforeAll(() => { errors = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterAll(() => {
    errors.mockRestore();
    const report = path.resolve('test-artifacts/provider-compaction-live-smoke.json');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
    console.info(`Compaction acceptance report: ${report}`);
  });
  for (const target of targets) {
    const testWithKey = getKey(target.key) ? it : it.skip;
    for (const mode of ['clean', 'current'] as const) {
      testWithKey(`${target.provider}/${target.model}: ${mode} compaction completes`, async () => {
        const result = await summarize(target, mode);
        expect(result).toMatchObject({ success: true, statuses: [200] });
      });
    }
    if (target.provider === 'anthropic') {
      testWithKey('reproduces the Anthropic 400 when Nexus metadata is restored on the wire', async () => {
        const result = await summarize(target, 'reproduce-anthropic-bug');
        expect(result).toMatchObject({ success: false, statuses: [400] });
        expect(result.error).toContain('id');
      });
    }
  }
});
