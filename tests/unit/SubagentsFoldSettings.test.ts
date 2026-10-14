/**
 * The Subagents fold edits the settings subagent runs read: Provider, Model,
 * Thinking, Creativity and Context window, persisted by Defaults under
 * `agentModel`, `agentThinking`, `agentTemperature` and
 * `agentContextWindowOverrides`.
 *
 * Failures this buys: subagent Creativity writing the chat temperature (or the
 * reverse), the subagent and chat Context window sliders sharing one map so
 * one overwrites the other for the same model, a new subagent model keeping a
 * stale limit, rows describing a different model than the one subagents run
 * on when no subagent model is set (they use the cloud chat model), a summary
 * that ignores the subagent tuning, and Defaults dropping the new keys on
 * save. Real DefaultsTab, renderer and save path; model lists from fixtures.
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
import { DefaultsTab } from '../../src/settings/tabs/DefaultsTab';
import { COPY, FOLD_TITLES } from '../../src/components/shared/chatSettings/copy';
import { getContextWindowOverrideKey } from '../../src/ui/chat/utils/ContextWindowSettings';
import type { LLMProviderSettings } from '../../src/types/llm/ProviderTypes';
import { llmSettings } from '../helpers/settingsRendererFixtures';
import {
  choose,
  control,
  findRow,
  flush,
  foldItems,
  foldSummary,
  localStorageApp,
  optionLabels,
  rowDesc,
  rowNames
} from '../helpers/settingsDom';

const opus46 = getContextWindowOverrideKey('anthropic', 'claude-opus-4-6');
const haiku55 = getContextWindowOverrideKey('anthropic', 'claude-haiku-5-5');

async function renderDefaults(overrides: Partial<LLMProviderSettings> = {}) {
  const container = createFakeRoot();
  const saveSettings = jest.fn(async () => undefined);
  const settings = llmSettings({ defaultTemperature: 0.5, ...overrides });
  const tab = new DefaultsTab(container as unknown as HTMLElement, {
    app: localStorageApp() as never,
    settings: { settings: { enableIngestion: true, enableEmbeddings: true, storage: undefined }, saveSettings } as never,
    llmProviderSettings: settings
  });
  await flush();
  await flush();
  const root = container.children[0];
  const items = () => foldItems(root, FOLD_TITLES.subagents);
  const row = (name: string) => findRow(items(), name);
  // Let the queued save run.
  const settle = async () => { await flush(); await flush(); };
  return { tab, root, settings, saveSettings, items, row, settle };
}

function release(input: FakeElement, value: number): void {
  input.value = String(value);
  input.dispatch('input');
  input.dispatch('change');
}

it('saves subagent Creativity apart from the chat temperature', async () => {
  const h = await renderDefaults({ agentModel: { provider: 'anthropic', model: 'claude-opus-4-6' } });
  try {
    // No subagent value yet: it follows the chat default.
    expect(h.row(COPY.creativity).querySelectorAll('.slider-value').map(el => el.textContent)).toEqual(['0.5']);

    release(control(h.row(COPY.creativity), 'input.slider'), 0.3);
    await h.settle();
    expect(h.settings.agentTemperature).toBe(0.3);
    expect(h.settings.defaultTemperature).toBe(0.5);
    expect(foldSummary(h.root, FOLD_TITLES.subagents)).toBe('Claude Opus 4.6 · Thinking off · Creativity 0.3 · 200K context');
  } finally {
    h.tab.destroy();
  }
});

it('saves the subagent Context window in its own map', async () => {
  const h = await renderDefaults({
    agentModel: { provider: 'anthropic', model: 'claude-opus-4-6' },
    defaultModel: { provider: 'anthropic', model: 'claude-opus-4-6' },
    contextWindowOverrides: { [opus46]: 128_000 }
  });
  try {
    const slider = control(h.row(COPY.contextWindow), 'input.slider');
    // The subagent slider does not show the chat limit for the same model.
    expect(h.row(COPY.contextWindow).querySelectorAll('.slider-value').map(el => el.textContent)).toEqual(['200K']);

    release(slider, 1);
    await h.settle();
    expect(h.settings.agentContextWindowOverrides).toEqual({ [opus46]: 64_000 });
    expect(h.settings.contextWindowOverrides).toEqual({ [opus46]: 128_000 });
    expect(foldSummary(h.root, FOLD_TITLES.subagents)).toBe('Claude Opus 4.6 · Thinking off · Creativity 0.5 · 64K context');
  } finally {
    h.tab.destroy();
  }
});

it('shows a newly picked subagent model at its saved limit, and never deletes one', async () => {
  const h = await renderDefaults({
    agentModel: { provider: 'anthropic', model: 'claude-opus-4-6' },
    agentContextWindowOverrides: { [opus46]: 64_000, [haiku55]: 350_000 }
  });
  try {
    choose(control(h.row(COPY.model), 'select'), 'anthropic::claude-haiku-5-5');
    await h.settle();
    expect(h.row(COPY.contextWindow).querySelectorAll('.slider-value').map(el => el.textContent)).toEqual(['350K']);
    expect(h.settings.agentModel).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(h.settings.agentContextWindowOverrides).toEqual({ [opus46]: 64_000, [haiku55]: 350_000 });
  } finally {
    h.tab.destroy();
  }
});

it('starts a newly picked subagent model with no saved limit at its maximum', async () => {
  const h = await renderDefaults({
    agentModel: { provider: 'anthropic', model: 'claude-opus-4-6' },
    agentContextWindowOverrides: { [opus46]: 64_000 }
  });
  try {
    choose(control(h.row(COPY.model), 'select'), 'anthropic::claude-haiku-5-5');
    await h.settle();
    expect(h.row(COPY.contextWindow).querySelectorAll('.slider-value').map(el => el.textContent)).toEqual(['1M']);
    expect(h.settings.agentContextWindowOverrides).toEqual({ [opus46]: 64_000 });
  } finally {
    h.tab.destroy();
  }
});

it('offers only the Thinking levels the subagent model distinguishes', async () => {
  const h = await renderDefaults({
    agentModel: { provider: 'anthropic', model: 'claude-opus-4-6' },
    agentThinking: { enabled: true, effort: 'xhigh' }
  });
  try {
    const select = control(h.row(COPY.thinking), 'select');
    expect(optionLabels(select)).toEqual(['Off', 'Low', 'Medium', 'High', 'Max']);
    // Extra high is sent as High for this model; the dropdown says so.
    expect(select.value).toBe('high');
    expect(foldSummary(h.root, FOLD_TITLES.subagents)).toMatch(/^Claude Opus 4\.6 · High thinking · /);
  } finally {
    h.tab.destroy();
  }
});

it('hides subagent Thinking for a model that cannot reason', async () => {
  const h = await renderDefaults({ agentModel: { provider: 'mistral', model: 'mistral-large-latest' } });
  try {
    expect(rowNames(h.items())).toEqual([COPY.usedFor, COPY.provider, COPY.model, COPY.creativity, COPY.contextWindow]);
    expect(foldSummary(h.root, FOLD_TITLES.subagents)).toBe('Mistral Large Latest · Creativity 0.5 · 128K context');
  } finally {
    h.tab.destroy();
  }
});

it('describes the chat model when no subagent model is set, since subagents run on it', async () => {
  const h = await renderDefaults({ defaultModel: { provider: 'anthropic', model: 'claude-opus-4-6' } });
  try {
    expect(rowDesc(h.row(COPY.usedFor))).toBe(COPY.usedForDesc);
    expect(rowNames(h.items())).toEqual([
      COPY.usedFor, COPY.provider, COPY.model, COPY.thinking, COPY.creativity, COPY.contextWindow
    ]);
    expect(foldSummary(h.root, FOLD_TITLES.subagents)).toBe('Claude Opus 4.6 · Thinking off · Creativity 0.5 · 200K context');

    release(control(h.row(COPY.contextWindow), 'input.slider'), 2);
    await h.settle();
    expect(h.settings.agentContextWindowOverrides).toEqual({ [opus46]: 128_000 });
    expect(h.settings.agentModel).toBeUndefined();
  } finally {
    h.tab.destroy();
  }
});
