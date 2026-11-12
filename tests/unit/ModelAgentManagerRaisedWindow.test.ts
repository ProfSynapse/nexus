/**
 * Issue #439: a chat that was using a model's whole window must follow the
 * window when it grows (an OpenAI-compatible model raised from its 4,096
 * fallback), while a smaller budget the user chose stays put.
 */
import { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';
import type { ModelOption } from '../../src/ui/chat/types/SelectionTypes';
import type { ConversationMetadataWithCompaction } from '../../src/ui/chat/services/ModelAgentConversationSettingsStore';
import { followRaisedContextWindow } from '../../src/ui/chat/utils/ContextWindowSettings';

const COMPATIBLE = 'openai-compatible-home';

const option = (providerId: string, contextWindow: number): ModelOption => ({
  providerId, providerName: providerId, modelId: 'qwen', modelName: 'qwen', contextWindow
});

function persistence(chatSettings: NonNullable<ConversationMetadataWithCompaction['chatSettings']>) {
  let metadata: ConversationMetadataWithCompaction = { chatSettings: { modelId: 'qwen', sessionId: 'session', ...chatSettings }, compaction: { frontier: [] } };
  return {
    store: {
      getConversation: jest.fn(async () => ({ metadata })),
      updateConversationMetadata: jest.fn(async (_id: string, next: Record<string, unknown>) => {
        metadata = next as ConversationMetadataWithCompaction;
      })
    },
    read: () => metadata
  };
}

const events = () => ({ onModelChanged: jest.fn(), onPromptChanged: jest.fn(), onSystemPromptChanged: jest.fn() });

/** Opens the conversation with the model now reporting `currentWindow`. */
async function reopen(chatSettings: NonNullable<ConversationMetadataWithCompaction['chatSettings']>, currentWindow: number) {
  const { store } = persistence(chatSettings);
  const manager = new ModelAgentManager({}, events(), store, 'conversation');
  jest.spyOn(manager, 'resolveModelOption').mockImplementation(async provider => option(provider, currentWindow));
  await manager.initializeFromConversation('conversation');
  return manager;
}

describe('followRaisedContextWindow', () => {
  test('a budget at the old whole window takes the new one', () => {
    expect(followRaisedContextWindow(4096, 4096, 32_768)).toBe(32_768);
  });

  test('a smaller budget stays, and every budget is clamped to a smaller window', () => {
    expect(followRaisedContextWindow(2048, 4096, 32_768)).toBe(2048);
    expect(followRaisedContextWindow(65_536, 65_536, 32_768)).toBe(32_768);
  });

  test('without a record of the old window the budget stays', () => {
    expect(followRaisedContextWindow(8192, undefined, 32_768)).toBe(8192);
  });
});

describe('a chat reopened after its model window was raised', () => {
  test('follows the new window when it was using all of the old one', async () => {
    const manager = await reopen({ providerId: COMPATIBLE, effectiveContextWindow: 8192, modelContextWindow: 8192 }, 32_768);
    expect(manager.getEffectiveContextWindow()).toBe(32_768);
  });

  test('keeps a smaller budget the user chose', async () => {
    const manager = await reopen({ providerId: COMPATIBLE, effectiveContextWindow: 2048, modelContextWindow: 8192 }, 32_768);
    expect(manager.getEffectiveContextWindow()).toBe(2048);
  });

  test('follows when an older chat was stuck at the 4,096 fallback', async () => {
    // Saved before the whole window was recorded: on an OpenAI-compatible
    // endpoint 4,096 was the only window a chat could have.
    const manager = await reopen({ providerId: COMPATIBLE, effectiveContextWindow: 4096 }, 32_768);
    expect(manager.getEffectiveContextWindow()).toBe(32_768);
  });

  test('keeps an older budget on other providers, where its meaning is unknown', async () => {
    const manager = await reopen({ providerId: 'openai-codex', effectiveContextWindow: 4096 }, 200_000);
    expect(manager.getEffectiveContextWindow()).toBe(4096);
  });
});

describe('an open chat when provider settings raise the window', () => {
  function openChat(committedWindow?: number) {
    const { store, read } = persistence({ providerId: COMPATIBLE, effectiveContextWindow: 4096 });
    const listeners = events();
    const manager = new ModelAgentManager({}, listeners, store, 'conversation');
    manager.handleModelChange(option(COMPATIBLE, 4096), committedWindow);
    const resolve = jest.spyOn(manager, 'resolveModelOption').mockImplementation(async provider => option(provider, 32_768));
    return { manager, listeners, resolve, read };
  }

  test('follows the new window and tells the view', async () => {
    const { manager, listeners } = openChat();
    expect(manager.getEffectiveContextWindow()).toBe(4096);
    await manager.followModelWindowChange();
    expect(manager.getEffectiveContextWindow()).toBe(32_768);
    expect(manager.getSelectedModel()?.contextWindow).toBe(32_768);
    expect(listeners.onModelChanged).toHaveBeenLastCalledWith(expect.objectContaining({ contextWindow: 32_768 }));
  });

  test('keeps a smaller budget the user chose', async () => {
    const { manager } = openChat(2048);
    await manager.followModelWindowChange();
    expect(manager.getEffectiveContextWindow()).toBe(2048);
  });

  test('does nothing when the window did not change', async () => {
    const { manager, listeners, resolve } = openChat();
    resolve.mockImplementation(async provider => option(provider, 4096));
    listeners.onModelChanged.mockClear();
    await manager.followModelWindowChange();
    expect(manager.getEffectiveContextWindow()).toBe(4096);
    expect(listeners.onModelChanged).not.toHaveBeenCalled();
  });

  test('records the whole window beside the budget when the chat is next saved', async () => {
    const { manager, read } = openChat();
    manager.configureContextHandoff({ prepare: async () => undefined });
    await manager.requestContextChange({ providerId: COMPATIBLE, modelId: 'qwen', contextWindowOverride: 2048 });
    expect(read().chatSettings).toMatchObject({ effectiveContextWindow: 2048, modelContextWindow: 32_768 });
  });
});
