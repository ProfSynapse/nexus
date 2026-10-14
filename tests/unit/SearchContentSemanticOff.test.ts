/**
 * With semantic search turned off, `search content` stops offering it and
 * answers `--semantic` with keyword results and a note.
 *
 * Before this, turning semantic search off left the tool description pitching
 * "AI-powered conceptual search", and `semantic=true` failed with "Semantic
 * search is not available yet ... may still be initializing", which sends an
 * agent into a retry loop for something that will never start.
 *
 * What is real: SearchManagerAgent, SearchContentTool, its keyword search,
 * the semantic state derived from the plugin settings, and ToolCliNormalizer
 * (both discovery and command parsing). What is faked: the plugin object, a
 * two-note vault and an embedding manager. The flag must stay parseable:
 * ToolCliNormalizer rejects any flag missing from the schema with "Unknown
 * flag", so dropping the property would turn a harmless call into an error.
 */

import { TFile } from 'obsidian';
import { SearchManagerAgent } from '../../src/agents/searchManager/searchManager';
import { SEMANTIC_FALLBACK_NOTES } from '../../src/agents/searchManager/tools/searchContent';
import { ToolCliNormalizer } from '../../src/agents/toolManager/services/ToolCliNormalizer';
import { PLUGIN_IDS } from '../../src/constants/branding';
import type { IAgent } from '../../src/agents/interfaces/IAgent';

const CONTEXT = {
  workspaceId: 'default',
  sessionId: 'session-1',
  memory: 'Looking for auth notes.',
  goal: 'Find them.'
};

const SEMANTIC_PITCH = 'Set semantic=true for AI-powered';

interface SearchData {
  results: Array<{ filePath: string; matchType: string }>;
  note?: string;
}

function createHarness(options: { enableEmbeddings?: boolean; managerReady?: boolean } = {}) {
  const files = [
    new TFile('auth.md', 'Ideas/auth.md'),
    new TFile('cooking.md', 'Life/cooking.md')
  ];
  const bodies: Record<string, string> = {
    'Ideas/auth.md': 'Notes on the authentication flow and tokens.',
    'Life/cooking.md': 'Pasta, mostly.'
  };
  const service = {
    isServiceEnabled: jest.fn(() => true),
    getStats: jest.fn(async () => ({ noteCount: 2 })),
    semanticSearch: jest.fn(async () => [{ notePath: 'Ideas/auth.md', distance: 0.1, score: 0.1 }])
  };
  const manager = {
    isEmbeddingEnabled: () => options.managerReady ?? false,
    getService: () => (options.managerReady ? service : null)
  };

  const settings: Record<string, unknown> = { memory: {} };
  if (options.enableEmbeddings !== undefined) settings.enableEmbeddings = options.enableEmbeddings;
  const plugin: Record<string, unknown> = {
    embeddingManager: manager,
    getServiceContainer: () => ({ getServiceIfReady: () => null }),
    settings: { settings }
  };
  const app = {
    plugins: { getPlugin: (id: string) => (id === PLUGIN_IDS.current ? plugin : null) },
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find(file => file.path === path) ?? null,
      read: async (file: TFile) => bodies[file.path] ?? '',
      cachedRead: async (file: TFile) => bodies[file.path] ?? ''
    },
    metadataCache: { getFileCache: () => null }
  };
  plugin.app = app;

  const agent = new SearchManagerAgent(app as never, false, {} as never, {} as never);
  const normalizer = new ToolCliNormalizer(new Map<string, IAgent>([['searchManager', agent as unknown as IAgent]]));
  const tool = () => {
    const found = agent.getTool('content');
    if (!found) throw new Error('content tool missing');
    return found;
  };
  const run = async (semantic: boolean) => agent.executeTool('content', {
    query: 'authentication flow',
    semantic,
    context: CONTEXT
  }) as Promise<{ success: boolean; error?: string; data?: SearchData }>;

  return { agent, normalizer, tool, run, service, settings };
}

describe('search content with semantic search turned off', () => {
  it('drops the semantic pitch from discovery, compact and full', () => {
    const h = createHarness({ enableEmbeddings: false });

    const compact = h.normalizer.buildCliSchema('searchManager', h.tool(), { compact: true });
    const full = h.normalizer.buildCliSchema('searchManager', h.tool());

    expect(compact.description).not.toContain(SEMANTIC_PITCH);
    expect(full.description).not.toContain(SEMANTIC_PITCH);
    expect(full.description).toMatch(/turned off in Nexus settings/);
    const semanticArg = full.arguments?.find(arg => arg.name === 'semantic');
    expect(semanticArg?.description).toMatch(/Unavailable: semantic search is turned off in Nexus settings/);
  });

  it('still parses --semantic, because unknown flags are rejected', () => {
    const h = createHarness({ enableEmbeddings: false });

    const calls = h.normalizer.normalizeExecutionCalls({
      ...CONTEXT,
      tool: 'search content "authentication flow" --semantic'
    } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toMatchObject({ query: 'authentication flow', semantic: true });
    expect(() => h.normalizer.normalizeExecutionCalls({
      ...CONTEXT,
      tool: 'search content "x" --made-up-flag'
    } as never)).toThrow(/Unknown flag/);
  });

  it('answers semantic=true with keyword results and a note, not an error', async () => {
    const h = createHarness({ enableEmbeddings: false, managerReady: false });

    const result = await h.run(true);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.data?.note).toBe(SEMANTIC_FALLBACK_NOTES.off);
    expect(result.data?.results.map(r => r.filePath)).toContain('Ideas/auth.md');
    expect(result.data?.results.every(r => r.matchType !== 'semantic')).toBe(true);
    expect(h.service.semanticSearch).not.toHaveBeenCalled();
  });

  it('adds no note to an ordinary keyword search', async () => {
    const h = createHarness({ enableEmbeddings: false });

    const result = await h.run(false);

    expect(result.success).toBe(true);
    expect(result.data?.note).toBeUndefined();
  });

  it('follows the setting live: turning it back on restores the pitch without a new agent', () => {
    const h = createHarness({ enableEmbeddings: false });
    expect(h.tool().description).not.toContain(SEMANTIC_PITCH);

    h.settings.enableEmbeddings = true;

    expect(h.tool().description).toContain(SEMANTIC_PITCH);
  });
});

describe('search content with semantic search turned on', () => {
  it('keeps the committed description and says "still initializing" before the engine is up', async () => {
    const h = createHarness({ enableEmbeddings: true, managerReady: false });

    expect(h.tool().description).toContain(SEMANTIC_PITCH);
    const result = await h.run(true);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/still initializing/);
  });

  it('runs semantic search once the engine is up, with no note', async () => {
    const h = createHarness({ enableEmbeddings: true, managerReady: true });

    const result = await h.run(true);

    expect(result.success).toBe(true);
    expect(result.data?.note).toBeUndefined();
    expect(h.service.semanticSearch).toHaveBeenCalledTimes(1);
  });

  it('treats an absent setting as on (the default)', () => {
    const h = createHarness({});
    expect(h.tool().description).toContain(SEMANTIC_PITCH);
  });
});
