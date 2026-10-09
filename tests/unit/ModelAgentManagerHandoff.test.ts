import { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';
import type { ModelOption } from '../../src/ui/chat/types/SelectionTypes';
import type { ConversationMetadataWithCompaction } from '../../src/ui/chat/services/ModelAgentConversationSettingsStore';
import { ContextHandoffService } from '../../src/services/chat/ContextHandoffService';
import { ContextCompactionService } from '../../src/services/chat/ContextCompactionService';
import type { ConversationData } from '../../src/types/chat/ChatTypes';

const model = (modelId: string, contextWindow: number): ModelOption => ({
  providerId: 'openai-codex', providerName: 'Codex', modelId, modelName: modelId, contextWindow
});

function fixture() {
  let metadata: ConversationMetadataWithCompaction = {
    title: 'Keep this metadata',
    chatSettings: { providerId: 'openai-codex', modelId: 'large', effectiveContextWindow: 200_000, sessionId: 'existing-session' },
    compaction: { frontier: [] }
  };
  const persistence = {
    getConversation: jest.fn(async () => ({ metadata })),
    updateConversationMetadata: jest.fn(async (_id: string, next: Record<string, unknown>) => {
      metadata = next as ConversationMetadataWithCompaction;
    })
  };
  const events = { onModelChanged: jest.fn(), onPromptChanged: jest.fn(), onSystemPromptChanged: jest.fn() };
  const manager = new ModelAgentManager({}, events, persistence, 'conversation');
  manager.handleModelChange(model('large', 200_000));
  jest.spyOn(manager, 'resolveModelOption').mockImplementation(async (_provider, id) =>
    id === 'large' ? model('large', 200_000) : model('small', 16_000));
  return { manager, persistence, events, getMetadata: () => metadata };
}

describe('ModelAgentManager staged context handoff', () => {
  it('keeps the source active through preparation, then persists model, window and replacement frontier together', async () => {
    const { manager, persistence, getMetadata } = fixture();
    let release!: (summary: { summary: string; boundaryMessageId: string }) => void;
    const candidate = new Promise<{ summary: string; boundaryMessageId: string }>(resolve => { release = resolve; });
    const prepare = jest.fn(async () => await candidate);
    manager.configureContextHandoff({ prepare });
    const pending = manager.requestContextChange({ providerId: 'openai-codex', modelId: 'small', contextWindowOverride: 8192 });
    await Promise.resolve();
    expect(manager.getSelectedModel()?.modelId).toBe('large');
    expect(manager.getEffectiveContextWindow()).toBe(200_000);
    expect(manager.isContextHandoffPending()).toBe(true);
    release({ summary: 'Preserved context', boundaryMessageId: 'last-message' });
    await expect(pending).resolves.toBe(true);
    expect(persistence.updateConversationMetadata).toHaveBeenCalledTimes(1);
    expect(getMetadata()).toMatchObject({
      title: 'Keep this metadata',
      chatSettings: { modelId: 'small', effectiveContextWindow: 8192, sessionId: 'existing-session' },
      compaction: { frontier: [{ summary: 'Preserved context', boundaryMessageId: 'last-message' }] }
    });
    expect(manager.getSelectedModel()?.modelId).toBe('small');
    expect(manager.getEffectiveContextWindow()).toBe(8192);
  });

  it('preserves active model and frontier if persistence fails', async () => {
    const { manager, persistence } = fixture();
    manager.configureContextHandoff({ prepare: async () => ({ summary: 'New summary', boundaryMessageId: 'last' }) });
    persistence.updateConversationMetadata.mockRejectedValueOnce(new Error('disk failed'));
    await expect(manager.requestContextChange({ providerId: 'openai-codex', modelId: 'small' })).rejects.toThrow('disk failed');
    expect(manager.getSelectedModel()?.modelId).toBe('large');
    expect(manager.getEffectiveContextWindow()).toBe(200_000);
    expect(manager.hasCompactionFrontier()).toBe(false);
  });

  it('appends a compensating metadata event when the cache fails after the target event', async () => {
    const { manager, persistence, getMetadata } = fixture();
    manager.configureContextHandoff({ prepare: async () => ({ summary: 'New summary', boundaryMessageId: 'last' }) });
    const normalUpdate = persistence.updateConversationMetadata.getMockImplementation();
    let attempt = 0;
    persistence.updateConversationMetadata.mockImplementation(async (id, next) => {
      attempt++;
      await normalUpdate?.(id, next);
      if (attempt === 1) throw new Error('cache update failed after JSONL append');
    });
    await expect(manager.requestContextChange({ providerId: 'openai-codex', modelId: 'small' }))
      .rejects.toThrow('cache update failed after JSONL append');
    expect(persistence.updateConversationMetadata).toHaveBeenCalledTimes(2);
    expect(getMetadata().chatSettings).toMatchObject({ modelId: 'large', effectiveContextWindow: 200_000 });
    expect(getMetadata()).toMatchObject({ title: 'Keep this metadata', chatSettings: { sessionId: 'existing-session' } });
    expect(getMetadata().compaction?.frontier).toEqual([]);
    expect(manager.getSelectedModel()?.modelId).toBe('large');
    await expect(manager.waitForContextHandoff()).resolves.toBeUndefined();
  });

  it('restores the source model and budget even when legacy metadata had no chat settings', async () => {
    let metadata: ConversationMetadataWithCompaction = {};
    let writes = 0;
    const persistence = {
      getConversation: jest.fn(async () => ({ metadata })),
      updateConversationMetadata: jest.fn(async (_id: string, next: Record<string, unknown>) => {
        metadata = next as ConversationMetadataWithCompaction;
        if (++writes === 1) throw new Error('cache failed after append');
      })
    };
    const manager = new ModelAgentManager({}, { onModelChanged: jest.fn(), onPromptChanged: jest.fn(), onSystemPromptChanged: jest.fn() }, persistence, 'conversation');
    manager.handleModelChange(model('large', 200_000));
    jest.spyOn(manager, 'resolveModelOption').mockResolvedValue(model('small', 16_000));
    manager.configureContextHandoff({ prepare: async () => undefined });
    await expect(manager.requestContextChange({ providerId: 'openai-codex', modelId: 'small' }))
      .rejects.toThrow('cache failed after append');
    expect(metadata.chatSettings).toMatchObject({
      providerId: 'openai-codex', modelId: 'large', effectiveContextWindow: 200_000
    });
    expect(metadata.compaction?.frontier).toEqual([]);
  });

  it('blocks sends when both target and compensating metadata events fail', async () => {
    const { manager, persistence } = fixture();
    manager.configureContextHandoff({ prepare: async () => ({ summary: 'New summary', boundaryMessageId: 'last' }) });
    persistence.updateConversationMetadata.mockRejectedValue(new Error('storage unavailable'));
    await expect(manager.requestContextChange({ providerId: 'openai-codex', modelId: 'small' }))
      .rejects.toThrow('Context save could not be recovered');
    await expect(manager.waitForContextHandoff()).rejects.toThrow('reload this chat');
    await expect(manager.requestContextChange({ providerId: 'openai-codex', modelId: 'small' }))
      .rejects.toThrow('reload this chat');
    expect(manager.getSelectedModel()?.modelId).toBe('large');
  });

  it('cancels preparation and ignores stale results without persisting', async () => {
    const { manager, persistence } = fixture();
    let release!: () => void;
    manager.configureContextHandoff({ prepare: async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { summary: 'Stale summary', boundaryMessageId: 'last' };
    } });
    const pending = manager.requestContextChange({ providerId: 'openai-codex', modelId: 'small' });
    await Promise.resolve();
    manager.cancelContextHandoff();
    release();
    await expect(pending).resolves.toBe(false);
    expect(persistence.updateConversationMetadata).not.toHaveBeenCalled();
    expect(manager.getSelectedModel()?.modelId).toBe('large');
  });

  it('rejects a waiting send when a handoff is cancelled', async () => {
    const { manager } = fixture();
    let release!: () => void;
    manager.configureContextHandoff({ prepare: async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return undefined;
    } });
    const pending = manager.requestContextChange({ providerId: 'openai-codex', modelId: 'small' });
    await Promise.resolve();
    const sendGate = manager.waitForContextHandoff();
    manager.cancelContextHandoff();
    release();
    await expect(pending).resolves.toBe(false);
    await expect(sendGate).rejects.toThrow('cancelled');
  });

  it('treats an explicit undefined override as reset to the model maximum', async () => {
    const { manager } = fixture();
    manager.configureContextHandoff({ prepare: async () => undefined });
    await manager.requestContextChange({ providerId: 'openai-codex', modelId: 'large', contextWindowOverride: 8192 });
    expect(manager.getEffectiveContextWindow()).toBe(8192);
    await manager.requestContextChange({ providerId: 'openai-codex', modelId: 'large', contextWindowOverride: undefined });
    expect(manager.getEffectiveContextWindow()).toBe(200_000);
  });

  it('restores the committed budget after reload regardless of global defaults', async () => {
    const { manager, persistence } = fixture();
    manager.configureContextHandoff({ prepare: async () => undefined });
    await manager.requestContextChange({ providerId: 'openai-codex', modelId: 'small', contextWindowOverride: 8192 });
    const reloaded = new ModelAgentManager({}, { onModelChanged: jest.fn(), onPromptChanged: jest.fn(), onSystemPromptChanged: jest.fn() }, persistence, 'conversation');
    jest.spyOn(reloaded, 'resolveModelOption').mockImplementation(async (_provider, id) => model(id, 16_000));
    await reloaded.initializeFromConversation('conversation');
    reloaded.refreshContextWindowLimit();
    expect(reloaded.getEffectiveContextWindow()).toBe(8192);
    expect(reloaded.getSelectedModel()?.modelId).toBe('small');
  });

  it('uses the real budget and compaction boundary through commit, next prompt and reload', async () => {
    let metadata: ConversationMetadataWithCompaction = {
      chatSettings: { providerId: 'openai-codex', modelId: 'large', effectiveContextWindow: 250_000, sessionId: 'session' }
    };
    const messages = [{ id: 'oversized', role: 'user' as const, content: 'x'.repeat(540_000), timestamp: 1, conversationId: 'conversation' }];
    const conversation = {
      id: 'conversation', title: 'Large transcript', created: 1, updated: 1, messages,
      get metadata() { return metadata; }
    } as ConversationData;
    const persistence = {
      getConversation: jest.fn(async () => ({ metadata })),
      updateConversationMetadata: jest.fn(async (_id: string, next: Record<string, unknown>) => {
        metadata = next as ConversationMetadataWithCompaction;
      })
    };
    const events = { onModelChanged: jest.fn(), onPromptChanged: jest.fn(), onSystemPromptChanged: jest.fn() };
    const manager = new ModelAgentManager({}, events, persistence, 'conversation');
    manager.handleModelChange(model('large', 250_000));
    jest.spyOn(manager, 'resolveModelOption').mockImplementation(async (_provider, id) =>
      model(id, id === 'large' ? 250_000 : 128_000));
    const summarizer = jest.fn().mockResolvedValue('The earlier request contained a large research brief.');
    const handoff = new ContextHandoffService();
    manager.configureContextHandoff({
      prepare: async ({ source, destination, signal }) => handoff.prepare({
        conversation, source, destination, signal, systemPrompt: 'Instructions', summarizer
      })
    });

    await expect(manager.requestContextChange({ providerId: 'openai-codex', modelId: 'small' })).resolves.toBe(true);
    expect(summarizer).toHaveBeenCalledWith(messages, expect.objectContaining({
      provider: 'openai-codex', model: 'large', sourceContextWindow: 250_000
    }));
    expect(conversation.messages).toEqual(messages);
    expect(metadata.compaction?.frontier?.[0]).toMatchObject({
      boundaryMessageId: 'oversized', boundaryMode: 'after', summary: 'The earlier request contained a large research brief.'
    });
    expect(ContextCompactionService.getMessagesAfterBoundary(conversation.messages, conversation.metadata)).toEqual([]);
    const prompt = await manager.getMessageOptions();
    expect(prompt.systemPrompt).toContain('The earlier request contained a large research brief.');
    expect(await manager.getHandoffSystemPrompt()).not.toContain('The earlier request contained a large research brief.');

    const reloaded = new ModelAgentManager({}, events, persistence, 'conversation');
    jest.spyOn(reloaded, 'resolveModelOption').mockImplementation(async (_provider, id) => model(id, 128_000));
    await reloaded.initializeFromConversation('conversation');
    expect(reloaded.getEffectiveContextWindow()).toBe(128_000);
    expect(reloaded.getCompactionFrontier()[0]?.boundaryMode).toBe('after');
    expect((await reloaded.getMessageOptions()).systemPrompt).toContain('The earlier request contained a large research brief.');
  });
});
