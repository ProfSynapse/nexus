/**
 * Live smoke: Gemini must actually stream thought summaries.
 *
 * What the mocked lanes cannot cover: every Jest lane replays a canned SSE body,
 * so a request that never asks Gemini for thought summaries still "streams
 * reasoning" in tests. That is exactly how the adapter shipped without
 * `thinkingConfig.includeThoughts` — thinking ran, no `thought: true` part ever
 * came back, and Nexus chat showed no reasoning for Gemini alone. Only a real
 * request to the real endpoint can prove the opt-in is present and honoured.
 *
 * Run:
 *   RUN_GOOGLE_REASONING_SMOKE=1 npx jest tests/debug/google-reasoning-live-smoke.test.ts --runInBand --no-coverage
 *
 * Needs GEMINI_API_KEY (process env or a .env at the repo root).
 * Override the model with GOOGLE_SMOKE_MODEL. Reads and writes nothing in any vault.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { __setRequestUrlMock } from 'obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { GoogleAdapter } from '../../src/services/llm/adapters/google/GoogleAdapter';

jest.setTimeout(240_000);

const RUN_LIVE = process.env.RUN_GOOGLE_REASONING_SMOKE === '1';

function readDotEnv(): Map<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  const values = new Map<string, string>();
  if (!fs.existsSync(envPath)) return values;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2].replace(/^['"]|['"]$/g, ''));
  }
  return values;
}

const DOT_ENV = readDotEnv();

function getEnv(name: string): string | undefined {
  return process.env[name] || DOT_ENV.get(name);
}

const describeLive = RUN_LIVE ? describe : describe.skip;

describeLive('Google reasoning (live)', () => {
  const model = getEnv('GOOGLE_SMOKE_MODEL') || 'gemini-3.7-flash';
  const sentBodies: string[] = [];

  beforeAll(() => {
    __setRequestUrlMock(async (request) => {
      if (typeof request.body === 'string') sentBodies.push(request.body);

      const response = await fetch(request.url ?? '', {
        method: request.method || 'GET',
        headers: Object.fromEntries(
          Object.entries(request.headers || {}).map(([key, value]) => [key, String(value)])
        ),
        body: typeof request.body === 'string' ? request.body : undefined,
      });
      const arrayBuffer = await response.arrayBuffer();
      const text = new TextDecoder().decode(arrayBuffer);

      let json: unknown = {};
      try {
        json = JSON.parse(text);
      } catch {
        // SSE responses are not JSON documents.
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        text,
        json,
        arrayBuffer,
      };
    });
  });

  it('streams thought-summary text when thinking is enabled', async () => {
    const apiKey = getEnv('GEMINI_API_KEY');
    if (!apiKey) throw new Error('GEMINI_API_KEY is required for this lane');

    const adapter = new GoogleAdapter(apiKey, model);
    let reasoning = '';
    let content = '';

    for await (const chunk of adapter.generateStreamAsync(
      'A farmer has 17 sheep. All but 9 run away. He then buys twice as many as remain and sells 5. Reason it through step by step, then give the final number.',
      { model, enableThinking: true, thinkingEffort: 'high', maxTokens: 2048 }
    )) {
      if (chunk.reasoning) reasoning += chunk.reasoning;
      content += chunk.content;
    }

    const request = JSON.parse(sentBodies[0] ?? '{}');
    expect(request.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);

    expect(content.trim().length).toBeGreaterThan(0);
    expect(reasoning.trim().length).toBeGreaterThan(0);
  });
});
