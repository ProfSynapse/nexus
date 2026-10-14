/**
 * Creativity follows the selected model's registry flag.
 *
 * Failures this buys: StaticModelsService dropping `supportsSamplingParams`
 * (so the renderer cannot tell), a Creativity slider the user can move for a
 * model that ignores temperature, a model missing from the registry being
 * treated as fixed, and the stored value being overwritten when a fixed model
 * is shown. The capability comes from the REAL model registry and
 * StaticModelsService; only provider model lists and image models are mocked.
 */
jest.mock('../../src/services/llm/providers/ProviderManager', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').providerManagerModule());
jest.mock('../../src/services/llm/ImageGenerationService', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').imageServiceModule());

import { createFakeRoot } from '../mocks/obsidian/dom';
import { ChatSettingsRenderer, type ChatSettings } from '../../src/components/shared/ChatSettingsRenderer';
import { FoldStateStore } from '../../src/components/shared/settings/FoldStateStore';
import { COPY, FOLD_TITLES } from '../../src/components/shared/chatSettings/copy';
import { StaticModelsService } from '../../src/services/StaticModelsService';
import { chatSettings, llmSettings } from '../helpers/settingsRendererFixtures';
import { control, findRow, flush, foldItems, foldSummary, localStorageApp, rowDesc } from '../helpers/settingsDom';

async function render(overrides: Partial<ChatSettings>) {
  const container = createFakeRoot();
  const app = localStorageApp();
  const onSettingsChange = jest.fn();
  const renderer = new ChatSettingsRenderer(container as unknown as HTMLElement, {
    app: app as never,
    surface: 'defaults',
    foldStore: new FoldStateStore(app),
    llmProviderSettings: llmSettings(),
    initialSettings: chatSettings({ temperature: 0.3, ...overrides }),
    options: { workspaces: [], prompts: [] },
    callbacks: { onSettingsChange }
  });
  renderer.render();
  await flush();
  const creativity = (fold: string = FOLD_TITLES.chatOptions) => findRow(foldItems(container, fold), COPY.creativity);
  return { container, renderer, creativity, onSettingsChange };
}

it('maps the registry flag onto StaticModelsService models', () => {
  const service = StaticModelsService.getInstance();
  expect(service.findModel('anthropic', 'claude-opus-5-5')?.supportsSamplingParams).toBe(false);
  expect(service.findModel('anthropic', 'claude-opus-4-6')?.supportsSamplingParams).not.toBe(false);
});

it('disables Creativity for Claude Opus 5.5 and says the model sets its own temperature', async () => {
  const { container, renderer, creativity, onSettingsChange } = await render({ model: 'claude-opus-5-5' });
  try {
    const row = creativity();
    expect(row.hasClass('is-disabled')).toBe(true);
    expect(rowDesc(row)).toBe('Claude Opus 5.5 sets its own temperature.');
    expect(rowDesc(row)).toBe(COPY.creativityFixedDesc('Claude Opus 5.5'));
    expect(control(row, 'input.slider').disabled).toBe(true);
    expect(row.querySelectorAll('.slider-value').map(el => el.textContent)).toEqual(['—']);
    expect(foldSummary(container, FOLD_TITLES.chatOptions)).toMatch(/^Fixed temperature · /);
    // Showing a fixed model leaves the stored value for the next model.
    expect(renderer.getSettings().temperature).toBe(0.3);
    expect(onSettingsChange).not.toHaveBeenCalled();
  } finally {
    renderer.destroy();
  }
});

it('keeps Creativity enabled for Claude Opus 4.6', async () => {
  const { container, renderer, creativity } = await render({ model: 'claude-opus-4-6' });
  try {
    const row = creativity();
    expect(row.hasClass('is-disabled')).toBe(false);
    expect(rowDesc(row)).toBe(COPY.creativityDesc);
    expect(control(row, 'input.slider').disabled).toBe(false);
    expect(row.querySelectorAll('.slider-value').map(el => el.textContent)).toEqual(['0.3']);
    expect(foldSummary(container, FOLD_TITLES.chatOptions)).toMatch(/^Creativity 0\.3/);
  } finally {
    renderer.destroy();
  }
});

it('keeps Creativity enabled for a model the registry does not know', async () => {
  const { renderer, creativity } = await render({ model: 'claude-not-in-the-registry' });
  try {
    expect(creativity().hasClass('is-disabled')).toBe(false);
    expect(control(creativity(), 'input.slider').disabled).toBe(false);
  } finally {
    renderer.destroy();
  }
});

it('applies the same rule to the subagent model', async () => {
  const { container, renderer, creativity } = await render({
    model: 'claude-opus-4-6',
    agentProvider: 'anthropic',
    agentModel: 'claude-haiku-5-5'
  });
  try {
    const row = creativity(FOLD_TITLES.subagents);
    expect(row.hasClass('is-disabled')).toBe(true);
    expect(rowDesc(row)).toBe('Claude Haiku 5.5 sets its own temperature.');
    expect(foldSummary(container, FOLD_TITLES.subagents)).toBe('Claude Haiku 5.5 · Thinking off · Fixed temperature · 1M context');
    // The chat model still accepts temperature.
    expect(creativity().hasClass('is-disabled')).toBe(false);
  } finally {
    renderer.destroy();
  }
});
