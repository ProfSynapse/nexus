/**
 * File conversion fold on Defaults.
 *
 * Failures this buys (all were live): the PDF mode and OCR rows rendered above
 * the switch that gates them; "Auto-convert" stayed visible while the switch was
 * off; and the copy pointed at "the defaults below". The switch is labelled
 * "File import" because `enableIngestion` gates audio as well as PDFs. Rows
 * are observed through the FakeElement tree, inside the real renderer, so the
 * section also has to survive renderer redraws.
 */
jest.mock('../../src/services/llm/providers/ProviderManager', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').providerManagerModule());
jest.mock('../../src/services/StaticModelsService', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').staticModelsModule());
jest.mock('../../src/services/llm/ImageGenerationService', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').imageServiceModule());
jest.mock('../../src/agents/ingestManager/tools/services/IngestCapabilityService', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').ingestCapabilityModule());

import { createFakeRoot } from '../mocks/obsidian/dom';
import { DefaultsTab } from '../../src/settings/tabs/DefaultsTab';
import { FILE_CONVERSION_COPY as COPY, FOLD_TITLES } from '../../src/components/shared/chatSettings/copy';
import { LLMSettingsNotifier } from '../../src/services/llm/LLMSettingsNotifier';
import { llmSettings } from '../helpers/settingsRendererFixtures';
import { choose, control, findRow, flush, foldItems, foldSummary, localStorageApp, rowDesc, rowNames } from '../helpers/settingsDom';

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flush();
}

async function render(plugin: { enableIngestion?: boolean; autoIngestion?: boolean }, pdfMode: 'text' | 'vision' = 'text') {
  const container = createFakeRoot();
  const saveSettings = jest.fn(async () => undefined);
  const pluginSettings = { enableEmbeddings: true, ...plugin } as Record<string, unknown>;
  const llm = llmSettings({ defaultPdfMode: pdfMode });
  const tab = new DefaultsTab(container as unknown as HTMLElement, {
    app: localStorageApp() as never,
    settings: { settings: pluginSettings, saveSettings } as never,
    llmProviderSettings: llm
  });
  await settle();
  const root = container.children[0];
  const items = () => foldItems(root, FOLD_TITLES.fileConversion);
  return { tab, root, items, pluginSettings, llm, saveSettings };
}

it('puts the File import switch first, then the method and auto-convert', async () => {
  const { tab, items } = await render({ enableIngestion: true });
  try {
    expect(rowNames(items())).toEqual([COPY.fileImport, COPY.readingMethod, COPY.autoConvert]);
    expect(rowDesc(findRow(items(), COPY.fileImport))).toBe(COPY.fileImportDesc);
    expect(rowDesc(findRow(items(), COPY.readingMethod))).toBe(COPY.readingMethodDesc);
    expect(rowDesc(findRow(items(), COPY.autoConvert))).toBe(COPY.autoConvertDesc);
    expect(items().textContent).not.toContain('defaults below');
  } finally {
    tab.destroy();
  }
});

it('shows only the switch while File import is off, and the rest once it is turned on', async () => {
  const { tab, root, items, pluginSettings, saveSettings } = await render({ enableIngestion: false });
  try {
    expect(rowNames(items())).toEqual([COPY.fileImport]);
    expect(foldSummary(root, FOLD_TITLES.fileConversion)).toBe('File import off');

    control(findRow(items(), COPY.fileImport), '.checkbox-container').click();
    await settle();
    expect(pluginSettings.enableIngestion).toBe(true);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(rowNames(items())).toEqual([COPY.fileImport, COPY.readingMethod, COPY.autoConvert]);
    expect(foldSummary(root, FOLD_TITLES.fileConversion)).toBe('File import on · Text extraction');
  } finally {
    tab.destroy();
  }
});

it('adds the vision provider and model only for the Vision method', async () => {
  const { tab, root, items, llm } = await render({ enableIngestion: true, autoIngestion: true });
  try {
    choose(control(findRow(items(), COPY.readingMethod), 'select'), 'vision');
    await settle();
    expect(llm.defaultPdfMode).toBe('vision');
    expect(rowNames(items())).toEqual([COPY.fileImport, COPY.readingMethod, COPY.visionProvider, COPY.visionModel, COPY.autoConvert]);
    expect(foldSummary(root, FOLD_TITLES.fileConversion)).toBe('File import on · Vision · auto-convert');

    choose(control(findRow(items(), COPY.readingMethod), 'select'), 'text');
    await settle();
    expect(rowNames(items())).toEqual([COPY.fileImport, COPY.readingMethod, COPY.autoConvert]);
  } finally {
    tab.destroy();
  }
});

it('saves the vision model through the Defaults save queue', async () => {
  const { tab, items, llm, saveSettings } = await render({ enableIngestion: true }, 'vision');
  try {
    expect(rowNames(items())).toContain(COPY.visionModel);
    choose(control(findRow(items(), COPY.visionModel), 'select'), 'gemini-3-flash');
    await settle();
    expect(llm.defaultOcrModel).toEqual({ provider: 'google', model: 'gemini-3-flash' });
    expect(saveSettings).toHaveBeenCalled();
  } finally {
    tab.destroy();
  }
});

it('keeps its rows, once each, after the renderer redraws', async () => {
  const { tab, items } = await render({ enableIngestion: true });
  try {
    LLMSettingsNotifier.notify(llmSettings());
    LLMSettingsNotifier.notify(llmSettings());
    await settle();
    expect(rowNames(items())).toEqual([COPY.fileImport, COPY.readingMethod, COPY.autoConvert]);
  } finally {
    tab.destroy();
  }
});
