/**
 * tests/eval/ConfigLoader.ts — Loads YAML eval configs and resolves env vars.
 *
 * Reads a YAML config file (or uses default), validates required fields,
 * and resolves API key env var references. Used by eval.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import type { EvalConfig, ProviderConfig } from './types';

// Local providers run against a keyless localhost OpenAI-compatible endpoint.
const KEYLESS_LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  requesty: 'REQUESTY_API_KEY',
};

const DEFAULT_CONFIG: EvalConfig = {
  mode: 'mock',
  testVaultPath: 'tests/eval/test-vault/',
  providers: {
    openrouter: {
      apiKeyEnv: 'OPENROUTER_API_KEY',
      models: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.4-mini'],
      enabled: true,
    },
  },
  defaults: {
    temperature: 0,
    maxRetries: 1,
    retryDelayMs: 2000,
    retryBackoffMultiplier: 2,
    retryMaxDelayMs: 30_000,
    timeout: 120_000,
    systemPrompt: 'default',
  },
  capture: {
    enabled: true,
    dumpOnFailure: true,
    artifactsDir: 'test-artifacts/',
  },
  scenarios: 'tests/eval/scenarios/**/*.eval.yaml',
  scenarioToolSet: 'all',
};

/**
 * Load eval config from YAML file path, or return defaults.
 * Set EVAL_CONFIG env var to override the config file path.
 */
export function loadConfig(configPath?: string): EvalConfig {
  const resolvedPath = configPath || process.env.EVAL_CONFIG;
  let config: EvalConfig;

  if (!resolvedPath) {
    config = DEFAULT_CONFIG;
  } else {
    const fullPath = path.isAbsolute(resolvedPath)
      ? resolvedPath
      : path.resolve(process.cwd(), resolvedPath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Eval config not found: ${fullPath}`);
    }

    const raw = fs.readFileSync(fullPath, 'utf-8');
    const parsed = parseYaml(raw) as Partial<EvalConfig>;

    config = mergeWithDefaults(parsed);
  }

  return applyEnvOverrides(config);
}

function applyEnvOverrides(config: EvalConfig): EvalConfig {
  const targets = getEvalTargets(config);
  const modeOverride = getEnv('EVAL_MODE');
  const scenariosOverride = getEnv('EVAL_SCENARIOS');
  const toolSetOverride = getEnv('EVAL_TOOL_SET');
  const scenarioNamesOverride = getListEnv('EVAL_SCENARIO_NAMES');

  return {
    ...config,
    mode: modeOverride === 'mock' || modeOverride === 'live'
      ? modeOverride
      : config.mode,
    providers: targets ?? config.providers,
    defaults: applyDefaultEnvOverrides(config.defaults),
    scenarios: scenariosOverride || config.scenarios,
    scenarioToolSet: isScenarioToolSet(toolSetOverride)
      ? toolSetOverride
      : config.scenarioToolSet,
    scenarioNames: scenarioNamesOverride ?? config.scenarioNames,
  };
}

function applyDefaultEnvOverrides(defaults: EvalConfig['defaults']): EvalConfig['defaults'] {
  return {
    ...defaults,
    maxRetries: getNumberEnv('EVAL_MAX_RETRIES') ?? defaults.maxRetries,
    retryDelayMs: getNumberEnv('EVAL_RETRY_DELAY_MS') ?? defaults.retryDelayMs,
    retryBackoffMultiplier: getNumberEnv('EVAL_RETRY_BACKOFF_MULTIPLIER')
      ?? defaults.retryBackoffMultiplier,
    retryMaxDelayMs: getNumberEnv('EVAL_RETRY_MAX_DELAY_MS') ?? defaults.retryMaxDelayMs,
    timeout: getNumberEnv('EVAL_TIMEOUT_MS') ?? defaults.timeout,
  };
}

function getEvalTargets(config: EvalConfig): Record<string, ProviderConfig> | null {
  const targetSpec = getEnv('EVAL_TARGETS');
  if (targetSpec) {
    return parseEvalTargets(targetSpec, config);
  }

  const provider = getEnv('EVAL_PROVIDER');
  const modelList = getEnv('EVAL_MODELS') || getEnv('EVAL_MODEL');
  if (!provider && !modelList) {
    return null;
  }

  if (!provider || !modelList) {
    throw new Error('EVAL_PROVIDER and EVAL_MODEL/EVAL_MODELS must be set together');
  }

  return parseEvalTargets(
    modelList
      .split(',')
      .map((model) => `${provider}=${model}`)
      .join(','),
    config
  );
}

function parseEvalTargets(spec: string, config: EvalConfig): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};
  const entries = spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error('EVAL_TARGETS did not contain any provider=model entries');
  }

  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new Error(
        `Invalid EVAL_TARGETS entry "${entry}". Use provider=model, e.g. openrouter=deepseek/deepseek-v4-flash`
      );
    }

    const provider = entry.slice(0, separatorIndex).trim();
    const model = normalizeModelForProvider(provider, entry.slice(separatorIndex + 1).trim());

    const existing = providers[provider] ?? {
      apiKeyEnv: config.providers[provider]?.apiKeyEnv ?? PROVIDER_API_KEY_ENV[provider],
      models: [],
      enabled: true,
    };

    if (!existing.apiKeyEnv) {
      throw new Error(
        `No API key env var is known for provider "${provider}". Add it to the eval config providers block.`
      );
    }

    if (!existing.models.includes(model)) {
      existing.models.push(model);
    }
    providers[provider] = existing;
  }

  return providers;
}

function normalizeModelForProvider(provider: string, model: string): string {
  if ((provider === 'openai' || provider === 'openai-codex') && model.startsWith('openai/')) {
    return model.slice('openai/'.length);
  }

  return model;
}

function isScenarioToolSet(value: string | undefined): value is NonNullable<EvalConfig['scenarioToolSet']> {
  return value === 'all' || value === 'meta' || value === 'nexus' || value === 'simple';
}

function mergeWithDefaults(partial: Partial<EvalConfig>): EvalConfig {
  return {
    mode: partial.mode ?? DEFAULT_CONFIG.mode,
    testVaultPath: partial.testVaultPath ?? DEFAULT_CONFIG.testVaultPath,
    providers: partial.providers ?? DEFAULT_CONFIG.providers,
    defaults: {
      ...DEFAULT_CONFIG.defaults,
      ...partial.defaults,
    },
    capture: {
      ...DEFAULT_CONFIG.capture,
      ...partial.capture,
    },
    scenarios: partial.scenarios ?? DEFAULT_CONFIG.scenarios,
    scenarioToolSet: partial.scenarioToolSet ?? DEFAULT_CONFIG.scenarioToolSet,
    scenarioNames: partial.scenarioNames,
  };
}

function readDotEnv(): Map<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  const values = new Map<string, string>();

  if (!fs.existsSync(envPath)) {
    return values;
  }

  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
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

function getNumberEnv(name: string): number | undefined {
  const value = getEnv(name);
  if (!value) {
    return undefined;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function getListEnv(name: string): string[] | undefined {
  const value = getEnv(name);
  if (!value) {
    return undefined;
  }

  const values = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return values.length > 0 ? values : undefined;
}

/**
 * Resolve an API key from an env var name. Returns undefined if not set.
 */
export function resolveApiKey(envVarName: string): string | undefined {
  return getEnv(envVarName);
}

/**
 * Get all enabled providers with resolved API keys.
 * Skips providers whose env var is not set.
 */
export function getEnabledProviders(
  config: EvalConfig
): Array<{ id: string; apiKey: string; models: string[] }> {
  const result: Array<{ id: string; apiKey: string; models: string[] }> = [];

  for (const [id, providerConfig] of Object.entries(config.providers)) {
    if (!providerConfig.enabled) continue;

    // Local providers (Ollama, LM Studio) run keyless against a localhost
    // OpenAI-compatible endpoint — they have no API key to resolve.
    if (KEYLESS_LOCAL_PROVIDERS.has(id)) {
      result.push({ id, apiKey: '', models: providerConfig.models });
      continue;
    }

    const apiKey = resolveApiKey(providerConfig.apiKeyEnv);
    if (!apiKey) {
      console.warn(
        `[EvalConfig] Provider "${id}" enabled but ${providerConfig.apiKeyEnv} not set — skipping`
      );
      continue;
    }

    result.push({ id, apiKey, models: providerConfig.models });
  }

  return result;
}
