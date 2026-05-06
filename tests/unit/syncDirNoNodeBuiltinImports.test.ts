/**
 * P1.7.g — Mobile-path import-leak guard.
 *
 * The reconcile pipeline + watcher run on Obsidian mobile (`isDesktopOnly:
 * false`). Top-level imports execute at module init, BEFORE any
 * `Platform.isDesktop` guard can run, so a single top-level Node built-in
 * import in `src/database/sync/` or `src/database/storage/vaultRoot/` is
 * enough to crash plugin boot on mobile.
 *
 * This test does a static regex sweep of the canonical source for these
 * directories and fails if any disallowed top-level import sneaks in. It is
 * intentionally a *static* check — not a runtime probe — because the failure
 * mode (mobile boot crash) cannot be reproduced inside Jest.
 *
 * Allow-list rationale: Obsidian's API surface is the only "native"
 * dependency permitted; everything else must come from project source.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = [
  path.join(REPO_ROOT, 'src', 'database', 'sync'),
  path.join(REPO_ROOT, 'src', 'database', 'storage', 'vaultRoot'),
  path.join(REPO_ROOT, 'src', 'database', 'storage', 'SQLiteSyncStateStore.ts'),
];

/**
 * Node.js built-ins that are unsafe at top level on Obsidian mobile.
 * `node:`-prefixed and bare specifiers both covered.
 */
const FORBIDDEN_BUILTINS = new Set([
  'fs', 'fs/promises',
  'path',
  'http', 'https',
  'crypto',
  'events',
  'stream',
  'net',
  'os',
  'url',
  'process',
  'buffer',
  'child_process',
  'cluster',
  'dgram',
  'dns',
  'readline',
  'tls',
  'util',
  'vm',
  'worker_threads',
  'zlib',
]);

/**
 * Top-level npm packages with known Node.js transitive deps that crash on
 * mobile when imported at module init. From CLAUDE.md "Mobile Compatibility".
 */
const FORBIDDEN_NPM = new Set([
  'mammoth',
  'jszip',
  'xlsx',
  'yaml',
]);

const IMPORT_REGEX = /^\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/;
const REQUIRE_REGEX = /^\s*(?:const|let|var)\s+.+=\s*require\(['"]([^'"]+)['"]\)/;

interface OffendingImport {
  filePath: string;
  lineNumber: number;
  specifier: string;
  category: 'node-builtin' | 'forbidden-npm';
  rawLine: string;
}

function normalizeSpecifier(spec: string): string {
  // Strip `node:` prefix so `node:fs` and `fs` collapse to one bucket.
  return spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
}

function classify(spec: string): 'node-builtin' | 'forbidden-npm' | null {
  const normalized = normalizeSpecifier(spec);
  if (FORBIDDEN_BUILTINS.has(normalized)) return 'node-builtin';
  // Sub-path: e.g., `fs/promises`, but also `mammoth/something`.
  const head = normalized.split('/')[0];
  if (FORBIDDEN_BUILTINS.has(head)) return 'node-builtin';
  if (FORBIDDEN_NPM.has(head)) return 'forbidden-npm';
  return null;
}

async function listTsFilesRecursive(start: string): Promise<string[]> {
  const stat = await fs.stat(start);
  if (stat.isFile()) {
    return start.endsWith('.ts') ? [start] : [];
  }
  if (!stat.isDirectory()) return [];
  const entries = await fs.readdir(start, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(start, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTsFilesRecursive(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

async function scanFile(filePath: string): Promise<OffendingImport[]> {
  const text = await fs.readFile(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const offenders: OffendingImport[] = [];

  let inMultilineImport = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip lines that are clearly inside a function body — only top-level
    // `import` / `require` statements matter for module-init crashes.
    // Heuristic: if the line starts with whitespace AND we're not currently
    // tracking a multi-line import, it's nested. Accept multi-line imports
    // because their `from '...'` clause may live on a later line.
    const isImportStart = /^\s*import\b/.test(line);
    const isRequireStart = /^\s*(?:const|let|var)\s+.+\brequire\s*\(/.test(line);

    if (inMultilineImport || isImportStart) {
      const match = line.match(IMPORT_REGEX);
      if (match) {
        const category = classify(match[1]);
        if (category) {
          offenders.push({
            filePath,
            lineNumber: i + 1,
            specifier: match[1],
            category,
            rawLine: trimmed,
          });
        }
        inMultilineImport = false;
      } else if (isImportStart) {
        // Started but didn't terminate on this line — keep looking.
        inMultilineImport = !line.includes(';');
      }
      continue;
    }

    if (isRequireStart) {
      const match = line.match(REQUIRE_REGEX);
      if (match) {
        const category = classify(match[1]);
        if (category) {
          offenders.push({
            filePath,
            lineNumber: i + 1,
            specifier: match[1],
            category,
            rawLine: trimmed,
          });
        }
      }
    }
  }

  return offenders;
}

describe('P1.7.g — sync directories must not top-level import Node built-ins', () => {
  it('src/database/sync/ has no top-level Node-builtin or forbidden-npm imports', async () => {
    const files = await listTsFilesRecursive(SCAN_DIRS[0]);
    expect(files.length).toBeGreaterThan(0);

    const offenders: OffendingImport[] = [];
    for (const f of files) {
      offenders.push(...(await scanFile(f)));
    }

    if (offenders.length > 0) {
      const report = offenders
        .map(
          (o) =>
            `  ${path.relative(REPO_ROOT, o.filePath)}:${o.lineNumber}` +
            `  [${o.category}]  ${o.specifier}\n    > ${o.rawLine}`
        )
        .join('\n');
      throw new Error(
        `Mobile boot crash risk: ${offenders.length} forbidden top-level import(s) ` +
          `in src/database/sync/. Move these into async functions behind ` +
          `desktopRequire() or dynamic import().\n${report}`
      );
    }
  });

  it('src/database/storage/vaultRoot/ has no top-level Node-builtin or forbidden-npm imports', async () => {
    const files = await listTsFilesRecursive(SCAN_DIRS[1]);
    expect(files.length).toBeGreaterThan(0);

    const offenders: OffendingImport[] = [];
    for (const f of files) {
      offenders.push(...(await scanFile(f)));
    }

    if (offenders.length > 0) {
      const report = offenders
        .map(
          (o) =>
            `  ${path.relative(REPO_ROOT, o.filePath)}:${o.lineNumber}` +
            `  [${o.category}]  ${o.specifier}\n    > ${o.rawLine}`
        )
        .join('\n');
      throw new Error(
        `Mobile boot crash risk: ${offenders.length} forbidden top-level import(s) ` +
          `in src/database/storage/vaultRoot/.\n${report}`
      );
    }
  });

  it('src/database/storage/SQLiteSyncStateStore.ts has no top-level Node-builtin or forbidden-npm imports', async () => {
    const offenders = await scanFile(SCAN_DIRS[2]);

    if (offenders.length > 0) {
      const report = offenders
        .map((o) => `  ${path.relative(REPO_ROOT, o.filePath)}:${o.lineNumber}  [${o.category}]  ${o.specifier}\n    > ${o.rawLine}`)
        .join('\n');
      throw new Error(
        `Mobile boot crash risk in SQLiteSyncStateStore.ts:\n${report}`
      );
    }
  });

  it('classifier sanity: detects fs, node:fs, fs/promises, and mammoth as forbidden', () => {
    expect(classify('fs')).toBe('node-builtin');
    expect(classify('node:fs')).toBe('node-builtin');
    expect(classify('fs/promises')).toBe('node-builtin');
    expect(classify('node:fs/promises')).toBe('node-builtin');
    expect(classify('mammoth')).toBe('forbidden-npm');
    expect(classify('jszip')).toBe('forbidden-npm');
    expect(classify('obsidian')).toBeNull();
    expect(classify('../../src/utils/AsyncLock')).toBeNull();
    expect(classify('uuid')).toBeNull();
  });

  it('scanner sanity: flags a synthetic offending file pattern', async () => {
    // Construct a synthetic source string and run the regex+classifier path
    // directly to prove the scanner *would* flag a real top-level fs import.
    const synthetic = [
      "import { promises as fsx } from 'fs';",
      "import { App } from 'obsidian';",
      "export const x = 1;",
    ].join('\n');

    const lines = synthetic.split(/\r?\n/);
    const offenders: { specifier: string; category: string | null }[] = [];
    for (const line of lines) {
      const m = line.match(IMPORT_REGEX);
      if (m) offenders.push({ specifier: m[1], category: classify(m[1]) });
    }

    expect(offenders).toEqual([
      { specifier: 'fs', category: 'node-builtin' },
      { specifier: 'obsidian', category: null },
    ]);
  });
});
