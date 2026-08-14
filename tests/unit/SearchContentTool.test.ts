/**
 * Tests for SearchContentTool keyword/fuzzy ranking.
 *
 * Regression cover for #309: a fuzzy match on the FILENAME normalized to ~0.95
 * while an exact phrase in the file BODY capped at 0.9, so a file containing
 * none of the query terms outranked a file containing the query verbatim — and
 * nothing in the response let a caller tell the two apart.
 *
 * ## Why this file is shaped the way it is
 *
 * Two follow-up defects (#313, #314) shipped past a green version of this
 * suite and were only caught by searching a real vault. Both had a structural
 * cause, and both are now structurally covered rather than covered by one more
 * hand-picked example:
 *
 * 1. #313 — two files tied on score and the expected winner happened to be
 *    first in the fixture array, so stable-sort POSITION carried the
 *    assertion. Every ranking assertion now goes through `rank()`, which runs
 *    the same fixtures forwards and backwards and fails if the order differs.
 *    A tie can no longer masquerade as a ranking rule.
 *
 * 2. #314 — every fixture filename was spaced, while real vault notes are
 *    routinely kebab- or snake-cased. The title-match rule was asserted only
 *    for the one shape it already handled. `NAME_STYLES` x `QUERY_STYLES` now
 *    covers the cross-product.
 *
 * The fuzzy scorer here is a mock (see tests/mocks/obsidian/core.ts). It
 * reproduces the SHAPE of Obsidian's scoring — subsequence matching, small
 * negative penalties — but not its exact magnitudes. Assertions are therefore
 * ordinal ("A outranks B"), never numeric. For the real engine, see
 * tests/debug/search-ranking-live-smoke.test.ts.
 */

import { Plugin, TFile } from 'obsidian';
import { SearchContentTool, ContentSearchParams, ContentSearchResult } from '../../src/agents/searchManager/tools/searchContent';

interface VaultFile {
  path: string;
  content: string;
}

const BASE_CONTEXT = {
  workspaceId: 'default',
  sessionId: 'session-1',
  memory: 'Searching the vault for a phrase.',
  goal: 'Find the notes that actually contain it.'
};

/**
 * Build a tool over an in-memory vault. Files are plain markdown; frontmatter
 * is not exercised here.
 */
function createTool(files: VaultFile[]): SearchContentTool {
  const tFiles = files.map(file => {
    const name = file.path.split('/').pop() ?? file.path;
    return new TFile(name, file.path);
  });

  const byPath = new Map(files.map(file => [file.path, file.content]));

  const plugin = {
    app: {
      vault: {
        getMarkdownFiles: () => tFiles,
        read: async (file: TFile) => {
          const content = byPath.get(file.path);
          if (content === undefined) {
            throw new Error(`No such file: ${file.path}`);
          }
          return content;
        }
      },
      metadataCache: {
        getFileCache: () => null
      }
    }
  } as unknown as Plugin;

  return new SearchContentTool(plugin);
}

function params(overrides: Partial<ContentSearchParams> = {}): ContentSearchParams {
  return {
    context: BASE_CONTEXT,
    query: 'acordao ministro',
    semantic: false,
    ...overrides
  } as ContentSearchParams;
}

/**
 * `prepareResult` routes the payload through `createResult`, which nests it
 * under `data` — the declared `ContentSearchResult` shape describes what
 * callers see after ToolBatchExecutionService flattens the envelope, not what
 * `execute()` returns directly. Read through both so these tests assert on the
 * ranking rather than on that packaging.
 */
function resultsOf(result: ContentSearchResult): ContentSearchResult['results'] {
  const nested = (result as unknown as { data?: ContentSearchResult }).data;
  return nested?.results ?? result.results ?? [];
}

/**
 * Rank `files` and return the results, having first proved the ranking is a
 * property of the SCORES and not of the enumeration order.
 *
 * The vault hands files to the tool in whatever order it lists them, and the
 * sort is stable, so any two entries with equal scores come back in fixture
 * order. An assertion written against that is vacuous — it passes for almost
 * any implementation. #313 was exactly this: a title match and a body match
 * both scored 0.9, and the test passed only because the expected winner was
 * listed first.
 *
 * Running the same fixtures reversed makes ties impossible to hide.
 */
async function rank(
  files: VaultFile[],
  overrides: Partial<ContentSearchParams> = {}
): Promise<ContentSearchResult['results']> {
  const forward = resultsOf(await createTool(files).execute(params(overrides)));
  const backward = resultsOf(await createTool([...files].reverse()).execute(params(overrides)));

  const forwardPaths = forward.map(entry => entry.filePath);
  const backwardPaths = backward.map(entry => entry.filePath);

  if (JSON.stringify(forwardPaths) !== JSON.stringify(backwardPaths)) {
    throw new Error(
      'Ranking changed when the vault listed the same files in the opposite order, '
      + 'so it is decided by enumeration order rather than by score — any assertion '
      + 'on it proves nothing.\n'
      + `  listed forwards: ${JSON.stringify(forwardPaths, null, 2)}\n`
      + `  listed backwards: ${JSON.stringify(backwardPaths, null, 2)}\n`
      + 'Two or more results are tied. Separate them on score, or assert something '
      + 'other than their relative order.'
    );
  }

  return forward;
}

/** Ways a vault names a note. Applied to the phrase "quarterly revenue report". */
const NAME_STYLES: Record<string, (phrase: string) => string> = {
  spaced: phrase => phrase,
  kebab: phrase => phrase.replace(/ /g, '-'),
  snake: phrase => phrase.replace(/ /g, '_'),
  mixed: phrase => phrase.replace(/ /g, '-').replace('-report', '_report'),
  titleCase: phrase => phrase.replace(/\b\w/g, char => char.toUpperCase()),
  kebabTitle: phrase => phrase.replace(/\b\w/g, char => char.toUpperCase()).replace(/ /g, '-')
};

/** Ways a caller types the same phrase. */
const QUERY_STYLES: Record<string, (phrase: string) => string> = {
  spaced: phrase => phrase,
  kebab: phrase => phrase.replace(/ /g, '-'),
  snake: phrase => phrase.replace(/ /g, '_'),
  upper: phrase => phrase.toUpperCase()
};

describe('SearchContentTool — keyword ranking', () => {
  /**
   * The #309 repro, reduced. The Zettel note shares no query TERM with
   * "acordao ministro" but does contain its characters as a scattered
   * subsequence, which is exactly what the old normalization scored at ~0.92.
   */
  const REPRO_VAULT: VaultFile[] = [
    {
      // Contains neither "acordao" nor "ministro" — in the name or the body —
      // but its name carries the query's characters as a scattered subsequence.
      path: 'Zettel/A-cronologia-da-reforma-administrativa-e-o-ministerio-do-registro.md',
      content: 'Notas sobre teoria geral. Sem relacao com os termos buscados.'
    },
    {
      // Contains the query verbatim, which could never score above 0.9.
      path: 'Julgados/STF-ADI-6649.md',
      content: 'Trecho do voto: acordao ministro relator, com fundamentacao.'
    }
  ];

  it('ranks an exact content match above a filename-only fuzzy match', async () => {
    const results = await rank(REPRO_VAULT);

    expect(results[0].filePath).toBe('Julgados/STF-ADI-6649.md');
  });

  it('places every content match above every path-only match', async () => {
    const results = await rank(REPRO_VAULT);
    const types = results.map(entry => entry.matchType);

    const lastContent = types.lastIndexOf('content');
    const firstPath = types.indexOf('path');

    expect(types).toContain('content');
    expect(types).toContain('path');
    expect(lastContent).toBeLessThan(firstPath);
  });

  it('reports how each result matched', async () => {
    const results = await rank(REPRO_VAULT);

    expect(results.length).toBeGreaterThan(0);
    for (const entry of results) {
      expect(['content', 'path', 'semantic']).toContain(entry.matchType);
    }
  });

  /**
   * The counterpart risk to the #309 fix: tiering content strictly above
   * filename would break title lookup, which is first-class in Obsidian. A note
   * NAMED for the query must beat a note that merely mentions it.
   *
   * `rank()` is what makes this real — the two files would otherwise tie.
   */
  it('ranks a note named for the query above one that merely mentions it', async () => {
    const results = await rank([
      {
        path: 'Archive/Meeting log.md',
        content: 'Earlier we referenced the 2026-08-06 Standup in passing.'
      },
      {
        path: 'Daily/2026-08-06 Standup.md',
        content: 'Unrelated body text about deployment.'
      }
    ], { query: '2026-08-06 Standup' });

    expect(results[0].filePath).toBe('Daily/2026-08-06 Standup.md');
    expect(results[0].matchType).toBe('path');
  });

  /**
   * #314: every fixture above is spaced, but real vault notes are routinely
   * kebab- or snake-cased, and a caller may type the phrase either way. The
   * title rule has to hold across the cross-product, not just the one shape
   * that happened to be tested. Before the fold, `citation-gap-audit.md` sat at
   * rank 12 for the query `citation gap audit`.
   */
  describe('title matching across naming and query styles', () => {
    const PHRASE = 'quarterly revenue report';

    for (const [nameStyle, applyName] of Object.entries(NAME_STYLES)) {
      for (const [queryStyle, applyQuery] of Object.entries(QUERY_STYLES)) {
        it(`finds a ${nameStyle} filename from a ${queryStyle} query`, async () => {
          const namedPath = `Notes/${applyName(PHRASE)}.md`;

          const results = await rank([
            {
              path: 'Notes/references.md',
              content: `See the ${PHRASE} for the full table of findings.`
            },
            { path: namedPath, content: 'Body text that does not repeat the phrase.' }
          ], { query: applyQuery(PHRASE) });

          expect(results[0].filePath).toBe(namedPath);
        });
      }
    }
  });

  /**
   * The mirror of the filename fold, on the query side. A caller who types the
   * phrase the way the vault spells its FILENAMES should still match a body
   * that spells it as words — otherwise `citation-gap-audit` is a single
   * unsplittable token and finds no body text at all.
   */
  it('matches spaced body text from a separator-joined query', async () => {
    const results = await rank([
      {
        path: 'Notes/unrelated-name.md',
        content: 'See the citation gap audit table for the full findings.'
      }
    ], { query: 'citation-gap-audit' });

    expect(results.map(entry => entry.filePath)).toEqual(['Notes/unrelated-name.md']);
    expect(results[0].matchType).toBe('content');
  });

  /**
   * The blend used to be assigned unconditionally, so matching a second way
   * could DEMOTE a file below an otherwise identical one that matched once.
   */
  it('does not demote a file for also matching on its name', async () => {
    const results = await rank([
      {
        // Body holds the exact phrase (the strongest content signal), and the
        // NAME is a weak fuzzy-only hit. Blending the two unguarded drags this
        // below the weaker file beneath it.
        path: 'Notes/Quiet quarters - early review of the venue.md',
        content: 'The quarterly revenue figures are attached.'
      },
      {
        // Both words present but not as a phrase — a strictly weaker match.
        path: 'Notes/zzz.md',
        content: 'Revenue was discussed, and the quarterly cadence was set.'
      }
    ], { query: 'quarterly revenue' });

    expect(results[0].filePath).toBe('Notes/Quiet quarters - early review of the venue.md');
  });

  it('labels every result as a path match when bodies are never read', async () => {
    // Queried by name: with includeContent=false the tool never reads a body,
    // so it cannot honestly claim a content match for anything.
    const results = await rank(REPRO_VAULT, { query: 'STF-ADI-6649', includeContent: false });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every(entry => entry.matchType === 'path')).toBe(true);
  });

  it('returns an empty list when nothing matches', async () => {
    const results = await rank(REPRO_VAULT, { query: 'vringlethorp quazzendil mubrifonte' });

    expect(results).toEqual([]);
  });

  /**
   * The `paths` filter compared with a bare `startsWith`, which is a string
   * test rather than a folder test: scoping to `_Base` also pulled in every
   * sibling folder whose name begins the same way, and the extra results look
   * exactly like legitimate ones.
   *
   * The two fixtures score differently on purpose so `rank()` is asserting the
   * scope rather than tripping its own tie guard.
   */
  describe('literal path scopes are anchored to a folder boundary', () => {
    const NEIGHBOURS: VaultFile[] = [
      {
        path: '_Base/quarterly report.md',
        content: 'The quarterly revenue figures are attached in full.'
      },
      {
        path: '_Baseball/roster.md',
        content: 'Revenue from ticket sales was up.'
      }
    ];

    it('excludes a sibling folder whose name merely starts with the scope', async () => {
      const results = await rank(NEIGHBOURS, { query: 'quarterly revenue', paths: ['_Base'] });

      expect(results.map(entry => entry.filePath)).toEqual(['_Base/quarterly report.md']);
    });

    it('accepts the same scope written with a trailing slash', async () => {
      const withSlash = await rank(NEIGHBOURS, { query: 'quarterly revenue', paths: ['_Base/'] });
      const withoutSlash = await rank(NEIGHBOURS, { query: 'quarterly revenue', paths: ['_Base'] });

      expect(withoutSlash.map(entry => entry.filePath)).toEqual(withSlash.map(entry => entry.filePath));
    });

    it('still searches the whole vault for the root scope', async () => {
      const results = await rank(NEIGHBOURS, { query: 'quarterly revenue', paths: ['/'] });

      expect(results.map(entry => entry.filePath).sort()).toEqual([
        '_Base/quarterly report.md',
        '_Baseball/roster.md'
      ]);
    });
  });

  it('documents matchType in the result schema', () => {
    const tool = createTool([]);

    const schema = tool.getResultSchema() as {
      properties: {
        results: {
          items: {
            properties: Record<string, { enum?: string[] }>;
            required: string[];
          };
        };
      };
    };

    const items = schema.properties.results.items;
    expect(items.properties.matchType).toBeDefined();
    expect(items.properties.matchType.enum).toEqual(['content', 'path', 'semantic']);
    expect(items.required).toContain('matchType');
  });
});

describe('rank() harness', () => {
  /**
   * The harness is the thing standing between this suite and another #313, so
   * prove it actually reports a tie instead of silently passing one through.
   */
  it('fails when two results tie and the order is decided by enumeration', async () => {
    const tied: VaultFile[] = [
      { path: 'Notes/first.md', content: 'the shared phrase appears here' },
      { path: 'Notes/second.md', content: 'the shared phrase appears here' }
    ];

    await expect(rank(tied, { query: 'shared phrase' }))
      .rejects.toThrow(/decided by enumeration order/);
  });
});
