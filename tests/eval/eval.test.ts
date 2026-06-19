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

import * as fs from 'fs';
import * as path from 'path';
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

// ---------------------------------------------------------------------------
// Concurrency control
//
// Cloud providers tolerate full fan-out, but local single-slot servers
// (Ollama, LM Studio) serialize inference: firing every scenario at once just
// makes them queue and blow past the per-request timeout (manifesting as a wave
// of 500s and a discarded run). Default to serial for local providers; override
// with EVAL_CONCURRENCY=N for any provider.
// ---------------------------------------------------------------------------

const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);

function resolveConcurrency(providers: Array<{ id: string }>): number {
  const override = Number(process.env.EVAL_CONCURRENCY);
  if (Number.isFinite(override) && override >= 1) return Math.floor(override);
  if (providers.some((p) => LOCAL_PROVIDERS.has(p.id))) return 1;
  return Infinity;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isFinite(limit) || limit >= items.length) {
    return Promise.all(items.map((item, index) => fn(item, index)));
  }

  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Streaming progress log
//
// jest buffers stdout in non-TTY runs, so per-scenario console.log only surfaces
// when the whole run ends. This appends one line per completed case to a log
// file that can be `tail -f`'d live while a (often slow, local) run is in flight.
// ---------------------------------------------------------------------------

function createProgressLog(
  artifactsDir: string,
  startedAtMs: number,
  totalJobs: number,
  concurrency: number
): { path: string; record: (line: string) => void } {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const stamp = new Date(startedAtMs).toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(artifactsDir, `eval-progress-${stamp}.log`);
  const lanes = Number.isFinite(concurrency) ? String(concurrency) : 'all';
  fs.writeFileSync(
    logPath,
    `# Eval progress — ${totalJobs} jobs, concurrency=${lanes} — started ${new Date(startedAtMs).toISOString()}\n`
  );
  return {
    path: logPath,
    record: (line: string) => {
      try {
        fs.appendFileSync(logPath, `${line}\n`);
      } catch {
        /* progress logging is best-effort — never fail a run over it */
      }
    },
  };
}

// Cheap synchronous upper-bound count of scenario files for the glob's base dir.
// Used only to size the jest test timeout — an overestimate is harmless.
function countScenarioFiles(globPattern: string): number {
  const base = (globPattern.split('**')[0] || 'tests/eval/scenarios/').replace(/\/+$/, '');
  const root = path.isAbsolute(base) ? base : path.resolve(process.cwd(), base);
  let count = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.eval.yaml')) count += 1;
    }
  };
  walk(root);
  return count;
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
  // jest's per-test timeout must cover the WHOLE matrix. A parallel run finishes
  // in roughly one case's worst-case budget; a serial run (local single-slot
  // providers) needs the sum across every serialized lane. Scale by lane count
  // so serial local grades don't trip the timeout mid-run. Override with
  // EVAL_TEST_TIMEOUT_MS.
  const perCaseBudgetMs =
    config.defaults.timeout * (config.defaults.maxRetries + 1) +
    calculateMaxRetryDelayMs(config.defaults.maxRetries, config);
  const dispatchConcurrency = resolveConcurrency(enabledProviders);
  const estimatedJobs = Math.max(
    1,
    countScenarioFiles(config.scenarios) *
      enabledProviders.reduce((sum, p) => sum + p.models.length, 0)
  );
  const serialLanes = Number.isFinite(dispatchConcurrency)
    ? Math.ceil(estimatedJobs / Math.max(1, dispatchConcurrency))
    : 1;
  const testTimeoutMs =
    Number(process.env.EVAL_TEST_TIMEOUT_MS) ||
    perCaseBudgetMs * (serialLanes + 1) + 10_000;

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

    const concurrency = resolveConcurrency(enabledProviders);
    const progress = createProgressLog(
      config.capture.artifactsDir,
      startTime,
      jobs.length,
      concurrency
    );
    let completed = 0;
    console.log(
      `  [Eval] ${jobs.length} jobs, concurrency=${Number.isFinite(concurrency) ? concurrency : 'all'} → live progress: ${progress.path}`
    );

    const results = await mapWithConcurrency(jobs, concurrency, async ({ provider, model, scenario }) => {
      const shortModel = model.split('/').pop() || model;
      const resolvedScenario = {
        ...scenario,
        systemPrompt: resolveSystemPrompt(
          scenario.systemPrompt ?? config.defaults.systemPrompt
        ),
      };

      console.log(`  [${provider.id}/${shortModel}] Running: ${scenario.name}`);

      const jobStartMs = Date.now();
      const finish = (result: ScenarioResult): ScenarioResult => {
        completed += 1;
        const status = result.passed ? 'PASS' : 'FAIL';
        const turnsPassed = result.turns.filter((t) => t.passed).length;
        const detail = result.error
          ? `ERROR: ${result.error}`
          : `${turnsPassed}/${result.turns.length} turns`;
        progress.record(
          `[${new Date().toISOString()}] ${completed}/${jobs.length} ${status} ${provider.id}/${shortModel} :: ${scenario.name} (${detail}, ${(result.totalDurationMs / 1000).toFixed(1)}s)`
        );
        return result;
      };

      try {

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

      return finish(result);
      } catch (err) {
        // A thrown job (e.g. an HTTP/timeout error from the adapter) used to
        // reject the whole Promise.all and discard the entire report. Record it
        // as a failed scenario instead so siblings still complete and a partial
        // report is generated.
        const message = err instanceof Error ? err.message : String(err);
        console.log(`  [${provider.id}/${shortModel}] ERROR: ${scenario.name} — ${message}`);
        return finish({
          scenario: scenario.name,
          description: scenario.description ?? '',
          provider: provider.id,
          model,
          passed: false,
          turns: [],
          totalDurationMs: Date.now() - jobStartMs,
          retryCount: 0,
          error: message,
        });
      }
    });

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
