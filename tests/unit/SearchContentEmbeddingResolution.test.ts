/**
 * Regression cover: `search content --semantic` held on to the first
 * EmbeddingService it ever saw.
 *
 * `SearchContentTool.getEmbeddingService()` cached the service on first use,
 * and `SearchManagerAgent` pre-seeded that cache from a registry lookup for
 * `'embeddingService'` (a name nothing registers). Once the embedding manager
 * can be turned off and on during a session, each start builds a new service,
 * so a cached instance is either a stopped service or the wrong one.
 *
 * What is real: `SearchManagerAgent`, `SearchContentTool` and the plugin
 * lookup. What is faked: the plugin and two leaf services whose
 * `semanticSearch` is a spy. The fake manager only reports what it holds; the
 * test measures whether the tool asks it on every call.
 *
 * If the tool cached again, the disabled step would still hit the first
 * service and the re-enabled step would never reach the second.
 */

import { TFile } from 'obsidian';
import { SearchManagerAgent } from '../../src/agents/searchManager/searchManager';
import { PLUGIN_IDS } from '../../src/constants/branding';

const CONTEXT = {
  workspaceId: 'default',
  sessionId: 'session-1',
  memory: 'Looking for a concept.',
  goal: 'Find related notes.'
};

const NOTE_PATH = 'Ideas/auth.md';

function fakeService(label: string) {
  return {
    label,
    isServiceEnabled: jest.fn(() => true),
    getStats: jest.fn(async () => ({ noteCount: 1, chunkCount: 1 })),
    semanticSearch: jest.fn(async () => [{ notePath: NOTE_PATH, distance: 0.1, score: 0.1 }])
  };
}

type FakeService = ReturnType<typeof fakeService>;

function createHarness(initial: FakeService) {
  const manager = {
    enabled: true,
    service: initial as FakeService | null,
    isEmbeddingEnabled() { return this.enabled; },
    getService() { return this.service; }
  };

  const file = new TFile('auth.md', NOTE_PATH);
  const getServiceIfReady = jest.fn(() => null);
  const plugin: Record<string, unknown> = {
    embeddingManager: manager,
    getServiceContainer: () => ({ getServiceIfReady }),
    settings: { settings: { memory: {} } }
  };
  const app = {
    plugins: {
      getPlugin: (id: string) => (id === PLUGIN_IDS.current ? plugin : null)
    },
    vault: {
      getMarkdownFiles: () => [file],
      getAbstractFileByPath: (path: string) => (path === NOTE_PATH ? file : null),
      read: async () => ''
    },
    metadataCache: { getFileCache: () => null }
  };
  plugin.app = app;

  const agent = new SearchManagerAgent(app as never, false, {} as never, {} as never);
  const search = () => agent.executeTool('content', {
    query: 'authentication flow',
    semantic: true,
    context: CONTEXT
  }) as Promise<{ success: boolean; error?: string }>;

  return { manager, search, getServiceIfReady };
}

describe('search content resolves the embedding service on every call', () => {
  it('uses the manager-owned service without a registry entry', async () => {
    const first = fakeService('first');
    const { search, getServiceIfReady } = createHarness(first);

    const result = await search();

    expect(result.success).toBe(true);
    expect(first.semanticSearch).toHaveBeenCalledTimes(1);
    expect(getServiceIfReady).not.toHaveBeenCalledWith('embeddingService');
  });

  it('stops using the old instance when embeddings are turned off', async () => {
    const first = fakeService('first');
    const { manager, search } = createHarness(first);

    await search();
    manager.enabled = false;
    const whileOff = await search();

    expect(whileOff.success).toBe(false);
    expect(first.semanticSearch).toHaveBeenCalledTimes(1);
  });

  it('uses the new instance after embeddings are turned back on', async () => {
    const first = fakeService('first');
    const { manager, search } = createHarness(first);

    await search();
    manager.enabled = false;
    await search();

    const second = fakeService('second');
    manager.service = second;
    manager.enabled = true;
    const result = await search();

    expect(result.success).toBe(true);
    expect(first.semanticSearch).toHaveBeenCalledTimes(1);
    expect(second.semanticSearch).toHaveBeenCalledTimes(1);
  });
});
