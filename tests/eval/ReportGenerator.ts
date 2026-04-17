/**
 * tests/eval/ReportGenerator.ts — Markdown report generator for eval runs.
 *
 * Generates a timestamped markdown report summarizing scenario results,
 * failures, and metrics. Output goes to test-artifacts/ directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EvalRunResult, EvalConfig } from './types';

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

      for (const turn of fail.turns.filter((t) => !t.passed)) {
        lines.push(`- **Turn ${turn.turnIndex + 1}**: ${turn.errors.join('; ')}`);
        if (turn.actualToolCalls.length > 0) {
          const callNames = turn.actualToolCalls.map((c) => c.name).join(', ');
          lines.push(`  - Actual calls: [${callNames}]`);
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
 * Save report to a timestamped file.
 */
export function saveReport(report: string, artifactsDir: string, prefix = 'eval-report'): string {
  const dir = path.resolve(process.cwd(), artifactsDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '-');
  const filePath = path.join(dir, `${safePrefix}-${timestamp}.md`);
  fs.writeFileSync(filePath, report, 'utf-8');
  return filePath;
}

function shortModel(model: string): string {
  // "anthropic/claude-sonnet-4.6" -> "claude-sonnet-4.6"
  const parts = model.split('/');
  return parts.length > 1 ? parts[parts.length - 1] : model;
}
