/** A delayed context handoff must not leak a staged model or budget through the settings modal. */
import { App, Notice } from 'obsidian';
import { ChatSettingsModal } from '../../src/ui/chat/components/ChatSettingsModal';
import type { ChatSettings } from '../../src/components/shared/ChatSettingsRenderer';
import type { WorkspaceService } from '../../src/services/WorkspaceService';
import type { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';
import { getContextWindowOverrideKey } from '../../src/ui/chat/utils/ContextWindowSettings';
import { getNexusPlugin } from '../../src/utils/pluginLocator';

jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), Notice: jest.fn() }));
jest.mock('../../src/utils/pluginLocator', () => ({ getNexusPlugin: jest.fn() }));

const key = getContextWindowOverrideKey('openai', 'next');
const oldKey = getContextWindowOverrideKey('openai', 'old');

function fixture() {
  const saveSettings = jest.fn(async () => undefined);
  const llmProviders = { contextWindowOverrides: { [oldKey]: 80_000 } };
  jest.mocked(getNexusPlugin).mockReturnValue({
    settings: { settings: { llmProviders }, saveSettings }
  } as unknown as ReturnType<typeof getNexusPlugin>);
  const manager = {
    getSelectedModel: jest.fn(() => ({ providerId: 'openai', modelId: 'old', contextWindow: 128_000 })),
    getEffectiveContextWindow: jest.fn(() => 70_000),
    getAvailableModels: jest.fn(async () => [{ providerId: 'openai', modelId: 'next', contextWindow: 128_000 }]),
    requestContextChange: jest.fn(async () => true),
    cancelContextHandoff: jest.fn(),
    getSelectedPrompt: jest.fn(() => null),
    getThinkingSettings: jest.fn(() => ({ enabled: false, effort: 'medium' })),
    getAgentThinkingSettings: jest.fn(() => ({ enabled: false, effort: 'medium' })),
    getContextNotes: jest.fn(() => []),
    getTemperature: jest.fn(() => 0.5),
    getAgentProvider: jest.fn(() => null),
    getAgentModel: jest.fn(() => null),
    getWebSearch: jest.fn(() => false),
    getImageProvider: jest.fn(() => null),
    getImageModel: jest.fn(() => null),
    getSpeechProvider: jest.fn(() => null),
    getSpeechModel: jest.fn(() => null),
    getSpeechVoice: jest.fn(() => null),
    getRealtimeVoiceProvider: jest.fn(() => null),
    getRealtimeVoiceModel: jest.fn(() => null),
    getRealtimeVoiceVoice: jest.fn(() => null),
    getTranscriptionProvider: jest.fn(() => null),
    getTranscriptionModel: jest.fn(() => null),
    getSelectedWorkspaceId: jest.fn(() => null),
    getSelectedWorkflowId: jest.fn(async () => null),
    getAvailablePrompts: jest.fn(async () => []),
    handlePromptChange: jest.fn(async () => undefined),
    setThinkingSettings: jest.fn(),
    setWebSearch: jest.fn(),
    setAgentModel: jest.fn(),
    setAgentThinkingSettings: jest.fn(),
    setTemperature: jest.fn(),
    setContextNotes: jest.fn(async () => undefined),
    setImageModel: jest.fn(),
    setSpeechSettings: jest.fn(),
    setRealtimeVoiceSettings: jest.fn(),
    setTranscriptionModel: jest.fn(),
    saveToConversation: jest.fn(async () => undefined)
  };
  const modal = new ChatSettingsModal(new App(), 'conversation', {} as WorkspaceService, manager as unknown as ModelAgentManager);
  const state = modal as unknown as {
    pendingSettings: ChatSettings;
    handleSave(): Promise<void>;
    getCurrentSettings(): ChatSettings;
    saveButton: { setDisabled: jest.Mock };
    saveStatus: { setText: jest.Mock };
  };
  state.pendingSettings = {
    provider: 'openai', model: 'next', contextWindowOverrides: { [oldKey]: 70_000, [key]: 64_000 },
    thinking: { enabled: false, effort: 'medium' }, webSearch: false,
    workspaceId: null, promptId: null, contextNotes: [], temperature: 0.5
  } as ChatSettings;
  state.saveButton = { setDisabled: jest.fn() };
  state.saveStatus = { setText: jest.fn() };
  state.getCurrentSettings();
  return { modal, state, manager, llmProviders, saveSettings };
}

it('shows the conversation pinned context budget when opening settings', () => {
  const { state, llmProviders } = fixture();
  expect(state.getCurrentSettings().contextWindowOverrides?.[oldKey]).toBe(70_000);
  expect(llmProviders.contextWindowOverrides[oldKey]).toBe(80_000);
});

it('sends model and budget in one staged request and saves defaults only after commit', async () => {
  const { state, manager, llmProviders, saveSettings } = fixture();
  let finish!: (value: boolean) => void;
  manager.requestContextChange.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const first = state.handleSave();
  await Promise.resolve();
  await state.handleSave();
  expect(manager.requestContextChange).toHaveBeenCalledTimes(1);
  expect(manager.requestContextChange).toHaveBeenCalledWith({ providerId: 'openai', modelId: 'next', contextWindowOverride: 64_000 });
  expect(state.saveStatus.setText).toHaveBeenCalledWith('Preparing context…');
  expect(state.saveButton.setDisabled).toHaveBeenCalledWith(true);
  expect(saveSettings).not.toHaveBeenCalled();
  expect(llmProviders.contextWindowOverrides).toEqual({ [oldKey]: 80_000 });
  finish(true);
  await first;
  expect(saveSettings).toHaveBeenCalledTimes(1);
  expect(manager.saveToConversation).toHaveBeenCalledWith('conversation');
});

it('keeps all settings unchanged when the handoff is stale', async () => {
  const { state, manager, llmProviders, saveSettings } = fixture();
  manager.requestContextChange.mockResolvedValue(false);
  await state.handleSave();
  expect(saveSettings).not.toHaveBeenCalled();
  expect(llmProviders.contextWindowOverrides).toEqual({ [oldKey]: 80_000 });
  expect(manager.handlePromptChange).not.toHaveBeenCalled();
  expect(manager.saveToConversation).not.toHaveBeenCalled();
});

it('saving an unrelated setting preserves newer global context defaults', async () => {
  const { state, llmProviders, saveSettings, manager } = fixture();
  state.pendingSettings = { ...state.getCurrentSettings(), temperature: 0.7 };
  llmProviders.contextWindowOverrides[oldKey] = 90_000;
  await state.handleSave();
  expect(manager.requestContextChange).toHaveBeenCalledWith({
    providerId: 'openai', modelId: 'old', contextWindowOverride: 70_000
  });
  expect(saveSettings).not.toHaveBeenCalled();
  expect(llmProviders.contextWindowOverrides[oldKey]).toBe(90_000);
  expect(manager.setTemperature).toHaveBeenCalledWith(0.7);
});

it('merges only the edited model budget into the current defaults', async () => {
  const { state, llmProviders } = fixture();
  llmProviders.contextWindowOverrides[oldKey] = 90_000;
  await state.handleSave();
  expect(llmProviders.contextWindowOverrides).toEqual({ [oldKey]: 90_000, [key]: 64_000 });
});

it('passes the advertised maximum when the slider removes an override', async () => {
  const { state, manager } = fixture();
  state.pendingSettings.contextWindowOverrides = { [oldKey]: 70_000 };
  await state.handleSave();
  expect(manager.requestContextChange).toHaveBeenCalledWith({
    providerId: 'openai', modelId: 'next', contextWindowOverride: 128_000
  });
});

it('cancels only its own pending handoff and ignores completion after closing', async () => {
  const { modal, state, manager, saveSettings } = fixture();
  modal.onClose();
  expect(manager.cancelContextHandoff).not.toHaveBeenCalled();
  // A newly opened modal owns the following request.
  (modal as unknown as { closed: boolean }).closed = false;
  state.pendingSettings = {
    provider: 'openai', model: 'next', contextWindowOverrides: { [oldKey]: 70_000, [key]: 64_000 },
    thinking: { enabled: false, effort: 'medium' }, webSearch: false,
    workspaceId: null, promptId: null, contextNotes: [], temperature: 0.5
  } as ChatSettings;
  let finish!: (value: boolean) => void;
  manager.requestContextChange.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const saving = state.handleSave();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(manager.requestContextChange).toHaveBeenCalledTimes(1);
  modal.onClose();
  expect(manager.cancelContextHandoff).toHaveBeenCalledTimes(1);
  finish(true);
  await saving;
  expect(Notice).toHaveBeenCalledWith('Context change was already being saved and has been applied.');
  expect(saveSettings).not.toHaveBeenCalled();
  expect(manager.handlePromptChange).not.toHaveBeenCalled();
});

it('restores the default override map when its separate save fails', async () => {
  const { state, manager, llmProviders, saveSettings } = fixture();
  const original = llmProviders.contextWindowOverrides;
  saveSettings.mockRejectedValueOnce(new Error('disk full'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await state.handleSave();
    expect(manager.requestContextChange).toHaveBeenCalledTimes(1);
    expect(llmProviders.contextWindowOverrides).toBe(original);
    expect(manager.handlePromptChange).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
