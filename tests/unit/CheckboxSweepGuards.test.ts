/**
 * Checkbox Sweep Guards (C-5)
 *
 * Falsifiability fence: after PR2 removed the row-leading checkbox from
 * task rows (per V3 mockup, .setting-item.is-task uses an Edit/Delete icon
 * pair instead of a checkbox), no production source under src/ or stylesheet
 * under styles.css may re-introduce the legacy hooks. This file scans the
 * tree and asserts the legacy identifiers are absent.
 *
 * Implementation: fs.readFile + recursive walk + regex match. Pure-Node;
 * CI/Windows-portable; no shell-out to grep.
 *
 * If a future PR legitimately reintroduces a task-completion checkbox, this
 * guard will fail loudly — at which point the PR author should rename the
 * identifier (e.g., `handleTaskStatusToggle` + `.nexus-task-status-toggle`)
 * and update this guard's banned list with a justification comment.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(ROOT, 'src');
const STYLES_FILE = path.join(ROOT, 'styles.css');

const BANNED_IDENTIFIERS = [
  'handleTaskCheckboxChange',
  'nexus-task-checkbox'
];

async function* walkFiles(dir: string, extensions: string[]): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules / dist / coverage if they ever appear under src/.
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') continue;
      yield* walkFiles(full, extensions);
    } else if (entry.isFile()) {
      if (extensions.some(ext => entry.name.endsWith(ext))) {
        yield full;
      }
    }
  }
}

async function scanForIdentifiers(
  files: AsyncIterable<string>,
  needles: readonly string[]
): Promise<Array<{ file: string; needle: string; line: number; snippet: string }>> {
  const hits: Array<{ file: string; needle: string; line: number; snippet: string }> = [];
  for await (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const needle of needles) {
        if (line.includes(needle)) {
          hits.push({
            file: path.relative(ROOT, file),
            needle,
            line: i + 1,
            snippet: line.trim().slice(0, 120)
          });
        }
      }
    }
  }
  return hits;
}

describe('Checkbox sweep guards (C-5)', () => {
  describe('src/ tree', () => {
    it('contains no occurrence of `handleTaskCheckboxChange`', async () => {
      const hits = await scanForIdentifiers(
        walkFiles(SRC_DIR, ['.ts', '.tsx']),
        ['handleTaskCheckboxChange']
      );
      expect(hits).toEqual([]);
    });

    it('contains no occurrence of `nexus-task-checkbox`', async () => {
      const hits = await scanForIdentifiers(
        walkFiles(SRC_DIR, ['.ts', '.tsx', '.css']),
        ['nexus-task-checkbox']
      );
      expect(hits).toEqual([]);
    });
  });

  describe('styles.css', () => {
    it('contains no `.nexus-task-checkbox` selector', async () => {
      const text = await fs.readFile(STYLES_FILE, 'utf8');
      const lines = text.split(/\r?\n/);
      const hits: Array<{ line: number; snippet: string }> = [];
      lines.forEach((line, i) => {
        if (line.includes('nexus-task-checkbox')) {
          hits.push({ line: i + 1, snippet: line.trim() });
        }
      });
      expect(hits).toEqual([]);
    });
  });

  describe('combined sweep — both identifiers absent across the surface', () => {
    it('no .ts/.tsx file under src/ contains any banned identifier', async () => {
      const hits = await scanForIdentifiers(
        walkFiles(SRC_DIR, ['.ts', '.tsx']),
        BANNED_IDENTIFIERS
      );
      if (hits.length > 0) {
        const summary = hits.map(h => `  ${h.file}:${h.line} → "${h.needle}" — ${h.snippet}`).join('\n');
        throw new Error(`Banned identifier(s) re-introduced into src/:\n${summary}`);
      }
      expect(hits).toEqual([]);
    });
  });
});
