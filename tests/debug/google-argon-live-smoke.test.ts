/**
 * Bounded live Argon checks: mocks cannot prove the provider accepts thinking
 * controls, emits reasoning, or surfaces rejected streaming requests.
 * RUN_GOOGLE_ARGON_SMOKE=1 npx jest tests/debug/google-argon-live-smoke.test.ts --runInBand --no-coverage
 * Reads GEMINI_API_KEY from the environment or repo .env. No vault writes.
 * Two successful requests, each capped at 2,048 thinking + output tokens.
 */
import * as fs from 'node:fs';
import { __setRequestUrlMock } from 'obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { GoogleAdapter } from '../../src/services/llm/adapters/google/GoogleAdapter';

jest.setTimeout(180_000);
const describeLive = process.env.RUN_GOOGLE_ARGON_SMOKE === '1' ? describe : describe.skip;
const model = 'gemini-4-argon';

function apiKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const lines = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8').split(/\r?\n/) : [];
  const line = lines.find(value => /^GEMINI_API_KEY=/.test(value));
  const key = line?.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!key) throw new Error('GEMINI_API_KEY is required');
  return key;
}

describeLive('Argon bounded live transport', () => {
  const usageRecords: Record<string, number>[] = [];
  const sentBodies: string[] = [];
  let providerThoughtText = '';
  beforeEach(() => { sentBodies.length = 0; providerThoughtText = ''; });
  beforeAll(() => {
    __setRequestUrlMock(async request => {
      if (typeof request.body === 'string') sentBodies.push(request.body);
      const response = await fetch(request.url ?? '', {
        method: request.method || 'GET',
        headers: Object.fromEntries(Object.entries(request.headers || {}).map(([key, value]) => [key, String(value)])),
        body: typeof request.body === 'string' ? request.body : undefined,
        signal: AbortSignal.timeout(150_000),
      });
      const arrayBuffer = await response.arrayBuffer();
      const text = new TextDecoder().decode(arrayBuffer);
      let json: unknown = {};
      try { json = JSON.parse(text); } catch { /* SSE is not one JSON object. */ }
      const payloads: unknown[] = text.startsWith('data:')
        ? text.split('\n').filter(line => line.startsWith('data: ')).flatMap(line => {
          try { return [JSON.parse(line.slice(6))]; } catch { return []; }
        }) : [json];
      let latest: Record<string, number> | undefined;
      for (const payload of payloads) {
        if (payload && typeof payload === 'object' && 'usageMetadata' in payload) {
          latest = payload.usageMetadata as Record<string, number>;
        }
        if (payload && typeof payload === 'object' && 'candidates' in payload) {
          const response = payload as { candidates?: Array<{ content?: { parts?: Array<{ thought?: boolean; text?: string }> } }> };
          providerThoughtText += (response.candidates?.[0]?.content?.parts || [])
            .filter(part => part.thought && typeof part.text === 'string').map(part => part.text).join('');
        }
      }
      if (latest) usageRecords.push(latest);
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text, json, arrayBuffer };
    });
  });

  afterAll(() => {
    const input = usageRecords.reduce((sum, usage) => sum + (usage.promptTokenCount || 0), 0);
    const cached = usageRecords.reduce((sum, usage) => sum + (usage.cachedContentTokenCount || 0), 0);
    const output = usageRecords.reduce((sum, usage) => sum + (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0), 0);
    console.info('Argon smoke usage', JSON.stringify({ requests: usageRecords.length, inputTokens: input,
      cachedInputTokens: cached, outputIncludingThinkingTokens: output,
      estimatedIntroductoryUSD: ((input - cached) * 2 + cached * 0.1 + output * 10) / 1_000_000 }));
  });

  it('returns text and usage through non-streaming REST', async () => {
    const response = await new GoogleAdapter(apiKey(), model).generateUncached('Reply with exactly OK.', {
      model, enableThinking: true, thinkingEffort: 'low', maxTokens: 2048,
    });
    expect(response.text.trim()).toContain('OK');
    expect(response.finishReason).toBe('stop');
    expect(response.usage?.totalTokens).toBeGreaterThan(0);
  });

  it('streams an answer, available reasoning and completion through the buffered mobile transport', async () => {
    let content = '';
    let reasoning = '';
    let completed = false;
    for await (const chunk of new GoogleAdapter(apiKey(), model).generateStreamAsync(
      'A farmer has 17 sheep. All but 9 run away. He buys twice as many as remain and sells 5. Work it out and give the final number briefly.',
      { model, enableThinking: true, thinkingEffort: 'low', maxTokens: 2048 }
    )) {
      content += chunk.content || '';
      reasoning += chunk.reasoning || '';
      completed ||= chunk.complete === true;
    }
    expect(content).toContain('22');
    expect(JSON.parse(sentBodies[0]).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low', includeThoughts: true });
    // Providers may omit summaries for simple prompts. Verify we preserve any
    // actual thought text without making summary availability a model guarantee.
    expect(reasoning).toBe(providerThoughtText);
    console.info('Argon visible thought-summary characters:', reasoning.length);
    expect(completed).toBe(true);
  });

  it('throws when the live streaming endpoint rejects an invalid model', async () => {
    await expect((async () => {
      for await (const chunk of new GoogleAdapter(apiKey(), model).generateStreamAsync('Reply OK.', {
        model: 'gemini-4-argon-invalid-smoke', maxTokens: 1,
      })) { void chunk; }
    })()).rejects.toThrow();
  });
});
