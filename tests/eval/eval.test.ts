/**
 * tests/eval/eval.test.ts — Jest entry point for the LLM eval harness.
 *
 * Loads config (from EVAL_CONFIG env var or defaults), discovers scenario
 * YAML files, resolves enabled providers, and runs each scenario against
 * every provider+model combination. Generates a markdown report on completion.
 *
 * Usage:
 *   # Run with default config
 *   RUN_EVAL=1 npx jest tests/eval/eval.test.ts --no-coverage --verbose
 *
 *   # Run with specific config
 *   RUN_EVAL=1 EVAL_CONFIG=tests/eval/configs/default.yaml npx jest tests/eval/eval.test.ts --no-coverage --verbose
 *
 *   # Run arbitrary live provider/model targets in parallel
 *   RUN_EVAL=1 EVAL_MODE=live EVAL_TOOL_SET=meta EVAL_TARGETS='openrouter=deepseek/deepseek-v4-pro,openrouter=deepseek/deepseek-v4-flash' npx jest tests/eval/eval.test.ts --runInBand --no-coverage --verbose
 */

import { loadConfig, getEnabledProviders } from './ConfigLoader';
import { loadScenarios } from './ScenarioLoader';
import { RequestCapture } from './RequestCapture';
import { calculateMaxRetryDelayMs, runScenario } from './EvalRunner';
import { generateReport, saveReport } from './ReportGenerator';
import { META_TOOLS, NEXUS_TOOLS, SIMPLE_TOOLS } from './fixtures/tools';
import { DEFAULT_SYSTEM_PROMPT, MINIMAL_SYSTEM_PROMPT, initializeSystemPrompts } from './fixtures/system-prompt';
import type { EvalConfig, EvalScenario, ScenarioResult, ToolSetType } from './types';
import type { Tool } from '../../src/services/llm/adapters/types';

// ---------------------------------------------------------------------------
// Config + setup
// ---------------------------------------------------------------------------

const config = loadConfig();
const enabledProviders = getEnabledProviders(config);
const capture = new RequestCapture();

const RUN_EVAL = process.env.RUN_EVAL === '1' && enabledProviders.length > 0;

(globalThis as typeof globalThis & { require?: NodeRequire }).require = require;

// Install request capture + initialize production system prompts
beforeAll(async () => {
  capture.install(config.capture);
  await initializeSystemPrompts();
});

// ---------------------------------------------------------------------------
// System prompt resolution
// ---------------------------------------------------------------------------

function resolveSystemPrompt(prompt: string): string {
  if (prompt === 'default') return DEFAULT_SYSTEM_PROMPT;
  if (prompt === 'minimal') return MINIMAL_SYSTEM_PROMPT;
  return prompt;
}

// ---------------------------------------------------------------------------
// Tool set resolution — default to META_TOOLS (production two-tool arch)
// ---------------------------------------------------------------------------

function resolveToolSet(toolSet: ToolSetType | undefined): Tool[] {
  switch (toolSet) {
    case 'nexus': return NEXUS_TOOLS;
    case 'simple': return SIMPLE_TOOLS;
    case 'meta':
    default: return META_TOOLS;
  }
}

function sanitizeScopeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildModelReportPrefix(providerId: string, model: string): string {
  return `eval-report-${providerId}-${model.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function shouldRunScenario(scenario: EvalScenario, providerId: string, model: string): boolean {
  if (config.scenarioNames && !config.scenarioNames.includes(scenario.name)) {
    return false;
  }

  if (config.scenarioToolSet && config.scenarioToolSet !== 'all') {
    const scenarioToolSet = scenario.toolSet ?? 'meta';
    if (scenarioToolSet !== config.scenarioToolSet) {
      return false;
    }
  }

  if (scenario.providers && !scenario.providers.includes(providerId)) return false;
  if (scenario.models && !scenario.models.includes(model)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Scenario loading + test generation
// ---------------------------------------------------------------------------

describe('LLM Eval Harness', () => {
  if (!RUN_EVAL) {
    it('skips — no API keys configured', () => {
      const missingVars = Object.entries(config.providers)
        .filter(([, p]) => p.enabled)
        .map(([, p]) => p.apiKeyEnv);
      console.log(
        `\nEval harness skipped: set RUN_EVAL=1 and API key env vars [${missingVars.join(', ')}] to enable.`
      );
      expect(true).toBe(true);
    });
    return;
  }

  const allResults: ScenarioResult[] = [];
  const startTime = Date.now();
  const testTimeoutMs = (
    config.defaults.timeout * (config.defaults.maxRetries + 1) * 2
  ) + calculateMaxRetryDelayMs(config.defaults.maxRetries, config) + 10_000;

  it('runs the configured provider/model/scenario matrix in parallel', async () => {
    const scenarios = await loadScenarios(config.scenarios);
    if (scenarios.length === 0) {
      console.warn('[Eval] No scenarios loaded — check scenarios glob pattern');
    }

    const jobs = enabledProviders.flatMap((provider) =>
      provider.models.flatMap((model) =>
        scenarios
          .filter((scenario) => shouldRunScenario(scenario, provider.id, model))
          .map((scenario) => ({ provider, model, scenario }))
      )
    );

    if (jobs.length === 0) {
      console.warn('[Eval] No runnable provider/model/scenario jobs after filters');
    }

    const results = await Promise.all(jobs.map(async ({ provider, model, scenario }) => {
      const shortModel = model.split('/').pop() || model;
      const resolvedScenario = {
        ...scenario,
        systemPrompt: resolveSystemPrompt(
          scenario.systemPrompt ?? config.defaults.systemPrompt
        ),
      };

      console.log(`  [${provider.id}/${shortModel}] Running: ${scenario.name}`);

      // The production MCP surface is the two-tool architecture: the model is
      // only ever given getTools/useTools and must discover domain tools through
      // getTools. Present that same surface for every scenario so we grade tool
      // use the way it actually happens in the app. (A scenario's expected
      // domain tool — e.g. contentManager_read — is still asserted: useTools
      // unwraps to it.) scenario.toolSet remains meaningful only as a filter
      // key (EVAL_TOOL_SET), not as what schemas the model sees.
      const tools = resolveToolSet('meta');
      const captureScopeId = sanitizeScopeId(`${provider.id}_${shortModel}_${scenario.name}`);

      const result = await capture.runWithScope(captureScopeId, async () => {
        return await runScenario(
          resolvedScenario,
          provider,
          model,
          tools,
          config
        );
      });

      if (!result.passed && config.capture.dumpOnFailure) {
        const dumpPath = capture.dumpScopeOnFailure(
          captureScopeId,
          config.capture.artifactsDir
        );
        if (dumpPath) {
          console.log(`  [${provider.id}/${shortModel}] Request capture dumped: ${dumpPath}`);
        }
      }

      const status = result.passed ? 'PASS' : 'FAIL';
      const turnsPassed = result.turns.filter((t) => t.passed).length;
      console.log(
        `  [${provider.id}/${shortModel}] ${status}: ${scenario.name} (${turnsPassed}/${result.turns.length} turns, ${(result.totalDurationMs / 1000).toFixed(1)}s)`
      );

      if (!result.passed) {
        for (const turn of result.turns.filter((t) => !t.passed)) {
          console.log(`    Turn ${turn.turnIndex + 1}: ${turn.errors.join('; ')}`);
        }
      }

      return result;
    }));

    allResults.push(...results);

    const resultsByModel = new Map<string, ScenarioResult[]>();
    for (const result of results) {
      const key = `${result.provider}:${result.model}`;
      const modelResults = resultsByModel.get(key) ?? [];
      modelResults.push(result);
      resultsByModel.set(key, modelResults);
    }

    for (const [key, modelResults] of resultsByModel) {
      const [providerId, ...modelParts] = key.split(':');
      const model = modelParts.join(':');
      const shortModel = model.split('/').pop() || model;
      const modelRunResult = {
        config: process.env.EVAL_CONFIG || 'default',
        mode: config.mode,
        results: modelResults,
        startTime,
        endTime: Date.now(),
      };

      const modelReport = generateReport(modelRunResult, config);
      const modelReportPath = saveReport(
        modelReport,
        config.capture.artifactsDir,
        buildModelReportPrefix(providerId, shortModel),
      );

      const passed = modelResults.filter((r) => r.passed).length;
      console.log(`  [${providerId}/${shortModel}] Report saved: ${modelReportPath}`);
      console.log(`\n  [${providerId}/${shortModel}] Summary: ${passed}/${modelResults.length} scenarios passed`);
    }

    expect(results.length).toBeGreaterThan(0);
  }, testTimeoutMs);

  afterAll(() => {
    // Generate and save report
    if (allResults.length > 0) {
      const runResult = {
        config: process.env.EVAL_CONFIG || 'default',
        mode: config.mode,
        results: allResults,
        startTime,
        endTime: Date.now(),
      };

      const report = generateReport(runResult, config);
      const reportPath = saveReport(report, config.capture.artifactsDir);
      console.log(`\n[Eval] Report saved: ${reportPath}`);
      console.log(report);
    }
  });

  // Summary test
  describe('Configuration summary', () => {
    it('lists configured providers and models', () => {
      console.log(`\n[Eval] Mode: ${config.mode}`);
      console.log(`[Eval] Providers: ${enabledProviders.map((p) => p.id).join(', ')}`);
      console.log(
        `[Eval] Models: ${enabledProviders.flatMap((p) => p.models).join(', ')}`
      );
      console.log(`[Eval] Scenario glob: ${config.scenarios}`);
      expect(enabledProviders.length).toBeGreaterThan(0);
    });
  });
});
