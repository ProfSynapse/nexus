/**
 * Voice settings exist once.
 *
 * Failures this buys: Defaults and Chat settings each had their own voice
 * section with different labels ("Voice input" vs "Transcription", "Speech
 * provider", "Live voice provider"), and the Defaults copy wrote straight to
 * llmProviderSettings and saved outside the tab's queue. Now both surfaces
 * render VoiceSettings; Defaults persists a read-aloud default only after a
 * manual pick, marked `source: 'user'`, and merely opening the tab saves nothing.
 *
 * Real: renderer, VoiceSettings, DefaultsTab, the speech and realtime registries
 * and catalogs (OpenAI resolves statically). Mocked: chat model lists and the
 * transcription capability list.
 */
jest.mock('../../src/services/llm/providers/ProviderManager', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').providerManagerModule());
jest.mock('../../src/services/StaticModelsService', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').staticModelsModule());
jest.mock('../../src/services/llm/ImageGenerationService', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').imageServiceModule());
jest.mock('../../src/agents/ingestManager/tools/services/IngestCapabilityService', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').ingestCapabilityModule());

import { createFakeRoot, FakeElement } from '../mocks/obsidian/dom';
import { ChatSettingsRenderer } from '../../src/components/shared/ChatSettingsRenderer';
import { DefaultsTab } from '../../src/settings/tabs/DefaultsTab';
import { FoldStateStore } from '../../src/components/shared/settings/FoldStateStore';
import { COPY, FOLD_TITLES, VOICE_COPY } from '../../src/components/shared/chatSettings/copy';
import type { LLMProviderSettings } from '../../src/types/llm/ProviderTypes';
import { chatSettings, llmSettings } from '../helpers/settingsRendererFixtures';
import { choose, control, findRow, flush, foldItems, foldSummary, localStorageApp, rowDesc, rowNames, rowsOf, topItems } from '../helpers/settingsDom';

const SHARED_VOICE_ROWS = [
  VOICE_COPY.transcription, COPY.provider, COPY.model,
  VOICE_COPY.readAloud, COPY.provider, COPY.model, VOICE_COPY.voice,
  VOICE_COPY.liveVoice, COPY.provider, COPY.model, VOICE_COPY.output
];

function voiceLlmSettings(overrides: Partial<LLMProviderSettings> = {}): LLMProviderSettings {
  const base = llmSettings(overrides);
  base.providers = { ...base.providers, openai: { enabled: true, apiKey: 'test' } };
  return base;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flush();
}

async function renderChatVoice(llm = voiceLlmSettings()) {
  const container = createFakeRoot();
  const app = localStorageApp();
  const renderer = new ChatSettingsRenderer(container as unknown as HTMLElement, {
    app: app as never,
    surface: 'chat',
    foldStore: new FoldStateStore(app),
    llmProviderSettings: llm,
    initialSettings: chatSettings(),
    options: { workspaces: [], prompts: [] },
    callbacks: { onSettingsChange: jest.fn() }
  });
  renderer.render();
  await settle();
  return { container, renderer, items: foldItems(container, FOLD_TITLES.voice) };
}

async function renderDefaultsVoice(llm = voiceLlmSettings()) {
  const container = createFakeRoot();
  const saveSettings = jest.fn(async () => undefined);
  const pluginSettings = { enableIngestion: true, enableEmbeddings: true } as Record<string, unknown>;
  const tab = new DefaultsTab(container as unknown as HTMLElement, {
    app: localStorageApp() as never,
    settings: { settings: pluginSettings, saveSettings } as never,
    llmProviderSettings: llm
  });
  await settle();
  const root = container.children[0];
  return { tab, root, llm, saveSettings, pluginSettings, items: foldItems(root, FOLD_TITLES.voice) };
}

/** The rows of one Voice subsection, between its subhead and the next. */
function section(items: FakeElement, subhead: string): FakeElement[] {
  const rows = rowsOf(items);
  const start = rows.findIndex(row => row.hasClass('nexus-subhead') && row.textContent === subhead);
  const rest = rows.slice(start + 1);
  const end = rest.findIndex(row => row.hasClass('nexus-subhead'));
  return end < 0 ? rest : rest.slice(0, end);
}

it('renders the same voice rows on both surfaces, plus the saved audio folder on Defaults', async () => {
  const chat = await renderChatVoice();
  const defaults = await renderDefaultsVoice();
  try {
    expect(rowNames(chat.items)).toEqual(SHARED_VOICE_ROWS);
    const expectedDefaults = [...SHARED_VOICE_ROWS];
    expectedDefaults.splice(expectedDefaults.indexOf(VOICE_COPY.voice) + 1, 0, VOICE_COPY.savedAudioFolder);
    expect(rowNames(defaults.items)).toEqual(expectedDefaults);
    expect(rowDesc(section(defaults.items, VOICE_COPY.readAloud)[3])).toBe(VOICE_COPY.savedAudioFolderDesc);
    expect(rowDesc(section(chat.items, VOICE_COPY.transcription)[0])).toBe(VOICE_COPY.transcriptionProviderDesc);
    expect(chat.items.querySelectorAll('.nexus-subhead')).toHaveLength(3);
  } finally {
    chat.renderer.destroy();
    defaults.tab.destroy();
  }
});

it('summarises the transcription and read-aloud picks', async () => {
  const { container, renderer } = await renderChatVoice();
  try {
    expect(foldSummary(container, FOLD_TITLES.voice)).toMatch(/^Deepgram Nova-3 · .+/);
  } finally {
    renderer.destroy();
  }
});

it('opening Defaults saves nothing, and an automatic read-aloud pick stays automatic', async () => {
  const { tab, llm, saveSettings } = await renderDefaultsVoice();
  try {
    expect(saveSettings).not.toHaveBeenCalled();
    expect(llm.defaultSpeechModel).toBeUndefined();
  } finally {
    tab.destroy();
  }
});

it('saving an unrelated default keeps the automatic read-aloud pick automatic', async () => {
  const { tab, root, llm, saveSettings } = await renderDefaultsVoice();
  try {
    choose(control(findRow(topItems(root), COPY.thinking), 'select'), 'low');
    await settle();
    expect(saveSettings).toHaveBeenCalled();
    expect(llm.defaultThinking).toEqual({ enabled: true, effort: 'low' });
    expect(llm.defaultSpeechModel).toBeUndefined();
    expect(llm.defaultRealtimeVoiceModel).toBeUndefined();
  } finally {
    tab.destroy();
  }
});

it('a manual read-aloud pick on Defaults is saved through the queue with source user', async () => {
  const { tab, llm, saveSettings, items } = await renderDefaultsVoice();
  try {
    const [provider, , voice] = section(items, VOICE_COPY.readAloud);
    expect(control(provider, 'select').value).toBe('openai');
    choose(control(voice, 'select'), 'alloy');
    await settle();
    expect(saveSettings).toHaveBeenCalled();
    expect(llm.defaultSpeechModel).toEqual({
      provider: 'openai',
      model: expect.any(String),
      voice: 'alloy',
      source: 'user'
    });
  } finally {
    tab.destroy();
  }
});

it('explains a saved read-aloud pick that no longer resolves on its Provider row', async () => {
  const llm = voiceLlmSettings({ defaultSpeechModel: { provider: 'google', model: 'gemini-tts', source: 'user' } });
  const { tab, items } = await renderDefaultsVoice(llm);
  try {
    expect(rowDesc(section(items, VOICE_COPY.readAloud)[0])).toContain('is not enabled and configured');
    expect(items.querySelector('.nexus-voice-warning')).toBeNull();
  } finally {
    tab.destroy();
  }
});

it('says so when no provider offers live voice', async () => {
  const llm = llmSettings();
  const { renderer, items } = await renderChatVoice(llm);
  try {
    const [provider, model, output] = section(items, VOICE_COPY.liveVoice);
    expect(rowDesc(provider)).toBe(VOICE_COPY.noLiveVoice);
    for (const row of [provider, model, output]) {
      expect(row.hasClass('is-disabled')).toBe(true);
      expect(control(row, 'select').disabled).toBe(true);
    }
  } finally {
    renderer.destroy();
  }
});
