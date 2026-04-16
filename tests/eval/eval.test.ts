/**
 * tests/eval/eval.test.ts — Jest entry point for the LLM eval harness.
 *
 * Loads config (from EVAL_CONFIG env var or defaults), discovers scenario
 * YAML files, resolves enabled providers, and runs each scenario against
 * every provider+model combination. Generates a markdown report on completion.
 *
 * Usage:
 *   # Run with default config
 *   npx jest tests/eval/eval.test.ts --no-coverage --verbose
 *
 *   # Run with specific config
 *   EVAL_CONFIG=tests/eval/configs/default.yaml npx jest tests/eval/eval.test.ts --no-coverage --verbose
 */

import { loadConfig, getEnabledProviders } from './ConfigLoader';
import { loadScenarios } from './ScenarioLoader';
import { RequestCapture } from './RequestCapture';
import { runScenario } from './EvalRunner';
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

const RUN_EVAL = enabledProviders.length > 0;

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
        `\nEval harness skipped: set one of [${missingVars.join(', ')}] to enable.`
      );
      expect(true).toBe(true);
    });
    return;
  }

  let scenarios: EvalScenario[] = [];
  const allResults: ScenarioResult[] = [];
  const startTime = Date.now();

  beforeAll(async () => {
    scenarios = await loadScenarios(config.scenarios);
    if (scenarios.length === 0) {
      console.warn('[Eval] No scenarios loaded — check scenarios glob pattern');
    }
  });

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

  // Create test cases for each provider+model
  for (const provider of enabledProviders) {
    for (const model of provider.models) {
      const shortModel = model.split('/').pop() || model;

      describe(`${provider.id}/${shortModel}`, () => {
        // We use a dynamic test that loads and runs all scenarios
        // since scenarios are loaded asynchronously in beforeAll
        it('runs all eval scenarios', async () => {
          if (scenarios.length === 0) {
            console.warn('No scenarios to run');
            return;
          }

          const results: ScenarioResult[] = [];

          for (const scenario of scenarios) {
            // Skip if scenario restricts providers/models
            if (scenario.providers && !scenario.providers.includes(provider.id)) continue;
            if (scenario.models && !scenario.models.includes(model)) continue;

            // Resolve system prompt
            const resolvedScenario = {
              ...scenario,
              systemPrompt: resolveSystemPrompt(
                scenario.systemPrompt ?? config.defaults.systemPrompt
              ),
            };

            console.log(`  [${shortModel}] Running: ${scenario.name}`);

            const tools = resolveToolSet(scenario.toolSet);

            const result = await runScenario(
              resolvedScenario,
              provider,
              model,
              tools,
              config
            );

            results.push(result);
            allResults.push(result);

            // Dump captures on failure
            if (!result.passed && config.capture.dumpOnFailure) {
              const dumpPath = capture.dumpOnFailure(
                `${scenario.name}_${shortModel}`,
                config.capture.artifactsDir
              );
              if (dumpPath) {
                console.log(`  [${shortModel}] Request capture dumped: ${dumpPath}`);
              }
            }

            // Reset capture between scenarios
            capture.reset();

            const status = result.passed ? 'PASS' : 'FAIL';
            const turnsPassed = result.turns.filter((t) => t.passed).length;
            console.log(
              `  [${shortModel}] ${status}: ${scenario.name} (${turnsPassed}/${result.turns.length} turns, ${(result.totalDurationMs / 1000).toFixed(1)}s)`
            );

            if (!result.passed) {
              for (const turn of result.turns.filter((t) => !t.passed)) {
                console.log(`    Turn ${turn.turnIndex + 1}: ${turn.errors.join('; ')}`);
              }
            }
          }

          // Assert at least one scenario ran
          expect(results.length).toBeGreaterThan(0);

          // Log summary
          const passed = results.filter((r) => r.passed).length;
          console.log(
            `\n  [${shortModel}] Summary: ${passed}/${results.length} scenarios passed`
          );
        }, config.defaults.timeout * scenarios.length || 600_000);
      });
    }
  }

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
