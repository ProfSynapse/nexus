/**
 * Defaults and Chat settings render the "Essentials + folds" layout.
 *
 * Failures this buys: the old renderer drew stacked "Chat model / Subagent
 * model / Image model / Temperature / Context" boxes under an intro line, with
 * a Reasoning toggle plus Effort slider and two voice implementations with
 * different labels. Here the real ChatSettingsRenderer and DefaultsTab render
 * into a FakeElement tree, and the assertions read the markup: group order,
 * icons, row names, chat-only rows and summaries.
 *
 * Mocked: model lists, image and ingest model lists (fixtures). Real: the
 * renderer, DefaultsTab, Accordion, VoiceSettings, the Video, File conversion
 * and Semantic search folds, and LLMSettingsNotifier.
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
import { COPY, FOLD_TITLES } from '../../src/components/shared/chatSettings/copy';
import { chatSettings, llmSettings } from '../helpers/settingsRendererFixtures';
import {
  accordions,
  control,
  findRow,
  flush,
  foldItems,
  foldSummary,
  foldTitles,
  localStorageApp,
  optionLabels,
  rowDesc,
  rowNames,
  topItems
} from '../helpers/settingsDom';

const SHARED = [FOLD_TITLES.chatOptions, FOLD_TITLES.context, FOLD_TITLES.subagents, FOLD_TITLES.images];

async function renderChat(overrides: Parameters<typeof chatSettings>[0] = {}, options = { workspaces: [] as never[], prompts: [] as never[] }) {
  const container = createFakeRoot();
  const app = localStorageApp();
  const renderer = new ChatSettingsRenderer(container as unknown as HTMLElement, {
    app: app as never,
    surface: 'chat',
    foldStore: new FoldStateStore(app),
    llmProviderSettings: llmSettings(),
    initialSettings: chatSettings(overrides),
    options,
    callbacks: { onSettingsChange: jest.fn() }
  });
  renderer.render();
  await flush();
  return { container, renderer };
}

async function renderDefaults(llmOverrides: Parameters<typeof llmSettings>[0] = {}) {
  const container = createFakeRoot();
  const saveSettings = jest.fn(async () => undefined);
  const tab = new DefaultsTab(container as unknown as HTMLElement, {
    app: localStorageApp() as never,
    settings: { settings: { enableIngestion: true, enableEmbeddings: true, storage: undefined }, saveSettings } as never,
    llmProviderSettings: llmSettings({ defaultThinking: { enabled: true, effort: 'high' }, ...llmOverrides })
  });
  await flush();
  await flush();
  const root = container.children[0];
  return { tab, container, root, saveSettings };
}

describe('Defaults tab', () => {
  it('shows no heading or intro, then the top block and every fold in order', async () => {
    const { tab, container, root } = await renderDefaults();
    try {
      expect(container.querySelector('h2')).toBeNull();
      expect(container.textContent).not.toContain('These settings are used when starting a new chat.');
      expect(root.children[0].hasClass('setting-group')).toBe(true);
      expect(foldTitles(root)).toEqual([
        ...SHARED, FOLD_TITLES.video, FOLD_TITLES.voice, FOLD_TITLES.fileConversion, FOLD_TITLES.semanticSearch
      ]);
      expect(accordions(root).map(fold => fold.querySelector('.nexus-accordion-icon')?.getAttribute('data-icon'))).toEqual([
        'sliders-horizontal', 'layers', 'bot', 'image', 'film', 'mic', 'file-input', 'scan-search'
      ]);
    } finally {
      tab.destroy();
    }
  });

  it('holds Provider, Model and Thinking in the top block', async () => {
    const { tab, root } = await renderDefaults();
    try {
      expect(rowNames(topItems(root))).toEqual([COPY.provider, COPY.model, COPY.thinking]);
      expect(optionLabels(control(findRow(topItems(root), COPY.thinking), 'select')))
        .toEqual(['Off', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
      expect(control(findRow(topItems(root), COPY.thinking), 'select').value).toBe('high');
    } finally {
      tab.destroy();
    }
  });

  it('starts with every fold collapsed and summarised', async () => {
    const { tab, root } = await renderDefaults();
    try {
      for (const fold of accordions(root)) {
        expect(fold.hasClass('is-open')).toBe(false);
        expect(fold.querySelector('.nexus-accordion-content')?.hidden).toBe(true);
        expect(fold.querySelector('.nexus-accordion-summary')?.textContent).not.toBe('');
      }
      // Claude Opus 5.5 rejects temperature.
      expect(foldSummary(root, FOLD_TITLES.chatOptions)).toBe('Fixed temperature · 1M context');
      expect(foldSummary(root, FOLD_TITLES.context)).toBe('No workspace · No prompt · 0 notes');
      expect(foldSummary(root, FOLD_TITLES.images)).toBe('Gemini 3.1 Flash Image');
      expect(foldSummary(root, FOLD_TITLES.fileConversion)).toBe('File import on · Text extraction');
      expect(foldSummary(root, FOLD_TITLES.semanticSearch)).toBe('On');
    } finally {
      tab.destroy();
    }
  });

  it('leaves Web search and Workflow out of Defaults', async () => {
    const { tab, root } = await renderDefaults();
    try {
      expect(rowNames(foldItems(root, FOLD_TITLES.chatOptions))).toEqual([COPY.creativity, COPY.contextWindow]);
      expect(rowNames(foldItems(root, FOLD_TITLES.context))).toEqual([COPY.workspace, COPY.prompt, COPY.contextNotes]);
    } finally {
      tab.destroy();
    }
  });

  it('describes Creativity and Context window with the new copy, each value shown once', async () => {
    const { tab, root } = await renderDefaults({ defaultModel: { provider: 'anthropic', model: 'claude-opus-4-6' } });
    try {
      const options = foldItems(root, FOLD_TITLES.chatOptions);
      expect(rowDesc(findRow(options, COPY.creativity))).toBe(COPY.creativityDesc);
      expect(rowDesc(findRow(options, COPY.contextWindow))).toBe(COPY.contextWindowDesc);
      expect(findRow(options, COPY.creativity).querySelectorAll('.slider-value').map(el => el.textContent)).toEqual(['0.5']);
      expect(findRow(options, COPY.contextWindow).querySelectorAll('.slider-value').map(el => el.textContent)).toEqual(['200K']);
    } finally {
      tab.destroy();
    }
  });

  it('opens Subagents with the Used for note and the subagent model and tuning rows', async () => {
    const { tab, root } = await renderDefaults({ agentModel: { provider: 'anthropic', model: 'claude-haiku-5-5' } });
    try {
      const items = foldItems(root, FOLD_TITLES.subagents);
      expect(rowNames(items)).toEqual([
        COPY.usedFor, COPY.provider, COPY.model, COPY.thinking, COPY.creativity, COPY.contextWindow
      ]);
      expect(rowDesc(findRow(items, COPY.usedFor))).toBe(COPY.usedForDesc);
      expect(foldSummary(root, FOLD_TITLES.subagents)).toBe('Claude Haiku 5.5 · Thinking off · Fixed temperature · 1M context');
    } finally {
      tab.destroy();
    }
  });

  it('puts the Video rows in their fold', async () => {
    const { tab, root } = await renderDefaults();
    try {
      expect(rowNames(foldItems(root, FOLD_TITLES.video))).toEqual([COPY.provider, COPY.model, 'Aspect ratio', 'Resolution']);
    } finally {
      tab.destroy();
    }
  });
});

describe('Chat settings', () => {
  it('omits the Defaults-only folds', async () => {
    const { container, renderer } = await renderChat();
    try {
      expect(foldTitles(container)).toEqual([...SHARED, FOLD_TITLES.voice]);
    } finally {
      renderer.destroy();
    }
  });

  it('adds Web search to Chat options and Workflow to Context', async () => {
    const { container, renderer } = await renderChat({ webSearch: true });
    try {
      const options = foldItems(container, FOLD_TITLES.chatOptions);
      expect(rowNames(options)).toEqual([COPY.creativity, COPY.contextWindow, COPY.webSearch]);
      expect(rowDesc(findRow(options, COPY.webSearch))).toBe(COPY.webSearchDesc);
      expect(rowNames(foldItems(container, FOLD_TITLES.context))).toEqual([COPY.workspace, COPY.workflow, COPY.prompt, COPY.contextNotes]);
      expect(rowDesc(findRow(foldItems(container, FOLD_TITLES.context), COPY.workflow))).toBe(COPY.workflowDesc);
      expect(foldSummary(container, FOLD_TITLES.chatOptions)).toBe('Fixed temperature · 1M context · Web search on');
    } finally {
      renderer.destroy();
    }
  });

  it('leaves Web search out of the summary when the provider offers no toggle for it', async () => {
    const { container, renderer } = await renderChat({ provider: 'mistral', model: 'mistral-large-latest', webSearch: false });
    try {
      expect(rowNames(foldItems(container, FOLD_TITLES.chatOptions))).not.toContain(COPY.webSearch);
      expect(foldSummary(container, FOLD_TITLES.chatOptions)).not.toContain('Web search');
    } finally {
      renderer.destroy();
    }
  });

  it('hides Thinking for a model that cannot reason and keeps the stored level', async () => {
    const { container, renderer } = await renderChat({ provider: 'mistral', model: 'mistral-large-latest' });
    try {
      expect(rowNames(topItems(container))).toEqual([COPY.provider, COPY.model]);
      expect(renderer.getSettings().thinking).toEqual({ enabled: true, effort: 'high' });
    } finally {
      renderer.destroy();
    }
  });

  it('Off keeps the stored effort, and choosing a level turns thinking on', async () => {
    const onSettingsChange = jest.fn();
    const { container, renderer } = await renderChat();
    (renderer as unknown as { config: { callbacks: { onSettingsChange: jest.Mock } } }).config.callbacks.onSettingsChange = onSettingsChange;
    try {
      const select = control(findRow(topItems(container), COPY.thinking), 'select');
      select.value = 'off';
      select.dispatch('change');
      expect(renderer.getSettings().thinking).toEqual({ enabled: false, effort: 'high' });
      select.value = 'max';
      select.dispatch('change');
      expect(renderer.getSettings().thinking).toEqual({ enabled: true, effort: 'max' });
      expect(onSettingsChange).toHaveBeenCalledTimes(2);
    } finally {
      renderer.destroy();
    }
  });

  it('shows each context note as a row with a remove button', async () => {
    const { container, renderer } = await renderChat({ contextNotes: ['Projects/Vault Map of Content.md', 'AGENTS.md'] });
    try {
      const items = foldItems(container, FOLD_TITLES.context);
      expect(rowNames(items)).toEqual([COPY.workspace, COPY.workflow, COPY.prompt, COPY.contextNotes, 'Vault Map of Content', 'AGENTS']);
      expect(control(findRow(items, COPY.contextNotes), 'button').textContent).toBe(COPY.addNote);
      const remove = control(findRow(items, 'AGENTS'), '.extra-setting-button');
      expect(remove.getAttribute('aria-label')).toBe('Remove AGENTS');
      expect(findRow(items, 'AGENTS').querySelector('.nexus-note-icon')?.getAttribute('data-icon')).toBe('file-text');
      expect(foldSummary(container, FOLD_TITLES.context)).toBe('No workspace · No prompt · 2 notes');

      remove.click();
      expect(renderer.getSettings().contextNotes).toEqual(['Projects/Vault Map of Content.md']);
      expect(rowNames(foldItems(container, FOLD_TITLES.context))).not.toContain('AGENTS');
      expect(foldSummary(container, FOLD_TITLES.context)).toBe('No workspace · No prompt · 1 note');
    } finally {
      renderer.destroy();
    }
  });

  it('explains a text-only provider in the Model row description', async () => {
    const { container, renderer } = await renderChat({ provider: 'perplexity', model: 'sonar' });
    try {
      const model = findRow(topItems(container), COPY.model);
      expect(model.querySelector('.setting-item-description strong')?.textContent).toBe('Perplexity cannot use Nexus tools');
      expect(rowDesc(model)).toContain('Use it for search-heavy, text-only work.');
      expect(container.querySelector('.csr-provider-warning')).toBeNull();
    } finally {
      renderer.destroy();
    }
  });

  it('builds no buttons of its own: every control is an Obsidian component or the accordion toggle', async () => {
    const { container, renderer } = await renderChat({ contextNotes: ['a.md'] });
    try {
      const buttons = container.querySelectorAll('button');
      const custom = buttons.filter(button => !button.hasClass('nexus-accordion-toggle') && button.textContent !== COPY.addNote);
      expect(custom).toEqual([]);
    } finally {
      renderer.destroy();
    }
  });
});

it('the fold list is a direct child list of the renderer container', async () => {
  const { container, renderer } = await renderChat();
  try {
    const kinds = container.children.map(child => child.hasClass('setting-group') ? 'group' : child.hasClass('nexus-accordion') ? 'fold' : child.tagName);
    expect(kinds).toEqual(['group', 'fold', 'fold', 'fold', 'fold', 'fold']);
    expect((container as FakeElement).hasClass('chat-settings-renderer')).toBe(true);
  } finally {
    renderer.destroy();
  }
});
