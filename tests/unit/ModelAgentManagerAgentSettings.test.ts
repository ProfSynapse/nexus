/**
 * Per-chat subagent Creativity and context window (chatSettings.agentTemperature
 * / agentContextWindow) and their defaults (llmProviders.agentTemperature /
 * agentContextWindowOverrides).
 *
 * Defect this buys: a value the user sets for a chat's subagents that is not
 * written to chat settings, not restored on reopen, or not seeded from the
 * defaults for a new chat. The replay case feeds the real conversation event
 * applier, which is what rebuilds the SQLite cache from JSONL.
 */
import { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';
import { ModelAgentDefaultsResolver } from '../../src/ui/chat/services/ModelAgentDefaultsResolver';
import { ConversationEventApplier } from '../../src/database/sync/ConversationEventApplier';
import { getContextWindowOverrideKey } from '../../src/ui/chat/utils/ContextWindowSettings';
import type { App } from 'obsidian';

function createEvents() {
  return { onModelChanged: jest.fn(), onPromptChanged: jest.fn(), onSystemPromptChanged: jest.fn() };
}

function createResolver(llmProviders: Record<string, unknown>): ModelAgentDefaultsResolver {
  return new ModelAgentDefaultsResolver({
    app: {} as App,
    staticModelsService: { findModel: jest.fn() },
    workspaceContextService: {
      restoreWorkspace: jest.fn(),
      createEmptyState: jest.fn(() => ({ selectedWorkspaceId: null, workspaceContext: null, loadedWorkspaceData: null }))
    },
    getAvailableModels: jest.fn(async () => []),
    getAvailablePrompts: jest.fn(async () => []),
    getPlugin: () => ({ settings: { settings: { llmProviders: llmProviders as never } } })
  });
}

describe('ModelAgentDefaultsResolver subagent defaults', () => {
  it('seeds a new chat from agentTemperature and the subagent model window override', async () => {
    const key = getContextWindowOverrideKey('anthropic', 'claude-haiku-5-5');
    const state = await createResolver({
      agentModel: { provider: 'anthropic', model: 'claude-haiku-5-5' },
      agentTemperature: 0.2,
      defaultTemperature: 0.9,
      agentContextWindowOverrides: { [key]: 64_000 }
    }).resolveDefaultState();

    expect(state.agentTemperature).toBe(0.2);
    expect(state.agentContextWindow).toBe(64_000);
  });

  it('falls back to defaultTemperature, then 0.5, and to no window override', async () => {
    expect((await createResolver({ defaultTemperature: 0.9 }).resolveDefaultState()).agentTemperature).toBe(0.9);
    const bare = await createResolver({}).resolveDefaultState();
    expect(bare.agentTemperature).toBe(0.5);
    expect(bare.agentContextWindow).toBeNull();
  });

  it('ignores a chat-model window override for the subagent window', async () => {
    const key = getContextWindowOverrideKey('anthropic', 'claude-haiku-5-5');
    const state = await createResolver({
      agentModel: { provider: 'anthropic', model: 'claude-haiku-5-5' },
      contextWindowOverrides: { [key]: 50_000 }
    }).resolveDefaultState();
    expect(state.agentContextWindow).toBeNull();
  });
});

describe('ModelAgentManager subagent chat settings', () => {
  it('saves the subagent Creativity and window into chat settings', async () => {
    const conversationService = {
      getConversation: jest.fn().mockResolvedValue({ metadata: { chatSettings: { sessionId: 's1' } } }),
      updateConversationMetadata: jest.fn().mockResolvedValue(undefined)
    };
    const manager = new ModelAgentManager({}, createEvents(), conversationService);
    manager.setAgentTemperature(0.3);
    manager.setAgentContextWindow(32_000);

    await manager.saveToConversation('conv_1');

    expect(conversationService.updateConversationMetadata).toHaveBeenCalledWith('conv_1', {
      chatSettings: expect.objectContaining({ agentTemperature: 0.3, agentContextWindow: 32_000 })
    });
  });

  it('restores them from chat settings and exposes them as agent settings', async () => {
    const conversationService = {
      getConversation: jest.fn().mockResolvedValue({
        metadata: {
          chatSettings: {
            agentProvider: 'anthropic',
            agentModel: 'claude-haiku-5-5',
            agentThinking: { enabled: true, effort: 'high' },
            agentTemperature: 0.3,
            agentContextWindow: 32_000
          }
        }
      })
    };
    const manager = new ModelAgentManager({}, createEvents(), conversationService);
    jest.spyOn(manager, 'getAvailableModels').mockResolvedValue([]);
    jest.spyOn(manager, 'getAvailablePrompts').mockResolvedValue([]);

    await manager.initializeFromConversation('conv_1');

    expect(manager.getAgentTemperature()).toBe(0.3);
    expect(manager.getAgentContextWindow()).toBe(32_000);
    expect(manager.getAgentSettings()).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      thinking: { enabled: true, effort: 'high' },
      temperature: 0.3,
      contextWindow: 32_000
    });
  });

  it('clears the window with null and rejects nonsense values', () => {
    const manager = new ModelAgentManager({}, createEvents());
    manager.setAgentContextWindow(32_000);
    manager.setAgentContextWindow(null);
    expect(manager.getAgentContextWindow()).toBeNull();
    manager.setAgentContextWindow(-5);
    expect(manager.getAgentContextWindow()).toBeNull();
    manager.setAgentTemperature(4);
    expect(manager.getAgentTemperature()).toBe(1);
  });
});

describe('subagent chat settings survive a cache rebuild', () => {
  it('replays conversation_updated with the new chatSettings fields into metadataJson', async () => {
    // Replay is how "Rebuild cache" repopulates SQLite from the JSONL events.
    const sqliteCache = { run: jest.fn(async (_sql: string, _params: unknown[]) => undefined) };
    const applier = new ConversationEventApplier(sqliteCache);
    const settings = {
      chatSettings: { sessionId: 's1', agentProvider: 'anthropic', agentTemperature: 0.3, agentContextWindow: 32_000 }
    };

    await applier.apply({
      id: 'evt-1', type: 'conversation_updated', deviceId: 'device-1', timestamp: 1,
      conversationId: 'conv_1', data: { updated: 1, settings }
    });

    const [sql, values] = sqliteCache.run.mock.calls[0];
    expect(sql).toContain('metadataJson = ?');
    const metadataJson = values.find(value => typeof value === 'string' && value.includes('chatSettings')) as string;
    expect(JSON.parse(metadataJson).chatSettings).toEqual(expect.objectContaining({ agentTemperature: 0.3, agentContextWindow: 32_000 }));
  });
});
