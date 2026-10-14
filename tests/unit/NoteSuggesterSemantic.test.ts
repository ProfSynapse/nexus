/**
 * Regression cover: `[[` note suggestions in the chat composer were always
 * fuzzy, never semantic.
 *
 * `initializeSuggesters` captured `getServiceIfReady('embeddingService')` once
 * when the composer was built. Nothing registers that name, so the captured
 * value was null for the life of the chat view and `searchNotes` always took
 * the basename fuzzy branch. Capturing any instance is also wrong now that the
 * embedding manager can be turned off and on during a session.
 *
 * What is real: `initializeSuggesters`, `TextAreaNoteSuggester`, `searchNotes`
 * and the plugin lookup. What is faked: the plugin, the vault file list and a
 * leaf service whose `semanticSearch` is a spy. The query is chosen so that
 * fuzzy matching finds nothing, which makes "semantic was used" observable in
 * the returned files, not only in the spy.
 */

import { App, Component, TFile } from 'obsidian';
import { searchNotes } from '../../src/utils/noteSearch';
import { initializeSuggesters } from '../../src/ui/chat/components/suggesters/initializeSuggesters';
import { PLUGIN_IDS } from '../../src/constants/branding';
import type { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';

/** A conceptual query that no basename or path fuzzy-matches. */
const QUERY = 'zzq conceptual';
const SEMANTIC_HIT = 'Ideas/login-flow.md';

function note(name: string, path: string): TFile {
  // The suggester reads `stat.size` for its token estimate; the TFile mock has no stat.
  return Object.assign(new TFile(name, path), { stat: { size: 400, mtime: 0, ctime: 0 } });
}

const FILES = [
  note('login-flow.md', SEMANTIC_HIT),
  note('groceries.md', 'Lists/groceries.md')
];

function fakeService(enabled = true) {
  return {
    isServiceEnabled: jest.fn(() => enabled),
    semanticSearch: jest.fn(async () => [{ notePath: SEMANTIC_HIT, distance: 0.1, score: 0.1 }])
  };
}

function asService(service: ReturnType<typeof fakeService>): EmbeddingService {
  return service as unknown as EmbeddingService;
}

function fakeApp(plugin?: Record<string, unknown>): App {
  const byPath = new Map(FILES.map(file => [file.path, file]));
  return {
    vault: {
      getMarkdownFiles: () => [...FILES],
      getFileByPath: (path: string) => byPath.get(path) ?? null
    },
    plugins: {
      getPlugin: (id: string) => (plugin && id === PLUGIN_IDS.current ? plugin : null)
    }
  } as unknown as App;
}

describe('searchNotes with an embedding resolver', () => {
  it('calls semanticSearch on the service the resolver returns', async () => {
    const service = fakeService();

    const files = await searchNotes(fakeApp(), QUERY, () => asService(service), 10);

    expect(service.semanticSearch).toHaveBeenCalledWith(QUERY, 10);
    expect(files.map(file => file.path)).toEqual([SEMANTIC_HIT]);
  });

  it('asks the resolver again on every query', async () => {
    const first = fakeService();
    const second = fakeService();
    let current: ReturnType<typeof fakeService> | null = first;
    const resolver = () => (current ? asService(current) : null);
    const app = fakeApp();

    await searchNotes(app, QUERY, resolver, 10);
    current = null;
    const whileOff = await searchNotes(app, QUERY, resolver, 10);
    current = second;
    await searchNotes(app, QUERY, resolver, 10);

    expect(whileOff).toEqual([]);
    expect(first.semanticSearch).toHaveBeenCalledTimes(1);
    expect(second.semanticSearch).toHaveBeenCalledTimes(1);
  });

  it('still accepts a plain instance', async () => {
    const service = fakeService();

    await searchNotes(fakeApp(), QUERY, asService(service), 10);

    expect(service.semanticSearch).toHaveBeenCalledTimes(1);
  });
});

describe('composer [[ suggestions use the plugin embedding manager', () => {
  const globalWithWindow = globalThis as unknown as { window?: unknown };
  let originalWindow: unknown;

  beforeEach(() => {
    originalWindow = globalWithWindow.window;
    globalWithWindow.window = {
      activeDocument: {},
      setTimeout,
      clearTimeout
    };
  });

  afterEach(() => {
    globalWithWindow.window = originalWindow;
  });

  function build(manager: { enabled: boolean; service: ReturnType<typeof fakeService> | null }) {
    const plugin: Record<string, unknown> = {
      embeddingManager: {
        isEmbeddingEnabled: () => manager.enabled,
        getService: () => manager.service
      },
      getServiceIfReady: jest.fn(() => null)
    };
    const app = fakeApp(plugin);
    plugin.app = app;
    const component = new Component();
    const suggesters = initializeSuggesters(app, {} as HTMLElement, component);
    return { plugin, suggesters };
  }

  it('suggests the semantic hit for a conceptual query', async () => {
    const service = fakeService();
    const { plugin, suggesters } = build({ enabled: true, service });

    const suggestions = await suggesters.noteSuggester.getSuggestions(QUERY);

    expect(service.semanticSearch).toHaveBeenCalledTimes(1);
    expect(suggestions.map(item => item.data.path)).toEqual([SEMANTIC_HIT]);
    expect(plugin.getServiceIfReady).not.toHaveBeenCalledWith('embeddingService');
  });

  it('picks up embeddings turned on after the composer was built', async () => {
    const manager: { enabled: boolean; service: ReturnType<typeof fakeService> | null } = {
      enabled: false,
      service: null
    };
    const { suggesters } = build(manager);

    const before = await suggesters.noteSuggester.getSuggestions(QUERY);
    const service = fakeService();
    manager.service = service;
    manager.enabled = true;
    const after = await suggesters.noteSuggester.getSuggestions(QUERY);

    expect(before).toEqual([]);
    expect(service.semanticSearch).toHaveBeenCalledTimes(1);
    expect(after.map(item => item.data.path)).toEqual([SEMANTIC_HIT]);
  });
});
