/**
 * The chat Context window slider keeps one budget per provider/model, shows its
 * value once, and only commits on release.
 *
 * Failures this buys: a budget set for one model leaking into another (the
 * overrides are keyed by provider and model), a readout that showed the value
 * twice ("1,000,000 tokens 1000000"), and drags that saved on every pixel.
 * Real renderer and slider readout over the FakeElement tree; model lists from
 * fixtures.
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
import { COPY, FOLD_TITLES } from '../../src/components/shared/chatSettings/copy';
import { getContextWindowOverrideKey, resolveContextWindowLimit } from '../../src/ui/chat/utils/ContextWindowSettings';
import { chatSettings, llmSettings } from '../helpers/settingsRendererFixtures';
import { choose, control, findRow, flush, foldItems, foldSummary, localStorageApp, topItems } from '../helpers/settingsDom';

async function setup() {
  const container = createFakeRoot();
  const app = localStorageApp();
  const onSettingsChange = jest.fn();
  const renderer = new ChatSettingsRenderer(container as unknown as HTMLElement, {
    app: app as never,
    surface: 'defaults',
    foldStore: new FoldStateStore(app),
    llmProviderSettings: llmSettings(),
    initialSettings: chatSettings({ model: 'claude-opus-4-6', contextWindowOverrides: {} }),
    options: { workspaces: [], prompts: [] },
    callbacks: { onSettingsChange }
  });
  renderer.render();
  await flush();
  const slider = () => control(findRow(foldItems(container, FOLD_TITLES.chatOptions), COPY.contextWindow), 'input.slider');
  const readouts = () => findRow(foldItems(container, FOLD_TITLES.chatOptions), COPY.contextWindow)
    .querySelectorAll('.slider-value').map(el => el.textContent);
  return { container, renderer, onSettingsChange, slider, readouts };
}

function release(input: FakeElement, value: number): void {
  input.value = String(value);
  input.dispatch('input');
  input.dispatch('change');
}

it('keeps separate limits for two models and restores each slider value', async () => {
  const { container, renderer, slider, readouts } = await setup();
  try {
    expect(slider().value).toBe('200000');
    release(slider(), 64_000);
    expect(readouts()).toEqual(['64K']);

    choose(control(findRow(topItems(container), COPY.model), 'select'), 'anthropic::claude-haiku-5-5');
    await flush();
    expect(slider().value).toBe('1000000');
    release(slider(), 500_000);

    choose(control(findRow(topItems(container), COPY.model), 'select'), 'anthropic::claude-opus-4-6');
    await flush();
    expect(slider().value).toBe('64000');
    expect(readouts()).toEqual(['64K']);
    expect(foldSummary(container, FOLD_TITLES.chatOptions)).toBe('Creativity 0.5 · 64K context');

    expect(renderer.getSettings().contextWindowOverrides).toEqual({
      [getContextWindowOverrideKey('anthropic', 'claude-opus-4-6')]: 64_000,
      [getContextWindowOverrideKey('anthropic', 'claude-haiku-5-5')]: 500_000
    });
  } finally {
    renderer.destroy();
  }
});

it('stores the model maximum as no override', async () => {
  const { renderer, slider } = await setup();
  try {
    release(slider(), 64_000);
    release(slider(), 200_000);
    expect(renderer.getSettings().contextWindowOverrides).toEqual({});
  } finally {
    renderer.destroy();
  }
});

it('updates the single readout while dragging, before change commits', async () => {
  const { renderer, slider, readouts, onSettingsChange } = await setup();
  try {
    const input = slider();
    input.value = '128000';
    input.dispatch('input');
    expect(readouts()).toEqual(['128K']);
    expect(input.getAttribute('aria-valuetext')).toBe('128K tokens');
    expect(onSettingsChange).not.toHaveBeenCalled();
  } finally {
    renderer.destroy();
  }
});

it('clamps stale saved limits to the advertised model maximum', () => {
  expect(resolveContextWindowLimit(128_000, 1_050_000)).toBe(128_000);
  expect(resolveContextWindowLimit(128_000, Number.NaN)).toBe(128_000);
  expect(resolveContextWindowLimit(128_000, 512)).toBe(1024);
  expect(resolveContextWindowLimit(768, 512)).toBe(768);
});
