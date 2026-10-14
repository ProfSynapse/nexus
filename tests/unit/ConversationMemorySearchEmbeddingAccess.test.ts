/**
 * Regression cover: semantic search of past conversations never ran.
 *
 * `ServiceAccessors.getEmbeddingService()` asked the service registry for
 * `'embeddingService'`, a name nothing registers. The embedding system lives on
 * the plugin as `plugin.embeddingManager`, so the lookup always returned null,
 * `ConversationSearchStrategy` reported conversations "unavailable" and
 * `search memory` silently dropped every conversation hit.
 *
 * What is real: `MemorySearchProcessor`, `ServiceAccessors`,
 * `ConversationSearchStrategy` and the plugin lookup. What is faked: the
 * plugin (a registry that answers null for every name, exactly like the real
 * container did for `'embeddingService'`) and the leaf EmbeddingService, whose
 * `semanticConversationSearch` is a spy. The fake decides nothing about whether
 * the processor finds the service; that is what the test measures.
 *
 * If the accessor went back to the registry, the spy would never be called and
 * every test below that expects a hit goes red.
 */

import { MemorySearchProcessor } from '../../src/agents/searchManager/services/MemorySearchProcessor';
import { PLUGIN_IDS } from '../../src/constants/branding';
import type { ConversationSearchResult } from '../../src/services/embeddings/ConversationEmbeddingService';

const QUERY = 'how did we wire the auth callback';

function conversationHit(id: string): ConversationSearchResult {
  return {
    conversationId: `conv-${id}`,
    conversationTitle: `Auth work ${id}`,
    workspaceId: 'workspace-1',
    pairId: `pair-${id}`,
    matchedSequenceRange: [0, 1],
    question: 'How should the OAuth callback be wired?',
    answer: `Register the redirect handler first (${id}).`,
    matchedSide: 'answer',
    distance: 0.2,
    score: 0.2,
    pairType: 'conversation_turn'
  };
}

function fakeService(id: string) {
  return {
    semanticConversationSearch: jest.fn(async () => [conversationHit(id)])
  };
}

interface FakeManager {
  enabled: boolean;
  service: ReturnType<typeof fakeService> | null;
  isEmbeddingEnabled(): boolean;
  getService(): ReturnType<typeof fakeService> | null;
}

function fakeManager(service: ReturnType<typeof fakeService> | null, enabled = true): FakeManager {
  return {
    enabled,
    service,
    isEmbeddingEnabled() { return this.enabled; },
    getService() { return this.service; }
  };
}

/**
 * A plugin whose registry knows no `'embeddingService'`, found by the
 * processor the way production finds it: through `app.plugins`.
 */
function createPlugin(manager: FakeManager | undefined) {
  const getServiceIfReady = jest.fn(() => null);
  const plugin: Record<string, unknown> = {
    embeddingManager: manager,
    getServiceIfReady,
    getService: jest.fn(async () => null)
  };
  plugin.app = {
    plugins: {
      getPlugin: (id: string) => (id === PLUGIN_IDS.current ? plugin : null)
    }
  };
  return { plugin, getServiceIfReady };
}

function createProcessor(plugin: Record<string, unknown>) {
  return new MemorySearchProcessor(plugin as never);
}

async function searchConversations(processor: MemorySearchProcessor) {
  return processor.process({
    query: QUERY,
    workspaceId: 'workspace-1',
    memoryTypes: ['conversations']
  } as never);
}

describe('conversation memory search reaches the embedding service', () => {
  it('calls semanticConversationSearch on the manager-owned service and returns its hits', async () => {
    const service = fakeService('a');
    const { plugin } = createPlugin(fakeManager(service));

    const { results, metadata } = await searchConversations(createProcessor(plugin));

    expect(service.semanticConversationSearch).toHaveBeenCalledWith(
      QUERY,
      'workspace-1',
      undefined,
      expect.any(Number)
    );
    expect(metadata.typesSearched).toContain('conversations');
    expect(metadata.typesUnavailable).not.toContain('conversations');
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain('conv-a');
  });

  it('does not depend on a registry entry named embeddingService', async () => {
    const service = fakeService('a');
    const { plugin, getServiceIfReady } = createPlugin(fakeManager(service));

    await searchConversations(createProcessor(plugin));

    expect(getServiceIfReady).not.toHaveBeenCalledWith('embeddingService');
    expect(service.semanticConversationSearch).toHaveBeenCalledTimes(1);
  });

  it('reports conversations unavailable while embeddings are turned off', async () => {
    const service = fakeService('a');
    const { plugin } = createPlugin(fakeManager(service, false));

    const { results, metadata } = await searchConversations(createProcessor(plugin));

    expect(service.semanticConversationSearch).not.toHaveBeenCalled();
    expect(metadata.typesUnavailable).toContain('conversations');
    expect(results).toEqual([]);
  });

  it('reports conversations unavailable when the plugin has no embedding manager (mobile)', async () => {
    const { plugin } = createPlugin(undefined);

    const { metadata } = await searchConversations(createProcessor(plugin));

    expect(metadata.typesUnavailable).toContain('conversations');
  });

  it('follows the manager when its service is replaced, without caching the old one', async () => {
    const first = fakeService('first');
    const manager = fakeManager(first);
    const { plugin } = createPlugin(manager);
    const processor = createProcessor(plugin);

    await searchConversations(processor);
    expect(first.semanticConversationSearch).toHaveBeenCalledTimes(1);

    manager.enabled = false;
    const whileOff = await searchConversations(processor);
    expect(whileOff.metadata.typesUnavailable).toContain('conversations');
    expect(first.semanticConversationSearch).toHaveBeenCalledTimes(1);

    const second = fakeService('second');
    manager.service = second;
    manager.enabled = true;
    const { results } = await searchConversations(processor);

    expect(first.semanticConversationSearch).toHaveBeenCalledTimes(1);
    expect(second.semanticConversationSearch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(results[0])).toContain('conv-second');
  });
});
