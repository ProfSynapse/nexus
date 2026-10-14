/**
 * Chat settings saved while no conversation is open stay in memory and carry
 * into the next chat (plan decision 7). The first conversation created
 * afterwards must hold them in its stored chatSettings.
 *
 * Failure this buys: if selecting the freshly created conversation reset the
 * manager to the plugin defaults (initializeFromConversation re-reads the
 * defaults first), the temperature and thinking chosen in the modal would be
 * silently dropped and the new chat would run with the defaults.
 *
 * Real pieces: ModelAgentManager, ChatSettingsModal.handleSave and the chat
 * ConversationManager.createConversation that writes the initial metadata.
 * Faked: the conversation store (an in-memory map) and the defaults resolver.
 */
import { App } from 'obsidian';
import { ChatSettingsModal } from '../../src/ui/chat/components/ChatSettingsModal';
import { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';
import { ConversationManager } from '../../src/services/chat/ConversationManager';
import type { ChatSettings } from '../../src/components/shared/ChatSettingsRenderer';
import type { WorkspaceService } from '../../src/services/WorkspaceService';
import type { ModelAgentDefaultState } from '../../src/ui/chat/services/ModelAgentDefaultsResolver';
import type { ConversationData } from '../../src/types/chat/ChatTypes';
import type { ModelOption } from '../../src/ui/chat/types/SelectionTypes';
import { getContextWindowOverrideKey } from '../../src/ui/chat/utils/ContextWindowSettings';

jest.mock('../../src/utils/pluginLocator', () => ({ getNexusPlugin: jest.fn(() => null) }));

const model: ModelOption = {
  providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-test', modelName: 'GPT Test', contextWindow: 128_000
};

function defaultState(): ModelAgentDefaultState {
  return {
    selectedModel: model,
    selectedPrompt: null,
    currentSystemPrompt: null,
    workspaceState: { selectedWorkspaceId: null, workspaceContext: null, loadedWorkspaceData: null },
    contextNotes: [],
    thinkingSettings: { enabled: false, effort: 'medium' },
    agentProvider: null,
    agentModel: null,
    agentThinkingSettings: { enabled: false, effort: 'medium' },
    imageProvider: 'google',
    imageModel: 'gemini-3.1-flash-image',
    speechProvider: null,
    speechModel: null,
    speechVoice: null,
    realtimeVoiceProvider: null,
    realtimeVoiceModel: null,
    realtimeVoiceVoice: null,
    transcriptionProvider: null,
    transcriptionModel: null,
    temperature: 0.5
  };
}

function inMemoryConversations() {
  const store = new Map<string, ConversationData>();
  let next = 0;
  return {
    store,
    getConversation: jest.fn(async (id: string) => store.get(id) ?? null),
    updateConversationMetadata: jest.fn(async (id: string, metadata: Record<string, unknown>) => {
      const conversation = store.get(id);
      if (conversation) store.set(id, { ...conversation, metadata: { ...conversation.metadata, ...metadata } });
    }),
    createConversation: jest.fn(async (data: unknown) => {
      const conversation = { ...(data as object), id: `conv_${++next}`, created: Date.now(), updated: Date.now() } as ConversationData;
      store.set(conversation.id, conversation);
      return conversation;
    }),
    addMessage: jest.fn(async () => undefined),
    updateConversation: jest.fn(async () => undefined),
    deleteConversation: jest.fn(async () => undefined)
  };
}

it('carries settings saved with no open chat into the first conversation created afterwards', async () => {
  const conversations = inMemoryConversations();
  const manager = new ModelAgentManager(
    new App(),
    { onModelChanged: jest.fn(), onPromptChanged: jest.fn(), onSystemPromptChanged: jest.fn() },
    conversations
  );
  const internals = manager as unknown as {
    defaultsResolver: { resolveDefaultState: jest.Mock; resolveModelOption: jest.Mock; getSelectedModelOrDefault: jest.Mock };
  };
  internals.defaultsResolver = {
    resolveDefaultState: jest.fn(async () => defaultState()),
    resolveModelOption: jest.fn(async () => model),
    getSelectedModelOrDefault: jest.fn(async () => model)
  };

  // Welcome state: nothing open, defaults loaded.
  await manager.initializeDefaults();
  expect(manager.getTemperature()).toBe(0.5);

  // Save the modal with no conversation.
  const modal = new ChatSettingsModal(new App(), null, {} as WorkspaceService, manager);
  const modalState = modal as unknown as { pendingSettings: ChatSettings; handleSave(): Promise<void> };
  modalState.pendingSettings = {
    provider: 'openai', model: 'gpt-test',
    contextWindowOverrides: { [getContextWindowOverrideKey('openai', 'gpt-test')]: 64_000 },
    thinking: { enabled: true, effort: 'high' }, webSearch: false,
    workspaceId: null, promptId: null, contextNotes: [], temperature: 0.8,
    imageProvider: 'google', imageModel: 'gemini-3.1-flash-image'
  };
  await modalState.handleSave();
  expect(manager.getTemperature()).toBe(0.8);
  expect(manager.getEffectiveContextWindow()).toBe(64_000);
  expect(manager.getThinkingSettings()).toEqual({ enabled: true, effort: 'high' });

  // "Start your first conversation": create it, then select it the way ChatSessionCoordinator does.
  const chatConversations = new ConversationManager(
    { conversationService: conversations, streamingGenerator: async function* () { /* unused */ } },
    'vault'
  );
  const created = await chatConversations.createConversation({ title: 'First chat' });
  manager.setCurrentConversationId(created.id);
  await manager.initializeFromConversation(created.id);

  expect(manager.getTemperature()).toBe(0.8);
  expect(manager.getThinkingSettings()).toEqual({ enabled: true, effort: 'high' });
  expect(manager.getEffectiveContextWindow()).toBe(64_000);
  const stored = conversations.store.get(created.id)?.metadata?.chatSettings as
    { temperature?: number; thinking?: { enabled: boolean; effort: string }; effectiveContextWindow?: number; sessionId?: string } | undefined;
  expect(stored?.temperature).toBe(0.8);
  expect(stored?.thinking).toEqual({ enabled: true, effort: 'high' });
  expect(stored?.effectiveContextWindow).toBe(64_000);
  expect(stored?.sessionId).toBe(created.metadata?.chatSettings?.sessionId);

  // Reopening the conversation restores what was stored, not the defaults.
  await manager.initializeFromConversation(created.id);
  expect(manager.getTemperature()).toBe(0.8);
});

it('a conversation opened after the welcome defaults reload starts from the defaults', async () => {
  const conversations = inMemoryConversations();
  const manager = new ModelAgentManager(
    new App(),
    { onModelChanged: jest.fn(), onPromptChanged: jest.fn(), onSystemPromptChanged: jest.fn() },
    conversations
  );
  (manager as unknown as { defaultsResolver: unknown }).defaultsResolver = {
    resolveDefaultState: jest.fn(async () => defaultState()),
    resolveModelOption: jest.fn(async () => model),
    getSelectedModelOrDefault: jest.fn(async () => model)
  };
  await manager.initializeDefaults();
  manager.setTemperature(0.9);
  manager.carrySelectionsIntoNextConversation();
  // The welcome state reloads the defaults, which drops anything carried.
  await manager.initializeDefaults();
  const created = await new ConversationManager(
    { conversationService: conversations, streamingGenerator: async function* () { /* unused */ } },
    'vault'
  ).createConversation({ title: 'Later chat' });
  manager.setCurrentConversationId(created.id);
  await manager.initializeFromConversation(created.id);
  expect(manager.getTemperature()).toBe(0.5);
});
