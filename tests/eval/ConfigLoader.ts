/**
 * tests/eval/ConfigLoader.ts — Loads YAML eval configs and resolves env vars.
 *
 * Reads a YAML config file (or uses default), validates required fields,
 * and resolves API key env var references. Used by eval.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import type { EvalConfig } from './types';

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
    timeout: 120_000,
    systemPrompt: 'default',
  },
  capture: {
    enabled: true,
    dumpOnFailure: true,
    artifactsDir: 'test-artifacts/',
  },
  scenarios: 'tests/eval/scenarios/**/*.eval.yaml',
};

/**
 * Load eval config from YAML file path, or return defaults.
 * Set EVAL_CONFIG env var to override the config file path.
 */
export function loadConfig(configPath?: string): EvalConfig {
  const resolvedPath = configPath || process.env.EVAL_CONFIG;

  if (!resolvedPath) {
    return DEFAULT_CONFIG;
  }

  const fullPath = path.isAbsolute(resolvedPath)
    ? resolvedPath
    : path.resolve(process.cwd(), resolvedPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Eval config not found: ${fullPath}`);
  }

  const raw = fs.readFileSync(fullPath, 'utf-8');
  const parsed = parseYaml(raw) as Partial<EvalConfig>;

  return mergeWithDefaults(parsed);
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
  };
}

/**
 * Resolve an API key from an env var name. Returns undefined if not set.
 */
export function resolveApiKey(envVarName: string): string | undefined {
  return process.env[envVarName];
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
