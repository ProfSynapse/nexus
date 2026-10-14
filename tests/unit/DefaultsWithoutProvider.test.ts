/**
 * Defaults on a fresh install, before any provider is set up.
 *
 * Failures this buys: the stored settings still carry the shipped default
 * chat model (`DEFAULT_LLM_PROVIDER_SETTINGS.defaultModel`, an OpenAI model)
 * and default image model, although no provider can serve them. The tab used
 * to describe them anyway: Chat options read "Fixed temperature · 1.05M
 * context", Subagents named the OpenAI default model with "Thinking off",
 * a Thinking dropdown showed "Off", and Images showed the raw id
 * "gemini-3.1-flash-image".
 *
 * Real: DefaultsTab, the renderer, the model registry (StaticModelsService)
 * and the image service, which has no adapter without a key. Mocked: the
 * provider model lists (the fixture lists nothing for OpenAI, as a provider
 * with no key does) and the ingest capability lookup (never answers, so the
 * Voice summary is read before any model list has loaded).
 */
jest.mock('../../src/services/llm/providers/ProviderManager', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').providerManagerModule());
jest.mock('../../src/agents/ingestManager/tools/services/IngestCapabilityService', () => ({
  ...jest.requireActual('../../src/agents/ingestManager/tools/services/IngestCapabilityService'),
  getIngestCapabilityOptions: jest.fn(() => new Promise(() => undefined))
}));

import { createFakeRoot } from '../mocks/obsidian/dom';
import { DefaultsTab } from '../../src/settings/tabs/DefaultsTab';
import { COPY, FOLD_TITLES } from '../../src/components/shared/chatSettings/copy';
import { DEFAULT_LLM_PROVIDER_SETTINGS, type LLMProviderSettings } from '../../src/types/llm/ProviderTypes';
import { StaticModelsService } from '../../src/services/StaticModelsService';
import { getImageModelDisplayName } from '../../src/services/llm/imageModelNames';
import {
  control,
  findRow,
  flush,
  foldItems,
  foldSummary,
  localStorageApp,
  optionLabels,
  rowDesc,
  rowNames,
  topItems
} from '../helpers/settingsDom';

function freshInstall(overrides: Partial<LLMProviderSettings> = {}): LLMProviderSettings {
  return { ...JSON.parse(JSON.stringify(DEFAULT_LLM_PROVIDER_SETTINGS)) as LLMProviderSettings, ...overrides };
}

async function renderDefaults(llmProviderSettings: LLMProviderSettings) {
  const container = createFakeRoot();
  const tab = new DefaultsTab(container as unknown as HTMLElement, {
    app: localStorageApp() as never,
    settings: { settings: { enableIngestion: true, enableEmbeddings: true, storage: undefined }, saveSettings: jest.fn(async () => undefined) } as never,
    llmProviderSettings
  });
  for (let i = 0; i < 4; i++) await flush();
  return { tab, root: container.children[0] };
}

const shipped = DEFAULT_LLM_PROVIDER_SETTINGS.defaultModel;
const shippedName = StaticModelsService.getInstance().findModel(shipped.provider, shipped.model)?.name;

it('the shipped default chat model is one the registry describes, so the old summaries could name it', () => {
  // Guards the premise: if the registry stops knowing it, the tests below go vacuous.
  const spec = StaticModelsService.getInstance().findModel(shipped.provider, shipped.model);
  expect(spec?.name).toBeTruthy();
  expect(spec?.contextWindow).toBeGreaterThan(0);
  expect(spec?.capabilities.supportsThinking).toBe(true);
});

describe('Defaults with no provider set up', () => {
  it('shows no Thinking row for a model nobody can use', async () => {
    const h = await renderDefaults(freshInstall());
    try {
      expect(rowNames(topItems(h.root))).toEqual([COPY.provider, COPY.model]);
    } finally {
      h.tab.destroy();
    }
  });

  it('says to pick a model in Chat options instead of inventing its capabilities', async () => {
    const h = await renderDefaults(freshInstall());
    try {
      expect(foldSummary(h.root, FOLD_TITLES.chatOptions)).toBe(COPY.pickModelFirst);
      const items = foldItems(h.root, FOLD_TITLES.chatOptions);
      expect(rowNames(items)).toEqual([COPY.creativity, COPY.contextWindow]);
      for (const name of [COPY.creativity, COPY.contextWindow]) {
        const row = findRow(items, name);
        expect(rowDesc(row)).toBe(COPY.noModelTuningDesc);
        expect(control(row, 'input.slider').disabled).toBe(true);
        expect(row.querySelectorAll('.slider-value').map(el => el.textContent)).toEqual([COPY.noValueReadout]);
      }
    } finally {
      h.tab.destroy();
    }
  });

  it('does not name a model for subagents when nothing could run them', async () => {
    const h = await renderDefaults(freshInstall());
    try {
      const summary = foldSummary(h.root, FOLD_TITLES.subagents);
      expect(summary).toBe(COPY.noModel);
      expect(summary).not.toContain(shippedName);
      const items = foldItems(h.root, FOLD_TITLES.subagents);
      expect(rowNames(items)).not.toContain(COPY.thinking);
      expect(control(findRow(items, COPY.creativity), 'input.slider').disabled).toBe(true);
    } finally {
      h.tab.destroy();
    }
  });

  it('does not name the default image model when no image provider is set up', async () => {
    const h = await renderDefaults(freshInstall());
    try {
      const { provider, model } = DEFAULT_LLM_PROVIDER_SETTINGS.defaultImageModel!;
      const name = getImageModelDisplayName(provider, model);
      // The premise: the catalog can name it without a key, which is how the
      // summary used to show it.
      expect(name).toBeTruthy();
      // Pre-fix: the summary was that name while Model said "No models available".
      expect(foldSummary(h.root, FOLD_TITLES.images)).toBe(COPY.noImageProvider);
      expect(optionLabels(control(findRow(foldItems(h.root, FOLD_TITLES.images), COPY.model), 'select')))
        .toEqual(['No models available']);
    } finally {
      h.tab.destroy();
    }
  });

  it('says "Not set" when another image provider is set up but the selected one is not', async () => {
    const settings = freshInstall();
    settings.providers.openai = { ...settings.providers.openai, enabled: true, apiKey: 'sk-test' };
    const h = await renderDefaults(settings);
    try {
      expect(DEFAULT_LLM_PROVIDER_SETTINGS.defaultImageModel!.provider).not.toBe('openai');
      expect(foldSummary(h.root, FOLD_TITLES.images)).toBe(COPY.notSet);
    } finally {
      h.tab.destroy();
    }
  });

  it('names the default image model, not its id, once its provider is set up', async () => {
    const { provider, model } = DEFAULT_LLM_PROVIDER_SETTINGS.defaultImageModel!;
    const settings = freshInstall();
    settings.providers[provider] = { ...settings.providers[provider], enabled: true, apiKey: 'test-key' };
    const h = await renderDefaults(settings);
    try {
      const name = getImageModelDisplayName(provider, model);
      expect(name).not.toBe(model);
      expect(foldSummary(h.root, FOLD_TITLES.images)).toBe(name);
    } finally {
      h.tab.destroy();
    }
  });

  it('does not name a video model when no video provider is set up', async () => {
    const h = await renderDefaults(freshInstall());
    try {
      expect(foldSummary(h.root, FOLD_TITLES.video)).toBe(COPY.noVideoProvider);
    } finally {
      h.tab.destroy();
    }
  });

  it('says "Not set" for a saved video provider whose key was removed', async () => {
    const settings = freshInstall();
    const saved = DEFAULT_LLM_PROVIDER_SETTINGS.defaultVideoModel!;
    const other = saved.provider === 'google' ? 'openrouter' : 'google';
    settings.providers[other] = { ...settings.providers[other], enabled: true, apiKey: 'test-key' };
    const h = await renderDefaults(settings);
    try {
      // Pre-fix: "<model> · 16:9 · 720p" while Provider read "(unavailable)".
      expect(foldSummary(h.root, FOLD_TITLES.video)).toBe(COPY.notSet);
    } finally {
      h.tab.destroy();
    }
  });

  it('names a saved transcription model before its provider list has loaded', async () => {
    const h = await renderDefaults(freshInstall({ defaultTranscriptionModel: { provider: 'deepgram', model: 'nova-3' } }));
    try {
      expect(foldSummary(h.root, FOLD_TITLES.voice)).toBe('Nova-3');
    } finally {
      h.tab.destroy();
    }
  });

  it('keeps the saved chat model, so it applies once its provider is set up', async () => {
    const settings = freshInstall();
    const h = await renderDefaults(settings);
    try {
      expect(settings.defaultModel).toEqual(shipped);
      // The Model row keeps saying why it is empty.
      expect(optionLabels(control(findRow(topItems(h.root), COPY.model), 'select'))).toEqual(['No models available']);
    } finally {
      h.tab.destroy();
    }
  });
});

describe('image model names', () => {
  it('falls back to nothing for an unknown provider or model', () => {
    expect(getImageModelDisplayName('google', 'not-a-model')).toBeUndefined();
    expect(getImageModelDisplayName('nope', 'gemini-3.1-flash-image')).toBeUndefined();
    expect(getImageModelDisplayName('google', 'toString')).toBeUndefined();
    expect(getImageModelDisplayName(undefined, undefined)).toBeUndefined();
  });
});
