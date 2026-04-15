/**
 * tests/eval/ScenarioLoader.ts — Loads YAML scenario files from a directory.
 *
 * Reads scenario YAML files from disk and parses them into EvalScenario[].
 * Each YAML file contains an array of scenario objects. Used by eval.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import type { EvalScenario } from './types';

/**
 * Load all scenarios matching the glob-like pattern.
 * Supports simple patterns like "tests/eval/scenarios/**\/*.eval.yaml".
 */
export async function loadScenarios(
  pattern: string,
  basePath?: string
): Promise<EvalScenario[]> {
  const cwd = basePath || process.cwd();

  // Extract the base directory and file suffix from the pattern
  // e.g., "tests/eval/scenarios/**/*.eval.yaml" -> dir="tests/eval/scenarios", suffix=".eval.yaml"
  const parts = pattern.split('**/');
  const baseDir = path.resolve(cwd, parts[0].replace(/\/$/, ''));
  const fileSuffix = parts.length > 1 ? parts[1].replace(/^\*/, '') : '.eval.yaml';

  if (!fs.existsSync(baseDir)) {
    console.warn(`[ScenarioLoader] Directory not found: ${baseDir}`);
    return [];
  }

  const files = findFilesRecursive(baseDir, fileSuffix);

  if (files.length === 0) {
    console.warn(`[ScenarioLoader] No scenario files found in: ${baseDir}`);
    return [];
  }

  const scenarios: EvalScenario[] = [];

  for (const file of files.sort()) {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = parseYaml(raw);
    const fileName = path.basename(file);

    if (!Array.isArray(parsed)) {
      console.warn(`[ScenarioLoader] ${fileName}: expected array, got ${typeof parsed} — skipping`);
      continue;
    }

    for (const entry of parsed) {
      if (!entry.name || !entry.turns) {
        console.warn(`[ScenarioLoader] ${fileName}: scenario missing name or turns — skipping`);
        continue;
      }
      scenarios.push(entry as EvalScenario);
    }
  }

  return scenarios;
}

/**
 * Recursively find files ending with a given suffix.
 */
function findFilesRecursive(dir: string, suffix: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesRecursive(fullPath, suffix));
    } else if (entry.name.endsWith(suffix)) {
      results.push(fullPath);
    }
  }

  return results;
}
