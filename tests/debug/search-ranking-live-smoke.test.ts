/**
 * Live search-ranking smoke test.
 *
 * Drives a RUNNING Nexus vault through the `nexus` CLI, so the ranking runs
 * against Obsidian's real `prepareFuzzySearch` instead of the mock in
 * tests/mocks/obsidian/core.ts. Skipped unless explicitly enabled.
 *
 *   RUN_SEARCH_SMOKE=1 npx jest tests/debug/search-ranking-live-smoke.test.ts --runInBand --no-coverage --verbose
 *
 * Pick a vault (otherwise the CLI's default is used):
 *   RUN_SEARCH_SMOKE=1 SEARCH_SMOKE_VAULT=code npx jest tests/debug/search-ranking-live-smoke.test.ts --runInBand
 *
 * ## Why this exists
 *
 * Three ranking defects shipped past a green unit suite (#309, #313, #314) and
 * every one was caught by searching a real vault. The unit suite can only
 * prove the tiers are ordered consistently with a MOCKED fuzzy scorer; it
 * cannot know whether real filenames look like its fixtures or whether real
 * Obsidian scores the way the mock does. This closes that gap.
 *
 * It writes scratch notes under a dedicated folder and archives them
 * afterwards. It never touches anything else in the vault.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

jest.setTimeout(180_000);

const RUN_LIVE = process.env.RUN_SEARCH_SMOKE === '1';
const VAULT = process.env.SEARCH_SMOKE_VAULT;
const SCRATCH = '_search-ranking-smoke';

const MEMORY = 'Running the automated search-ranking smoke test against a live vault.';
const GOAL = 'Verify content/title/fuzzy ranking against the real Obsidian fuzzy matcher.';

interface SearchResult {
  filePath: string;
  matchType: 'content' | 'path' | 'semantic';
  content?: string;
}

/**
 * Run one `nexus use` command. Context flags go before `--`, the agent command
 * after it — see the CLI manual (`nexus --help`).
 */
async function nexus(command: string[]): Promise<Record<string, unknown>> {
  const args = [
    ...(VAULT ? ['--vault', VAULT] : []),
    'use',
    '--memory', MEMORY,
    '--goal', GOAL,
    '--',
    ...command
  ];

  const { stdout } = await execFileAsync('nexus', args, { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function writeNote(path: string, content: string): Promise<void> {
  const result = await nexus(['content', 'write', '--path', path, '--content', content]);
  if (result.success !== true) {
    throw new Error(`Failed to write ${path}: ${JSON.stringify(result)}`);
  }
}

async function search(query: string): Promise<SearchResult[]> {
  const result = await nexus([
    'search', 'content', query,
    '--paths', SCRATCH,
    '--limit', '10'
  ]);

  if (result.success !== true) {
    throw new Error(`Search failed for "${query}": ${JSON.stringify(result)}`);
  }
  return (result.results ?? []) as SearchResult[];
}

const describeLive = RUN_LIVE ? describe : describe.skip;

describeLive('search ranking against a live vault', () => {
  beforeAll(async () => {
    // A note whose NAME carries the query's characters as a scattered
    // subsequence but whose name and body contain none of its terms.
    await writeNote(
      `${SCRATCH}/A-cronologia-da-reforma-administrativa-e-o-ministerio-do-registro.md`,
      'Notas sobre teoria geral. Sem relacao com os termos buscados.'
    );
    // A note whose BODY carries the query verbatim.
    await writeNote(
      `${SCRATCH}/STF-ADI-6649.md`,
      'Trecho do voto: acordao ministro relator, com fundamentacao.'
    );
    // A note NAMED for a phrase, kebab-cased the way vault notes usually are.
    await writeNote(
      `${SCRATCH}/citation-gap-audit.md`,
      'Body text that does not repeat the phrase.'
    );
    // A note that merely MENTIONS that phrase, spaced.
    await writeNote(
      `${SCRATCH}/references.md`,
      'See the citation gap audit for the full table of findings.'
    );
  });

  afterAll(async () => {
    // Archive is reversible; the AI surface has no delete by design.
    await nexus(['storage', 'archive', '--path', SCRATCH]).catch(() => undefined);
  });

  /** #309 — a filename-only fuzzy hit must not outrank a verbatim body match. */
  it('ranks a verbatim body match above a filename-only fuzzy hit', async () => {
    const results = await search('acordao ministro');
    const paths = results.map(entry => entry.filePath);

    const body = paths.findIndex(path => path.endsWith('STF-ADI-6649.md'));
    const fuzzy = paths.findIndex(path => path.includes('A-cronologia-da-reforma'));

    expect(body).toBeGreaterThanOrEqual(0);
    if (fuzzy !== -1) {
      expect(body).toBeLessThan(fuzzy);
    }
  });

  /** The same query must label the two hits differently. */
  it('labels a filename-only hit as a path match', async () => {
    const results = await search('acordao ministro');

    const body = results.find(entry => entry.filePath.endsWith('STF-ADI-6649.md'));
    const fuzzy = results.find(entry => entry.filePath.includes('A-cronologia-da-reforma'));

    expect(body?.matchType).toBe('content');
    if (fuzzy) {
      expect(fuzzy.matchType).toBe('path');
    }
  });

  /**
   * #313 + #314 — the note NAMED for the query wins, and the name being
   * kebab-cased while the query is spaced does not hide it. This is the exact
   * pair that sat at rank 12 in a real vault.
   */
  it('ranks a kebab-cased note named for the query above one that mentions it', async () => {
    const results = await search('citation gap audit');
    const paths = results.map(entry => entry.filePath);

    const named = paths.findIndex(path => path.endsWith('citation-gap-audit.md'));
    const mentions = paths.findIndex(path => path.endsWith('references.md'));

    expect(named).toBeGreaterThanOrEqual(0);
    if (mentions !== -1) {
      expect(named).toBeLessThan(mentions);
    }
  });

  it('returns an empty list when nothing matches', async () => {
    const results = await search('vringlethorp quazzendil mubrifonte');

    expect(results).toEqual([]);
  });
});
