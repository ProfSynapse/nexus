/**
 * `search content --semantic` lists each file at most once.
 *
 * Reported from a real vault as "the same file multiple times":
 * ['Job Listing.md', 'Application_Tracking.md', 'Application_Tracking.md', …].
 * Read live, those were different files that share a basename, one
 * Application_Tracking.md per job-application folder; `embedding_metadata`
 * holds one row per notePath (UNIQUE). So the full paths must survive as
 * distinct results, and a path the service does return twice must collapse to
 * its best-ranked hit while the answer still fills up to `limit` files.
 */

import { Plugin, TFile } from 'obsidian';
import { SearchContentTool, ContentSearchParams, ContentSearchResult } from '../../src/agents/searchManager/tools/searchContent';

function createTool(ranked: Array<{ notePath: string; distance: number }>) {
  const paths = [...new Set(ranked.map(r => r.notePath))];
  const files = new Map(paths.map(path => [path, new TFile(path.split('/').pop() ?? path, path)]));
  const semanticSearch = jest.fn(async () => ranked.map(r => ({ ...r })));
  const embeddingService = {
    isServiceEnabled: () => true,
    getStats: async () => ({ noteCount: paths.length, traceCount: 0, conversationChunkCount: 0, conversationCount: 0 }),
    semanticSearch
  };
  const plugin = {
    embeddingManager: {
      isEmbeddingEnabled: () => true,
      getService: () => embeddingService
    },
    app: {
      vault: {
        getMarkdownFiles: () => [...files.values()],
        getAbstractFileByPath: (path: string) => files.get(path) ?? null,
        read: async () => ''
      },
      metadataCache: { getFileCache: () => null }
    }
  } as unknown as Plugin;
  return { tool: new SearchContentTool(plugin), semanticSearch };
}

function resultPaths(result: ContentSearchResult): string[] {
  const nested = (result as unknown as { data?: ContentSearchResult }).data;
  return (nested?.results ?? result.results ?? []).map(entry => entry.filePath);
}

const params = (limit: number): ContentSearchParams => ({
  context: { workspaceId: 'default', sessionId: 's', memory: 'm', goal: 'g' },
  query: 'job application tracking',
  semantic: true,
  limit
} as ContentSearchParams);

describe('SearchContentTool semantic results are distinct files', () => {
  it('collapses a path returned twice and fills the limit with the next files', async () => {
    const { tool } = createTool([
      { notePath: 'Jobs/Job Listing.md', distance: 0.1 },
      { notePath: 'Jobs/Acme/Application_Tracking.md', distance: 0.2 },
      { notePath: 'Jobs/Acme/Application_Tracking.md', distance: 0.3 },
      { notePath: 'Jobs/Acme/Application_Tracking.md', distance: 0.4 },
      { notePath: 'Jobs/Beta/Application_Tracking.md', distance: 0.5 },
      { notePath: 'Jobs/README.md', distance: 0.6 }
    ]);

    const result = await tool.execute(params(4));

    expect(result.success).toBe(true);
    expect(resultPaths(result)).toEqual([
      'Jobs/Job Listing.md',
      'Jobs/Acme/Application_Tracking.md',
      'Jobs/Beta/Application_Tracking.md',
      'Jobs/README.md'
    ]);
  });

  it('keeps different files that share a basename as separate results', async () => {
    const { tool } = createTool([
      { notePath: 'Jobs/Acme/Application_Tracking.md', distance: 0.1 },
      { notePath: 'Jobs/Beta/Application_Tracking.md', distance: 0.2 },
      { notePath: 'Jobs/Gamma/Application_Tracking.md', distance: 0.3 }
    ]);

    const result = await tool.execute(params(10));

    expect(resultPaths(result)).toEqual([
      'Jobs/Acme/Application_Tracking.md',
      'Jobs/Beta/Application_Tracking.md',
      'Jobs/Gamma/Application_Tracking.md'
    ]);
  });
});
