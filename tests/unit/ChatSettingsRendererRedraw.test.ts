/**
 * Redraws refill only the group that changed; folds and scroll survive.
 *
 * Failures this buys: render() used to empty the whole container on every
 * provider, model, image provider or workspace change and on every synced
 * settings update, so an open fold snapped shut, the page jumped to the top,
 * and anything appended after render() vanished. Real renderer, real
 * Accordion, real LLMSettingsNotifier; model lists come from fixtures.
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
import { FoldStateStore } from '../../src/components/shared/settings/FoldStateStore';
import { LLMSettingsNotifier } from '../../src/services/llm/LLMSettingsNotifier';
import { COPY, FOLD_TITLES } from '../../src/components/shared/chatSettings/copy';
import { chatSettings, llmSettings } from '../helpers/settingsRendererFixtures';
import {
  accordions,
  choose,
  control,
  findRow,
  flush,
  fold,
  foldItems,
  foldSummary,
  foldToggle,
  isFoldOpen,
  localStorageApp,
  rowNames,
  rowsOf,
  topItems
} from '../helpers/settingsDom';

const WORKSPACES = [
  { id: 'ws-1', name: 'On Networks', context: { workflows: [{ id: 'wf-1', name: 'Episode prep' }] } },
  { id: 'ws-2', name: 'Personal Operations' }
];

async function setup(surface: 'chat' | 'defaults' = 'chat', app = localStorageApp()) {
  // A scrolling parent, like the settings pane or the modal content.
  const scroller = createFakeRoot();
  scroller.addClass('vertical-tab-content');
  const container = scroller.createDiv();
  const onSettingsChange = jest.fn();
  const renderer = new ChatSettingsRenderer(container as unknown as HTMLElement, {
    app: app as never,
    surface,
    foldStore: new FoldStateStore(app),
    llmProviderSettings: llmSettings(),
    initialSettings: chatSettings(),
    options: { workspaces: WORKSPACES, prompts: [{ id: 'p1', name: 'meditations-on-alignment' }] },
    callbacks: { onSettingsChange }
  });
  renderer.render();
  await flush();
  return { scroller, container, renderer, onSettingsChange, app };
}

function snapshotRows(container: FakeElement, title: string): FakeElement[] {
  return rowsOf(foldItems(container, title));
}

it('changing the chat provider and model keeps an open Context fold open and untouched', async () => {
  const { container, renderer } = await setup();
  try {
    foldToggle(container, FOLD_TITLES.context).click();
    const contextFold = fold(container, FOLD_TITLES.context);
    const contextRows = snapshotRows(container, FOLD_TITLES.context);
    const optionsRows = snapshotRows(container, FOLD_TITLES.chatOptions);

    choose(control(findRow(topItems(container), COPY.provider), 'select'), 'mistral');
    await flush();

    expect(isFoldOpen(container, FOLD_TITLES.context)).toBe(true);
    expect(fold(container, FOLD_TITLES.context)).toBe(contextFold);
    expect(snapshotRows(container, FOLD_TITLES.context)).toEqual(contextRows);
    // The chat model's own groups did redraw: no Thinking for Mistral Large, a 128K window.
    expect(rowNames(topItems(container))).toEqual([COPY.provider, COPY.model]);
    expect(snapshotRows(container, FOLD_TITLES.chatOptions)[0]).not.toBe(optionsRows[0]);
    expect(foldSummary(container, FOLD_TITLES.chatOptions)).toBe('Creativity 0.5 · 128K context · Web search off');
    expect(renderer.getSettings()).toEqual(expect.objectContaining({ provider: 'mistral', model: 'mistral-large-latest' }));
  } finally {
    renderer.destroy();
  }
});

it('changing the workspace rebuilds only Context', async () => {
  const { container, renderer } = await setup();
  try {
    const before = new Map(accordions(container).map(item => [item, rowsOf(item.querySelector('.setting-items') as FakeElement)]));
    const topBefore = rowsOf(topItems(container));

    choose(control(findRow(foldItems(container, FOLD_TITLES.context), COPY.workspace), 'select'), 'ws-1');
    await flush();

    for (const [accordion, rows] of before) {
      const title = accordion.querySelector('.nexus-accordion-title')?.textContent;
      const now = rowsOf(accordion.querySelector('.setting-items') as FakeElement);
      if (title === FOLD_TITLES.context) expect(now[0]).not.toBe(rows[0]);
      else expect(now).toEqual(rows);
    }
    expect(rowsOf(topItems(container))).toEqual(topBefore);
    // The new workspace's workflows are offered.
    const workflow = control(findRow(foldItems(container, FOLD_TITLES.context), COPY.workflow), 'select');
    expect(workflow.children.map(option => option.textContent)).toEqual(['None', 'Episode prep']);
    expect(foldSummary(container, FOLD_TITLES.context)).toBe('On Networks · No prompt · 0 notes');
  } finally {
    renderer.destroy();
  }
});

it('a synced settings update refills the groups but keeps the shell, open folds and scroll', async () => {
  const { scroller, container, renderer } = await setup();
  try {
    foldToggle(container, FOLD_TITLES.voice).click();
    const shell = [...container.children];
    const voiceRows = snapshotRows(container, FOLD_TITLES.voice);
    scroller.scrollTop = 640;
    // Emptying a list shortens the page; a real browser clamps scrollTop then.
    const items = foldItems(container, FOLD_TITLES.voice);
    const empty = items.empty.bind(items);
    items.empty = () => { empty(); scroller.scrollTop = 0; };

    LLMSettingsNotifier.notify(llmSettings());
    await flush();

    expect(container.children).toEqual(shell);
    expect(isFoldOpen(container, FOLD_TITLES.voice)).toBe(true);
    expect(snapshotRows(container, FOLD_TITLES.voice)[0]).not.toBe(voiceRows[0]);
    expect(scroller.scrollTop).toBe(640);
  } finally {
    renderer.destroy();
  }
});

it('remembers open folds per surface across renderer instances', async () => {
  const app = localStorageApp();
  const first = await setup('chat', app);
  foldToggle(first.container, FOLD_TITLES.images).click();
  first.renderer.destroy();

  const second = await setup('chat', app);
  const otherSurface = await setup('defaults', app);
  try {
    expect(isFoldOpen(second.container, FOLD_TITLES.images)).toBe(true);
    expect(isFoldOpen(second.container, FOLD_TITLES.context)).toBe(false);
    expect(isFoldOpen(otherSurface.container, FOLD_TITLES.images)).toBe(false);
  } finally {
    second.renderer.destroy();
    otherSurface.renderer.destroy();
  }
});

it('changing the subagent model redraws Subagents only', async () => {
  const { container, renderer } = await setup();
  try {
    const topRows = rowsOf(topItems(container));
    choose(control(findRow(foldItems(container, FOLD_TITLES.subagents), COPY.model), 'select'), 'anthropic::claude-opus-4-6');
    await flush();
    expect(rowsOf(topItems(container))).toEqual(topRows);
    expect(foldSummary(container, FOLD_TITLES.subagents)).toBe('Claude Opus 4.6 · Thinking off');
  } finally {
    renderer.destroy();
  }
});

it('stops listening to synced settings after destroy', async () => {
  const { container, renderer } = await setup();
  const rows = rowsOf(topItems(container));
  renderer.destroy();
  LLMSettingsNotifier.notify(llmSettings());
  await flush();
  expect(rowsOf(topItems(container))).toEqual(rows);
});
