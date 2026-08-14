/**
 * Regression cover for #323: `search content --semantic` with `paths` applied
 * the scope to the RESULTS of an unscoped ranked query, so a scoped search
 * could return zero results while matching notes sat in the requested folder.
 *
 * ## Why the fixture is shaped the way it is
 *
 * Three cuts stood between the vault and the caller, and every one of them ran
 * before `paths` was consulted:
 *
 *   1. `searchContent` asked the service for `limit * 2` results,
 *   2. `NoteEmbeddingService` answered by taking `ORDER BY distance LIMIT
 *      limit * 3` over the WHOLE vault and re-ranking that,
 *   3. `searchContent` then sliced the survivors back down to `limit`.
 *
 * At the default limit of 10 that is a 60-row global window. A test whose
 * scoped notes happen to land inside that window passes against the broken
 * code and proves nothing, so the fixture deliberately buries them below it:
 * `SCOPED_NOTES` rank past position 60 globally, and
 * `it('buries the scoped notes below the window the pre-fix code could see')`
 * asserts that property directly rather than trusting the note count.
 *
 * ## What is real here and what is faked
 *
 * The whole chain under test is the production code — `SearchContentTool`,
 * `EmbeddingService`, `NoteEmbeddingService`, including their real limits,
 * re-ranking and post-filter. Only two leaves are faked:
 *
 *   - the embedding engine, which maps a note to a one-dimensional vector so
 *     distances are readable in the fixture, and
 *   - the SQLite layer, which is a small interpreter for the exact query shape
 *     the service issues: optional `WHERE … LIKE … ESCAPE`, `ORDER BY
 *     distance`, `LIMIT`. LIKE wildcards and the escape character are honoured,
 *     so a scope that reaches the SQL is evaluated the way SQLite would.
 *
 * The fake DB decides nothing about the outcome: it applies the WHERE clause it
 * is given, and the point of the fix is whether it is given one.
 */

import { Plugin, TFile } from 'obsidian';
import { SearchContentTool, ContentSearchParams, ContentSearchResult } from '../../src/agents/searchManager/tools/searchContent';
import { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';
import { isWithinPathScope } from '../../src/utils/pathUtils';

const BASE_CONTEXT = {
  workspaceId: 'default',
  sessionId: 'session-1',
  memory: 'Searching a folder for a concept.',
  goal: 'Get the notes in that folder, not silence.'
};

/** The tool's default when the caller does not pass one. */
const DEFAULT_LIMIT = 10;

/**
 * Rows the pre-fix pipeline could ever consider: the tool asked for
 * `limit * 2`, and the service fetched `3x` that as candidates.
 */
const PRE_FIX_CANDIDATE_WINDOW = DEFAULT_LIMIT * 2 * 3;

const DAY_MS = 1000 * 60 * 60 * 24;

/** Old enough that the recency boost is inert for every fixture row. */
const STALE_UPDATED = Date.now() - 400 * DAY_MS;

interface NoteRow {
  notePath: string;
  /** One-dimensional embedding; distance to the query is just |position|. */
  position: number;
  updated: number;
}

/**
 * 80 notes that outrank everything in `_Base/`, so the scoped notes fall past
 * the 60-row window. Their names share no term with the query, which keeps the
 * service's title boost out of the ranking.
 */
const DECOY_NOTES: NoteRow[] = Array.from({ length: 80 }, (_, index) => ({
  notePath: `Other/decoy-${String(index).padStart(2, '0')}.md`,
  position: 1 + index * 0.001,
  updated: STALE_UPDATED
}));

/** The notes the caller is actually asking for. */
const SCOPED_NOTES: NoteRow[] = [
  { notePath: '_Base/finance-notes.md', position: 5, updated: STALE_UPDATED },
  { notePath: '_Base/deep/ledger.md', position: 6, updated: STALE_UPDATED },
  { notePath: '_Base/summary.md', position: 7, updated: STALE_UPDATED }
];

/**
 * A folder whose name merely STARTS WITH the scoped folder's name. It outranks
 * everything under `_Base/`, so anything that leaks it into a `_Base/` scope
 * shows up at the top rather than at the margin.
 */
const NEIGHBOUR_NOTES: NoteRow[] = [
  { notePath: '_Baseball/roster.md', position: 4, updated: STALE_UPDATED }
];

const VAULT: NoteRow[] = [...DECOY_NOTES, ...NEIGHBOUR_NOTES, ...SCOPED_NOTES];

/** The query. Its terms appear in no fixture path, so no path boost applies. */
const QUERY = 'quarterly revenue';

/** Where the query sits on the same one-dimensional line as the notes. */
const QUERY_POSITION = 0;

/**
 * Translate a SQL `LIKE` pattern into a regex, honouring `%`, `_` and the
 * backslash escape the service asks for via `ESCAPE`.
 *
 * Without this, `_Base%` would be treated as a literal and the test could not
 * tell a correctly escaped pattern from a sloppy one — `_` is a single-character
 * wildcard, and `_Base/` is a real folder name.
 */
function likePatternToRegex(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '\\' && index + 1 < pattern.length) {
      index++;
      source += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (character === '%') {
      source += '.*';
    } else if (character === '_') {
      source += '.';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  // SQLite's LIKE is case-insensitive for ASCII.
  return new RegExp(`^${source}$`, 'i');
}

interface CapturedQuery {
  sql: string;
  likePatterns: string[];
  limit: number;
}

/**
 * A SQLite stand-in that answers the candidate query the way the real one
 * would: apply the WHERE clause if there is one, order by distance, truncate to
 * LIMIT.
 */
function createFakeDb(rows: NoteRow[]) {
  const captured: CapturedQuery[] = [];

  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (!/vec_distance_l2/.test(sql)) {
      return [];
    }

    const buffer = params[0] as Buffer;
    const queryVector = new Float32Array(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    );
    const queryPosition = queryVector[0];

    const limit = params[params.length - 1] as number;
    const likePatterns = params.slice(1, params.length - 1) as string[];
    captured.push({ sql, likePatterns, limit });

    const scoped = likePatterns.length === 0
      ? rows
      : rows.filter(row => likePatterns.some(pattern => likePatternToRegex(pattern).test(row.notePath)));

    return scoped
      .map(row => ({
        notePath: row.notePath,
        updated: row.updated,
        distance: Math.abs(row.position - queryPosition)
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, limit);
  });

  const queryOne = jest.fn(async (sql: string) => {
    if (/COUNT\(\*\)/i.test(sql) && /embedding_metadata/.test(sql)) {
      return { count: rows.length };
    }
    return { count: 0 };
  });

  return { db: { query, queryOne, run: jest.fn() }, captured };
}

function createHarness(rows: NoteRow[] = VAULT) {
  const { db, captured } = createFakeDb(rows);

  const engine = {
    initialize: jest.fn(async () => undefined),
    generateEmbedding: jest.fn(async () => new Float32Array([QUERY_POSITION])),
    getModelInfo: () => ({ id: 'fixture-model', dimensions: 1 })
  };

  const embeddingService = new EmbeddingService({} as never, db as never, engine as never);

  const files = new Map(rows.map(row => {
    const name = row.notePath.split('/').pop() ?? row.notePath;
    return [row.notePath, new TFile(name, row.notePath)];
  }));

  const plugin = {
    app: {
      vault: {
        getMarkdownFiles: () => [...files.values()],
        getAbstractFileByPath: (path: string) => files.get(path) ?? null,
        read: async () => ''
      },
      metadataCache: {
        getFileCache: () => null
      }
    }
  } as unknown as Plugin;

  const tool = new SearchContentTool(plugin);
  tool.setEmbeddingService(embeddingService);

  return { tool, captured };
}

function params(overrides: Partial<ContentSearchParams> = {}): ContentSearchParams {
  return {
    context: BASE_CONTEXT,
    query: QUERY,
    semantic: true,
    ...overrides
  } as ContentSearchParams;
}

/** `prepareResult` nests the payload under `data`; read through both. */
function resultsOf(result: ContentSearchResult): ContentSearchResult['results'] {
  const nested = (result as unknown as { data?: ContentSearchResult }).data;
  return nested?.results ?? result.results ?? [];
}

async function search(overrides: Partial<ContentSearchParams> = {}) {
  const { tool, captured } = createHarness();
  const raw = await tool.execute(params(overrides));
  return { raw, results: resultsOf(raw), paths: resultsOf(raw).map(entry => entry.filePath), captured };
}

/** Global rank (1-based) of a note if the whole vault were ranked by distance. */
function globalRank(notePath: string): number {
  const ordered = [...VAULT]
    .sort((left, right) => Math.abs(left.position - QUERY_POSITION) - Math.abs(right.position - QUERY_POSITION))
    .map(row => row.notePath);
  return ordered.indexOf(notePath) + 1;
}

describe('SearchContentTool — semantic search scoping (#323)', () => {
  /**
   * The guard on every other test in this file. If the scoped notes drift into
   * the window the pre-fix code could see, the regression test below would pass
   * against the broken implementation and stop meaning anything.
   */
  it('buries the scoped notes below the window the pre-fix code could see', () => {
    for (const note of SCOPED_NOTES) {
      expect(globalRank(note.notePath)).toBeGreaterThan(PRE_FIX_CANDIDATE_WINDOW);
    }
  });

  it('returns notes under a scoped folder that rank below the global window', async () => {
    const { raw, paths } = await search({ paths: ['_Base/'] });

    // Before the fix this was `[]`: the 60-row candidate window was spent
    // entirely on `Other/`, and the scope was applied to what survived it.
    expect(paths).toEqual([
      '_Base/finance-notes.md',
      '_Base/deep/ledger.md',
      '_Base/summary.md'
    ]);
    expect(raw.success).toBe(true);
  });

  it('labels the scoped results as semantic matches', async () => {
    const { results } = await search({ paths: ['_Base/'] });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every(entry => entry.matchType === 'semantic')).toBe(true);
  });

  it('pushes the scope into the candidate query rather than filtering after it', async () => {
    const { captured } = await search({ paths: ['_Base/'] });

    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toMatch(/WHERE\s+em\.notePath LIKE \? ESCAPE/);
    expect(captured[0].likePatterns).toEqual(['\\_Base/%']);
  });

  /**
   * `_` is a single-character LIKE wildcard and `_Base/` is a real folder name,
   * so an unescaped pattern silently widens the scope it was asked to narrow.
   */
  it('escapes LIKE wildcards in the scope prefix', async () => {
    const { captured } = await search({ paths: ['_Base/'] });

    expect(captured[0].likePatterns[0].startsWith('\\_')).toBe(true);
  });

  it('reduces a glob to its fixed folder prefix', async () => {
    const { captured, paths } = await search({ paths: ['_Base/**/*.md'] });

    expect(captured[0].likePatterns).toEqual(['\\_Base/%']);
    expect(paths).toContain('_Base/deep/ledger.md');
  });

  it('keeps the neighbouring folder out of a trailing-slash scope', async () => {
    const { paths } = await search({ paths: ['_Base/'] });

    expect(paths).not.toContain('_Baseball/roster.md');
  });

  /**
   * Not every scope reduces to a prefix. Those still go out unscoped and lean
   * on the post-filter, exactly as before — the fix must not turn a pattern
   * with a leading wildcard into a bogus prefix.
   */
  it('leaves the query unscoped for a glob with no fixed prefix', async () => {
    const { captured, paths } = await search({ paths: ['**/decoy-03.md'] });

    expect(captured[0].likePatterns).toEqual([]);
    expect(captured[0].sql).not.toMatch(/WHERE/);
    expect(paths).toEqual(['Other/decoy-03.md']);
  });

  it('leaves the query unscoped for a whole-vault path', async () => {
    const { captured } = await search({ paths: ['/'] });

    expect(captured[0].likePatterns).toEqual([]);
    expect(captured[0].sql).not.toMatch(/WHERE/);
  });

  /**
   * One unbounded entry makes the OR'd union unbounded, so the scope cannot be
   * pushed down at all — pushing only the bounded half would drop results the
   * caller asked for.
   */
  it('leaves the query unscoped when any one path is unbounded', async () => {
    const { captured } = await search({ paths: ['_Base/', '**/decoy-03.md'] });

    expect(captured[0].likePatterns).toEqual([]);
  });

  /**
   * The added parameter is optional, and every existing caller omits it —
   * `noteSearch.searchNotes` among them. An unscoped search must still issue
   * exactly the query it always did.
   */
  it('issues an unscoped query when no paths are given', async () => {
    const { captured, paths } = await search();

    expect(captured[0].sql).not.toMatch(/WHERE/);
    expect(captured[0].likePatterns).toEqual([]);
    expect(captured[0].limit).toBe(DEFAULT_LIMIT * 2 * 3);
    expect(paths).toHaveLength(DEFAULT_LIMIT);
    expect(paths[0]).toBe('Other/decoy-00.md');
  });

  /**
   * With the scope in the query, an empty candidate set means the folder holds
   * no embedded notes. Reporting a vector-database fault there would be a false
   * alarm introduced by the fix itself.
   */
  it('reports an empty scope as an empty result, not a database fault', async () => {
    const { raw, results } = await search({ paths: ['Nowhere/'] });

    expect(raw.success).toBe(true);
    expect(results).toEqual([]);
  });
});

/**
 * A separate defect in the same filter: the literal-path branch compared with a
 * bare `startsWith`, which is not a folder test. Scoping to `_Base` also
 * admitted `_Baseball/`, and the extra results are indistinguishable from
 * legitimate hits.
 *
 * `_Baseball/roster.md` outranks every note under `_Base/` in the fixture, so a
 * leak shows up at the top of the list rather than somewhere in the tail.
 */
describe('SearchContentTool — literal path scopes are anchored to a folder boundary', () => {
  it('excludes a sibling folder whose name merely starts with the scope', async () => {
    const { paths } = await search({ paths: ['_Base'] });

    expect(paths).not.toContain('_Baseball/roster.md');
    expect(paths).toEqual([
      '_Base/finance-notes.md',
      '_Base/deep/ledger.md',
      '_Base/summary.md'
    ]);
  });

  it('accepts the same scope written with a trailing slash', async () => {
    const withSlash = await search({ paths: ['_Base/'] });
    const withoutSlash = await search({ paths: ['_Base'] });

    expect(withoutSlash.paths).toEqual(withSlash.paths);
  });

  it('still admits the neighbouring folder when it is the scope', async () => {
    const { paths } = await search({ paths: ['_Baseball'] });

    expect(paths).toEqual(['_Baseball/roster.md']);
  });
});

describe('isWithinPathScope', () => {
  it.each([
    ['_Base/notes.md', '_Base', true],
    ['_Base/notes.md', '_Base/', true],
    ['_Base', '_Base', true],
    ['_Baseball/roster.md', '_Base', false],
    ['_Basement.md', '_Base', false],
    ['Other/note.md', '_Base', false],
    ['anything/at/all.md', '', true]
  ])('%s within %s -> %s', (path, scope, expected) => {
    expect(isWithinPathScope(path, scope)).toBe(expected);
  });
});
