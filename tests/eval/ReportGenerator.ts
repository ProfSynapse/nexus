/**
 * tests/eval/ReportGenerator.ts — Markdown report generator for eval runs.
 *
 * Generates a timestamped markdown report summarizing scenario results,
 * failures, and metrics. Output goes to test-artifacts/ directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EvalRunResult, EvalConfig } from './types';

/** Machine-readable shape of an eval run, emitted alongside the markdown report. */
export interface EvalReportJson {
  config: string;
  mode: string;
  providers: string[];
  startTime: number;
  endTime: number;
  durationMs: number;
  metrics: { totalScenarios: number; pass: number; fail: number; passRate: number; retriesUsed: number };
  byModel: Array<{ model: string; pass: number; fail: number; total: number; passRate: number }>;
  results: Array<{
    scenario: string;
    model: string;
    fullModel: string;
    passed: boolean;
    excludedFromBoard: boolean;
    error: string | null;
    retryCount: number;
    durationMs: number;
    tracePath: string | null;
    turns: Array<{
      turnIndex: number;
      passed: boolean;
      errors: string[];
      textContent: string;
      toolCalls: Array<{ name: string; args: unknown }>;
    }>;
  }>;
}

/**
 * Generate a markdown report string from eval results.
 */
export function generateReport(runResult: EvalRunResult, config: EvalConfig): string {
  const timestamp = new Date(runResult.startTime).toISOString().replace('T', ' ').slice(0, 19);
  const totalDuration = ((runResult.endTime - runResult.startTime) / 1000).toFixed(1);

  const providerNames = Object.keys(config.providers).filter((p) => config.providers[p].enabled);
  const modelCount = providerNames.reduce(
    (sum, p) => sum + config.providers[p].models.length,
    0
  );

  const lines: string[] = [];

  lines.push(`# Eval Report — ${timestamp}`);
  lines.push('');
  lines.push(`## Config`);
  lines.push(`Mode: ${runResult.mode} | Providers: ${providerNames.join(', ')} | Models: ${modelCount}`);
  lines.push('');

  // Results summary table
  lines.push('## Results Summary');
  lines.push('| Scenario | Model | Status | Turns | Duration | Notes |');
  lines.push('|----------|-------|--------|-------|----------|-------|');

  for (const result of runResult.results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    const turnsPassed = result.turns.filter((t) => t.passed).length;
    const turnsTotal = result.turns.length;
    const duration = (result.totalDurationMs / 1000).toFixed(1);
    const notes = result.error
      ? result.error.slice(0, 60)
      : result.retryCount > 0
        ? `Retry needed (${result.retryCount})`
        : '';

    lines.push(
      `| ${result.scenario} | ${shortModel(result.model)} | ${status} | ${turnsPassed}/${turnsTotal} | ${duration}s | ${notes} |`
    );
  }

  lines.push('');

  // Failure details
  const failures = runResult.results.filter((r) => !r.passed);
  if (failures.length > 0) {
    lines.push('## Failures');

    for (const fail of failures) {
      lines.push(`### ${fail.scenario} x ${shortModel(fail.model)}`);

      if (fail.error) {
        lines.push(`- **Error**: ${fail.error}`);
      }
      if (fail.tracePath) {
        lines.push(`- **Trace**: ${fail.tracePath}`);
      }

      for (const turn of fail.turns.filter((t) => !t.passed)) {
        lines.push(`- **Turn ${turn.turnIndex + 1}**: ${turn.errors.join('; ')}`);
        if (turn.textContent.trim()) {
          lines.push(`  - Response: ${formatInlineSnippet(turn.textContent, 1000)}`);
        }
        if (turn.actualToolCalls.length > 0) {
          const callNames = turn.actualToolCalls.map((c) => c.name).join(', ');
          lines.push(`  - Actual calls: [${callNames}]`);
          for (const call of turn.actualToolCalls) {
            lines.push(
              `    - ${call.name} args: ${formatInlineSnippet(JSON.stringify(call.args), 500)}`
            );
          }
        }
      }
      lines.push('');
    }
  }

  // Metrics
  const totalScenarios = runResult.results.length;
  const passCount = runResult.results.filter((r) => r.passed).length;
  const failCount = totalScenarios - passCount;
  const passRate = totalScenarios > 0 ? Math.round((passCount / totalScenarios) * 100) : 0;
  const totalRetries = runResult.results.reduce((sum, r) => sum + r.retryCount, 0);

  lines.push('## Metrics');
  lines.push(`- Total scenarios: ${totalScenarios}`);
  lines.push(`- Pass: ${passCount} (${passRate}%)`);
  lines.push(`- Fail: ${failCount} (${100 - passRate}%)`);
  lines.push(`- Total duration: ${totalDuration}s`);
  lines.push(`- Retries used: ${totalRetries}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a machine-readable JSON report from eval results.
 *
 * Mirrors the markdown report but keeps the full, untruncated structure so
 * downstream analysis (failure-pattern bucketing, leaderboards, exact-payload
 * extraction) can run with `jq`/Python instead of regex-scraping markdown.
 * Tool-call args are kept as parsed objects, not stringified+truncated.
 */
export function generateReportJson(runResult: EvalRunResult, config: EvalConfig): EvalReportJson {
  const providerNames = Object.keys(config.providers).filter((p) => config.providers[p].enabled);
  const totalScenarios = runResult.results.length;
  const passCount = runResult.results.filter((r) => r.passed).length;

  // Per-model rollup so a leaderboard is one field away. Scenarios flagged
  // excludeFromBoard (known fixture bugs) are run + reported but do not count
  // toward pass rate.
  const byModelMap = new Map<string, { model: string; pass: number; fail: number; total: number }>();
  for (const r of runResult.results) {
    if (r.excludedFromBoard) continue;
    const key = shortModel(r.model);
    const agg = byModelMap.get(key) ?? { model: key, pass: 0, fail: 0, total: 0 };
    agg.total += 1;
    if (r.passed) agg.pass += 1;
    else agg.fail += 1;
    byModelMap.set(key, agg);
  }
  const byModel = [...byModelMap.values()]
    .map((m) => ({ ...m, passRate: m.total > 0 ? Math.round((m.pass / m.total) * 100) : 0 }))
    .sort((a, b) => b.passRate - a.passRate);

  return {
    config: runResult.config,
    mode: runResult.mode,
    providers: providerNames,
    startTime: runResult.startTime,
    endTime: runResult.endTime,
    durationMs: runResult.endTime - runResult.startTime,
    metrics: {
      totalScenarios,
      pass: passCount,
      fail: totalScenarios - passCount,
      passRate: totalScenarios > 0 ? Math.round((passCount / totalScenarios) * 100) : 0,
      retriesUsed: runResult.results.reduce((sum, r) => sum + r.retryCount, 0),
    },
    byModel,
    results: runResult.results.map((r) => ({
      scenario: r.scenario,
      model: shortModel(r.model),
      fullModel: r.model,
      passed: r.passed,
      excludedFromBoard: r.excludedFromBoard ?? false,
      error: r.error ?? null,
      retryCount: r.retryCount,
      durationMs: r.totalDurationMs,
      tracePath: r.tracePath ?? null,
      turns: r.turns.map((t) => ({
        turnIndex: t.turnIndex,
        passed: t.passed,
        errors: t.errors,
        textContent: t.textContent,
        toolCalls: t.actualToolCalls.map((c) => ({ name: c.name, args: c.args })),
      })),
    })),
  };
}

/**
 * Save report to a timestamped file.
 */
export function saveReport(report: string, artifactsDir: string, prefix = 'eval-report'): string {
  const filePath = resolveReportPath(artifactsDir, prefix, 'md');
  fs.writeFileSync(filePath, report, 'utf-8');
  return filePath;
}

/**
 * Save the machine-readable JSON report alongside the markdown one.
 */
export function saveReportJson(report: EvalReportJson, artifactsDir: string, prefix = 'eval-report'): string {
  const filePath = resolveReportPath(artifactsDir, prefix, 'json');
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
  return filePath;
}

function resolveReportPath(artifactsDir: string, prefix: string, ext: string): string {
  const dir = path.resolve(process.cwd(), artifactsDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '-');
  return path.join(dir, `${safePrefix}-${timestamp}.${ext}`);
}

function shortModel(model: string): string {
  // "anthropic/claude-sonnet-4.6" -> "claude-sonnet-4.6"
  const parts = model.split('/');
  return parts.length > 1 ? parts[parts.length - 1] : model;
}

function formatInlineSnippet(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return `\`${normalized}\``;
  }

  return `\`${normalized.slice(0, maxLength)}...[truncated]\``;
}
