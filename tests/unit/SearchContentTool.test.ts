/**
 * Tests for SearchContentTool keyword/fuzzy ranking.
 *
 * Regression cover for #309: a fuzzy match on the FILENAME normalized to ~0.95
 * while an exact phrase in the file BODY capped at 0.9, so a file containing
 * none of the query terms outranked a file containing the query verbatim — and
 * nothing in the response let a caller tell the two apart.
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

describe('SearchContentTool — keyword ranking', () => {
  /**
   * The #309 repro, reduced. "Ha teorias que reconhecem a privacidade" shares
   * no query TERM with "acordao ministro" but does contain its characters as a
   * scattered subsequence, which is exactly what the old normalization scored
   * at ~0.95.
   */
  const REPRO_VAULT: VaultFile[] = [
    {
      // Contains neither "acordao" nor "ministro" — in the name or the body —
      // but its name carries the query's characters as a scattered
      // subsequence, which the old normalization scored at ~0.92.
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
    const tool = createTool(REPRO_VAULT);

    const result = await tool.execute(params());

    expect(result.success).toBe(true);
    expect(resultsOf(result)[0].filePath).toBe('Julgados/STF-ADI-6649.md');
  });

  it('does not surface a file whose body and name share no query term above one that does', async () => {
    const tool = createTool(REPRO_VAULT);

    const result = await tool.execute(params());

    const results = resultsOf(result);
    const contentMatches = results.filter(entry => entry.matchType === 'content');
    const pathMatches = results.filter(entry => entry.matchType === 'path');

    expect(contentMatches.map(entry => entry.filePath)).toContain('Julgados/STF-ADI-6649.md');

    // Every content match outranks every path-only match in the returned order.
    const lastContentIndex = results.map(e => e.matchType).lastIndexOf('content');
    const firstPathIndex = results.map(e => e.matchType).indexOf('path');
    if (firstPathIndex !== -1 && lastContentIndex !== -1) {
      expect(lastContentIndex).toBeLessThan(firstPathIndex);
    }
    expect(pathMatches.every(entry => entry.filePath !== 'Julgados/STF-ADI-6649.md')).toBe(true);
  });

  it('reports how each result matched', async () => {
    const tool = createTool(REPRO_VAULT);

    const result = await tool.execute(params());

    const results = resultsOf(result);
    expect(results.length).toBeGreaterThan(0);
    for (const entry of results) {
      expect(['content', 'path', 'semantic']).toContain(entry.matchType);
    }
  });

  /**
   * The counterpart risk to the fix: tiering content strictly above filename
   * would break title lookup, which is a first-class Obsidian use case. A note
   * NAMED for the query must still win over a note that merely mentions it.
   */
  it('still ranks a title match first when the query names a note', async () => {
    const tool = createTool([
      // Enumerated FIRST on purpose. Both files match the query verbatim — one
      // in its body, one in its name — so if they scored the same rung this
      // would win on position alone and the assertion below would prove
      // nothing. It has to lose on score.
      {
        path: 'Archive/Meeting log.md',
        content: 'Earlier we referenced the 2026-08-06 Standup in passing.'
      },
      {
        path: 'Daily/2026-08-06 Standup.md',
        content: 'Unrelated body text about deployment.'
      }
    ]);

    const result = await tool.execute(params({ query: '2026-08-06 Standup' }));

    expect(result.success).toBe(true);
    expect(resultsOf(result)[0].filePath).toBe('Daily/2026-08-06 Standup.md');
    expect(resultsOf(result)[0].matchType).toBe('path');
  });

  /**
   * The blend used to be assigned unconditionally, so matching a second way
   * could DEMOTE a file below an otherwise identical one that matched once.
   */
  it('does not demote a file for also matching on its name', async () => {
    const tool = createTool([
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
    ]);

    const result = await tool.execute(params({ query: 'quarterly revenue' }));

    expect(resultsOf(result)[0].filePath).toBe('Notes/Quiet quarters - early review of the venue.md');
  });

  it('labels every result as a path match when bodies are never read', async () => {
    const tool = createTool(REPRO_VAULT);

    // Queried by name: with includeContent=false the tool never reads a body,
    // so it cannot honestly claim a content match for anything.
    const result = await tool.execute(params({ query: 'STF-ADI-6649', includeContent: false }));

    const results = resultsOf(result);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(entry => entry.matchType === 'path')).toBe(true);
  });

  it('returns an empty list when nothing matches', async () => {
    const tool = createTool(REPRO_VAULT);

    const result = await tool.execute(params({ query: 'vringlethorp quazzendil mubrifonte' }));

    expect(result.success).toBe(true);
    expect(resultsOf(result)).toEqual([]);
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
