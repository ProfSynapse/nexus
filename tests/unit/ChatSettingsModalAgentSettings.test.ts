/**
 * The Chat settings modal reads and writes this chat's subagent Creativity and
 * context limit, and never writes them to Defaults.
 *
 * Failures this buys: the modal opening with the Defaults value instead of
 * this chat's, Save dropping the subagent values (subagents would keep the
 * old ones), a limit picked for one subagent model being kept after the
 * subagent model changes, choosing the maximum silently falling back to a
 * lower Defaults limit, and the modal writing global settings.
 */
import { App } from 'obsidian';
import { ChatSettingsModal } from '../../src/ui/chat/components/ChatSettingsModal';
import type { ChatSettings } from '../../src/components/shared/ChatSettingsRenderer';
import type { WorkspaceService } from '../../src/services/WorkspaceService';
import type { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';
import { getContextWindowOverrideKey } from '../../src/ui/chat/utils/ContextWindowSettings';
import { getNexusPlugin } from '../../src/utils/pluginLocator';

jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), Notice: jest.fn() }));
jest.mock('../../src/utils/pluginLocator', () => ({ getNexusPlugin: jest.fn() }));

const haiku = getContextWindowOverrideKey('anthropic', 'claude-haiku-5-5');
const opus46 = getContextWindowOverrideKey('anthropic', 'claude-opus-4-6');

function fixture(options: { agentContextWindow?: number | null; defaultAgentLimits?: Record<string, number> } = {}) {
  const saveSettings = jest.fn(async () => undefined);
  const llmProviders = {
    agentTemperature: 0.9,
    agentContextWindowOverrides: { ...(options.defaultAgentLimits ?? {}) }
  };
  jest.mocked(getNexusPlugin).mockReturnValue({
    settings: { settings: { llmProviders }, saveSettings }
  } as unknown as ReturnType<typeof getNexusPlugin>);
  const manager = {
    getSelectedModel: jest.fn(() => ({ providerId: 'anthropic', modelId: 'claude-opus-5-5', contextWindow: 1_000_000 })),
    getEffectiveContextWindow: jest.fn(() => 1_000_000),
    getAvailableModels: jest.fn(async () => []),
    requestContextChange: jest.fn(async () => true),
    cancelContextHandoff: jest.fn(),
    getSelectedPrompt: jest.fn(() => null),
    getThinkingSettings: jest.fn(() => ({ enabled: false, effort: 'medium' })),
    getAgentThinkingSettings: jest.fn(() => ({ enabled: false, effort: 'medium' })),
    getAgentTemperature: jest.fn(() => 0.2),
    getAgentContextWindow: jest.fn(() => options.agentContextWindow ?? null),
    getContextNotes: jest.fn(() => []),
    getTemperature: jest.fn(() => 0.5),
    getAgentProvider: jest.fn(() => 'anthropic'),
    getAgentModel: jest.fn(() => 'claude-haiku-5-5'),
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
    setAgentTemperature: jest.fn(),
    setAgentContextWindow: jest.fn(),
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
    pendingSettings: ChatSettings | null;
    handleSave(): Promise<void>;
    getCurrentSettings(): ChatSettings;
    saveButton: { setDisabled: jest.Mock };
    saveStatus: { setText: jest.Mock };
  };
  state.saveButton = { setDisabled: jest.fn() };
  state.saveStatus = { setText: jest.fn() };
  const save = async (edit: (settings: ChatSettings) => ChatSettings) => {
    state.pendingSettings = edit(state.getCurrentSettings());
    await state.handleSave();
  };
  return { state, manager, llmProviders, saveSettings, save };
}

it('opens with this chat\'s subagent Creativity and limit', () => {
  const { state } = fixture({ agentContextWindow: 350_000 });
  const settings = state.getCurrentSettings();
  expect(settings.agentTemperature).toBe(0.2);
  expect(settings.agentContextWindowOverrides).toEqual({ [haiku]: 350_000 });
});

it('shows the Defaults limit when this chat has none', () => {
  const { state } = fixture({ agentContextWindow: null, defaultAgentLimits: { [haiku]: 200_000 } });
  expect(state.getCurrentSettings().agentContextWindowOverrides).toEqual({ [haiku]: 200_000 });
});

it('saves subagent Creativity and limit to this chat only', async () => {
  const { manager, llmProviders, saveSettings, save } = fixture();
  await save(settings => ({
    ...settings,
    agentTemperature: 0.4,
    agentContextWindowOverrides: { [haiku]: 128_000 }
  }));
  expect(manager.setAgentTemperature).toHaveBeenCalledWith(0.4);
  expect(manager.setAgentContextWindow).toHaveBeenCalledWith(128_000);
  expect(manager.saveToConversation).toHaveBeenCalledWith('conversation');
  expect(saveSettings).not.toHaveBeenCalled();
  expect(llmProviders.agentTemperature).toBe(0.9);
  expect(llmProviders.agentContextWindowOverrides).toEqual({});
});

it('keeps no limit from the previous subagent model', async () => {
  const { manager, save } = fixture({ agentContextWindow: 128_000 });
  await save(settings => ({
    ...settings,
    agentModel: 'claude-opus-4-6',
    // The renderer clears the newly picked model's key; the old one stays in the map.
    agentContextWindowOverrides: { [haiku]: 128_000 }
  }));
  expect(manager.setAgentContextWindow).toHaveBeenCalledWith(null);
});

it('keeps the maximum explicitly when Defaults set a lower limit for that model', async () => {
  const { manager, save } = fixture({ agentContextWindow: 64_000, defaultAgentLimits: { [opus46]: 64_000 } });
  await save(settings => ({
    ...settings,
    agentModel: 'claude-opus-4-6',
    agentContextWindowOverrides: {}
  }));
  expect(manager.setAgentContextWindow).toHaveBeenCalledWith(200_000);
});
