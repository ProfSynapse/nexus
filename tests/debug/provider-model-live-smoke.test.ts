/**
 * Generic live model smoke tests.
 *
 * These tests hit real provider APIs and are skipped unless explicitly enabled.
 *
 * Run all default smoke targets:
 *   RUN_MODEL_SMOKE=1 npx jest tests/debug/provider-model-live-smoke.test.ts --runInBand --no-coverage --verbose
 *
 * Run one provider/model:
 *   RUN_MODEL_SMOKE=1 MODEL_SMOKE_PROVIDER=openai MODEL_SMOKE_MODEL=gpt-5.5 npx jest tests/debug/provider-model-live-smoke.test.ts --runInBand --no-coverage --verbose
 *   RUN_MODEL_SMOKE=1 MODEL_SMOKE_PROVIDER=openrouter MODEL_SMOKE_MODEL=gpt-5.5 npx jest tests/debug/provider-model-live-smoke.test.ts --runInBand --no-coverage --verbose
 *   RUN_MODEL_SMOKE=1 MODEL_SMOKE_PROVIDER=openai-codex MODEL_SMOKE_MODEL=gpt-5.5 npx jest tests/debug/provider-model-live-smoke.test.ts --runInBand --no-coverage --verbose
 *
 * Provider-specific overrides when running all:
 *   OPENAI_SMOKE_MODEL=gpt-5.5
 *   OPENROUTER_SMOKE_MODEL=openai/gpt-5.5
 *   CODEX_SMOKE_MODEL=gpt-5.5
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
import { OpenAICodexAdapter, type CodexOAuthTokens } from '../../src/services/llm/adapters/openai-codex/OpenAICodexAdapter';
import type { GenerateOptions, LLMResponse } from '../../src/services/llm/adapters/types';

jest.setTimeout(240_000);

type SmokeProvider = 'openai' | 'openrouter' | 'openai-codex';

interface ProviderSettingsShape {
  llmProviders?: {
    providers?: Record<string, {
      apiKey?: string;
      enabled?: boolean;
      oauth?: {
        refreshToken?: string;
        expiresAt?: number;
        metadata?: {
          accountId?: string;
        };
      };
    }>;
  };
}

interface SmokeTarget {
  provider: SmokeProvider;
  model: string;
}

const RUN_LIVE = process.env.RUN_MODEL_SMOKE === '1';
const PROVIDERS: SmokeProvider[] = ['openai', 'openrouter', 'openai-codex'];

function readDotEnv(): Map<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  const values = new Map<string, string>();

  if (!fs.existsSync(envPath)) {
    return values;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    values.set(match[1], match[2].replace(/^['"]|['"]$/g, ''));
  }

  return values;
}

const DOT_ENV = readDotEnv();

function getEnv(name: string): string | undefined {
  return process.env[name] || DOT_ENV.get(name);
}

function loadCodexTokensFromLocalDataJson(): CodexOAuthTokens | null {
  const dataPath = path.join(process.cwd(), 'data.json');
  if (!fs.existsSync(dataPath)) {
    return null;
  }

  const settings = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as ProviderSettingsShape;
  const config = settings.llmProviders?.providers?.['openai-codex'];
  const accountId = config?.oauth?.metadata?.accountId;

  if (!config?.enabled || !config.apiKey || !config.oauth?.refreshToken || !accountId) {
    return null;
  }

  return {
    accessToken: config.apiKey,
    refreshToken: config.oauth.refreshToken,
    expiresAt: config.oauth.expiresAt || 0,
    accountId,
  };
}

function normalizeModelForProvider(provider: SmokeProvider, model: string): string {
  if (provider === 'openrouter' && !model.includes('/')) {
    return `openai/${model}`;
  }

  if ((provider === 'openai' || provider === 'openai-codex') && model.startsWith('openai/')) {
    return model.slice('openai/'.length);
  }

  return model;
}

function getProviderModel(provider: SmokeProvider): string {
  const sharedOverride = getEnv('MODEL_SMOKE_MODEL');
  const providerOverride = {
    openai: getEnv('OPENAI_SMOKE_MODEL'),
    openrouter: getEnv('OPENROUTER_SMOKE_MODEL'),
    'openai-codex': getEnv('CODEX_SMOKE_MODEL'),
  }[provider];

  const model = providerOverride || sharedOverride || DEFAULT_MODELS[provider];
  return normalizeModelForProvider(provider, model);
}

function getTargets(): SmokeTarget[] {
  const providerFilter = getEnv('MODEL_SMOKE_PROVIDER');
  if (!providerFilter) {
    return PROVIDERS.map((provider) => ({ provider, model: getProviderModel(provider) }));
  }

  if (!PROVIDERS.includes(providerFilter as SmokeProvider)) {
    throw new Error(`MODEL_SMOKE_PROVIDER must be one of: ${PROVIDERS.join(', ')}`);
  }

  const provider = providerFilter as SmokeProvider;
  return [{ provider, model: getProviderModel(provider) }];
}

function setRequestUrlToRealFetch(): void {
  __setRequestUrlMock(async (request) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      headers[key] = String(value);
    }

    const response = await fetch(request.url ?? '', {
      method: request.method || 'GET',
      headers,
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
}

function createAdapter(provider: SmokeProvider): OpenAIAdapter | OpenRouterAdapter | OpenAICodexAdapter {
  if (provider === 'openai') {
    const apiKey = getEnv('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for OpenAI smoke tests');
    }
    return new OpenAIAdapter(apiKey);
  }

  if (provider === 'openrouter') {
    const apiKey = getEnv('OPENROUTER_API_KEY');
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is required for OpenRouter smoke tests');
    }
    return new OpenRouterAdapter(apiKey);
  }

  const tokens = loadCodexTokensFromLocalDataJson();
  if (!tokens) {
    throw new Error('Codex OAuth tokens are required in data.json for Codex smoke tests');
  }
  return new OpenAICodexAdapter(tokens);
}

async function callModel(target: SmokeTarget): Promise<LLMResponse> {
  const adapter = createAdapter(target.provider);
  const options: GenerateOptions = {
    model: target.model,
    systemPrompt: 'Follow the user instruction exactly.',
  };

  // Codex currently rejects max_output_tokens on the OAuth endpoint.
  if (target.provider !== 'openai-codex') {
    options.maxTokens = Number(getEnv('MODEL_SMOKE_MAX_TOKENS') || 16);
  }

  return adapter.generateUncached(
    'Reply with exactly this token and no other words: OK',
    options
  );
}

const describeLive = RUN_LIVE ? describe : describe.skip;

describeLive('generic provider model live smoke', () => {
  beforeAll(() => {
    setRequestUrlToRealFetch();
  });

  for (const target of getTargets()) {
    it(`calls ${target.provider} model ${target.model}`, async () => {
      const response = await callModel(target);

      expect(response.provider).toBe(target.provider);
      expect(response.model).toBe(target.model);
      expect(response.text.trim().length).toBeGreaterThan(0);
      expect(response.text.toUpperCase()).toContain('OK');
    });
  }
});
