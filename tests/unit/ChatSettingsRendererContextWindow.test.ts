/**
 * The Context window slider snaps to preset sizes, shows its value once, keeps
 * one budget per provider/model, and only commits on release.
 *
 * Failures this buys: a 1-token slider (the old control), a budget set for one
 * model leaking into another (overrides are keyed by provider and model), a
 * new model inheriting a stale limit instead of starting at its maximum, a
 * saved size between stops being rewritten just by opening settings, a readout
 * that showed the value twice ("1,000,000 tokens 1000000"), and drags that
 * saved on every pixel. Real renderer and slider readout over the FakeElement
 * tree; model lists from fixtures.
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
import { ChatSettingsRenderer, type ChatSettings } from '../../src/components/shared/ChatSettingsRenderer';
import { FoldStateStore } from '../../src/components/shared/settings/FoldStateStore';
import { COPY, FOLD_TITLES } from '../../src/components/shared/chatSettings/copy';
import { getContextWindowOverrideKey, resolveContextWindowLimit } from '../../src/ui/chat/utils/ContextWindowSettings';
import { chatSettings, llmSettings } from '../helpers/settingsRendererFixtures';
import { choose, control, findRow, flush, foldItems, foldSummary, localStorageApp, topItems } from '../helpers/settingsDom';

const opus46 = getContextWindowOverrideKey('anthropic', 'claude-opus-4-6');
const haiku55 = getContextWindowOverrideKey('anthropic', 'claude-haiku-5-5');

async function setup(overrides: Partial<ChatSettings> = {}) {
  const container = createFakeRoot();
  const app = localStorageApp();
  const onSettingsChange = jest.fn();
  const renderer = new ChatSettingsRenderer(container as unknown as HTMLElement, {
    app: app as never,
    surface: 'defaults',
    foldStore: new FoldStateStore(app),
    llmProviderSettings: llmSettings(),
    initialSettings: chatSettings({ model: 'claude-opus-4-6', contextWindowOverrides: {}, ...overrides }),
    options: { workspaces: [], prompts: [] },
    callbacks: { onSettingsChange }
  });
  renderer.render();
  await flush();
  const row = () => findRow(foldItems(container, FOLD_TITLES.chatOptions), COPY.contextWindow);
  const slider = () => control(row(), 'input.slider');
  const readouts = () => row().querySelectorAll('.slider-value').map(el => el.textContent);
  return { container, renderer, onSettingsChange, slider, readouts };
}

function release(input: FakeElement, index: number): void {
  input.value = String(index);
  input.dispatch('input');
  input.dispatch('change');
}

it('snaps to the presets below the model maximum, then the maximum', async () => {
  const { container, renderer, slider, readouts } = await setup();
  try {
    // Claude Opus 4.6: 32K, 64K, 128K, 200K.
    expect(slider().getAttribute('min')).toBe('0');
    expect(slider().getAttribute('max')).toBe('3');
    expect(slider().value).toBe('3');
    expect(readouts()).toEqual(['200K']);

    release(slider(), 1);
    expect(readouts()).toEqual(['64K']);
    expect(renderer.getSettings().contextWindowOverrides).toEqual({ [opus46]: 64_000 });
    expect(foldSummary(container, FOLD_TITLES.chatOptions)).toBe('Creativity 0.5 · 64K context');
  } finally {
    renderer.destroy();
  }
});

it('starts a newly picked model at its maximum and keeps other models\' limits', async () => {
  const { container, renderer, slider, readouts } = await setup({
    contextWindowOverrides: { [opus46]: 64_000, [haiku55]: 350_000 }
  });
  try {
    expect(readouts()).toEqual(['64K']);

    choose(control(findRow(topItems(container), COPY.model), 'select'), 'anthropic::claude-haiku-5-5');
    await flush();
    // Claude Haiku 5.5: seven stops ending at 1M, thumb on the last.
    expect(slider().value).toBe('6');
    expect(readouts()).toEqual(['1M']);
    expect(foldSummary(container, FOLD_TITLES.chatOptions)).toBe('Fixed temperature · 1M context');
    expect(renderer.getSettings().contextWindowOverrides).toEqual({ [opus46]: 64_000 });

    choose(control(findRow(topItems(container), COPY.model), 'select'), 'anthropic::claude-opus-4-6');
    await flush();
    expect(readouts()).toEqual(['200K']);
    expect(renderer.getSettings().contextWindowOverrides).toEqual({});
  } finally {
    renderer.destroy();
  }
});

it('starts at the maximum after a provider change too', async () => {
  const { container, renderer, readouts } = await setup({
    contextWindowOverrides: { [getContextWindowOverrideKey('mistral', 'mistral-large-latest')]: 32_000 }
  });
  try {
    choose(control(findRow(topItems(container), COPY.provider), 'select'), 'mistral');
    await flush();
    await flush();
    expect(readouts()).toEqual(['128K']);
    expect(renderer.getSettings().contextWindowOverrides).toEqual({});
  } finally {
    renderer.destroy();
  }
});

it('stores the model maximum as no override', async () => {
  const { renderer, slider } = await setup();
  try {
    release(slider(), 1);
    release(slider(), 3);
    expect(renderer.getSettings().contextWindowOverrides).toEqual({});
  } finally {
    renderer.destroy();
  }
});

it('updates the single readout while dragging, before change commits', async () => {
  const { renderer, slider, readouts, onSettingsChange } = await setup();
  try {
    const input = slider();
    input.value = '2';
    input.dispatch('input');
    expect(readouts()).toEqual(['128K']);
    expect(input.getAttribute('aria-valuetext')).toBe('128K tokens');
    expect(onSettingsChange).not.toHaveBeenCalled();
  } finally {
    renderer.destroy();
  }
});

it('shows a saved size between stops as saved, with the thumb on the stop below', async () => {
  const { renderer, slider, readouts, onSettingsChange } = await setup({ contextWindowOverrides: { [opus46]: 150_000 } });
  try {
    expect(readouts()).toEqual(['150K']);
    expect(slider().value).toBe('2');
    expect(slider().getAttribute('aria-valuetext')).toBe('150K tokens');
    // Opening settings does not rewrite it.
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(renderer.getSettings().contextWindowOverrides).toEqual({ [opus46]: 150_000 });

    release(slider(), 2);
    expect(readouts()).toEqual(['128K']);
    expect(renderer.getSettings().contextWindowOverrides).toEqual({ [opus46]: 128_000 });
  } finally {
    renderer.destroy();
  }
});

it('offers the model limit as a stop when it is not a preset', async () => {
  const { renderer, slider, readouts } = await setup({ provider: 'mistral', model: 'magistral-medium-latest' });
  try {
    expect(slider().getAttribute('max')).toBe('1');
    expect(readouts()).toEqual(['40K']);
    release(slider(), 0);
    expect(readouts()).toEqual(['32K']);
  } finally {
    renderer.destroy();
  }
});

it('disables the slider when the model has a single stop', async () => {
  const { renderer, slider, readouts } = await setup({ provider: 'lmstudio', model: 'tiny-local' });
  try {
    expect(slider().disabled).toBe(true);
    expect(readouts()).toEqual(['4K']);
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
